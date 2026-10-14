import { ApolloClient, InMemoryCache } from '@apollo/client'
import { LocalState } from '@apollo/client/local-state'
import { SchemaLink } from '@apollo/client/link/schema'
import { makeExecutableSchema } from '@graphql-tools/schema'
import resolvers from './resolvers'
import typeDefs from './typeDefs'
import models from './models'
import { print } from 'graphql'
import search from './search'
import { ME } from '@/fragments/users'
import { PRICE } from '@/fragments/price'
import { BLOCK_HEIGHT } from '@/fragments/blockHeight'
import { getServerSession } from 'next-auth/next'
import { getAuthOptions } from '@/pages/api/auth/[...nextauth]'
import { NOFOLLOW_LIMIT } from '@/lib/constants'
import { MULTI_AUTH_ANON, MULTI_AUTH_LIST, MULTI_AUTH_POINTER, multiAuthMiddleware } from '@/lib/auth'
import { lexicalStateLoader } from '@/lib/lexical/server/loader'
import { createMoneroWallLoader, createRootItemLoader } from '@/lib/monero-wall/loader'
import { createMoneroWallRatingLoader } from '@/lib/monero-wall/rating-loader'
import { createUserLoader, createSubLoader } from '@/api/loaders'
import { getDomainBranding, SN_MAIN_DOMAIN } from '@/lib/domains'
import { lwsClient } from './monero/lwsClient'
import { logWarn, logError } from '@/lib/logger'

// The schema is static (typeDefs + resolvers are module constants) — build it
// once per process instead of once per SSR request.
const executableSchema = makeExecutableSchema({ typeDefs, resolvers })

export default async function getSSRApolloClient ({ req, res, me = null }) {
  // switch session cookie before getting session on SSR
  if (req) {
    req = await multiAuthMiddleware(req, res)
  }
  const session = req && await getServerSession(req, res, getAuthOptions(req))
  const client = new ApolloClient({
    ssrMode: true,
    link: new SchemaLink({
      schema: executableSchema,
      context: (() => {
        const viewer = session
          ? session.user
          : me
        const userLoader = createUserLoader(models)
        const subLoader = createSubLoader(models)
        const moneroWallLoader = createMoneroWallLoader({ models, me: viewer })
        return {
          models,
          me: viewer,
          search,
          userLoader,
          subLoader,
          monero: lwsClient,
          lexicalStateLoader: lexicalStateLoader({ me: viewer, userLoader }),
          moneroWallLoader,
          rootItemLoader: createRootItemLoader({ models }),
          moneroWallRatingLoader: createMoneroWallRatingLoader({ models, me: viewer, moneroWallLoader })
        }
      })()
    }),
    cache: new InMemoryCache({
      freezeResults: true
    }),
    assumeImmutableResults: true,
    defaultOptions: {
      watchQuery: {
        fetchPolicy: 'no-cache',
        nextFetchPolicy: 'no-cache',
        ssr: true
      },
      query: {
        fetchPolicy: 'no-cache',
        nextFetchPolicy: 'no-cache',
        ssr: true
      }
    },
    // @client directive support
    localState: new LocalState({})
  })

  await client.clearStore()
  return client
}

function oneDayReferral (request, { me }) {
  if (!me) return
  const refHeader = request.headers['x-stacker-news-referrer']
  if (!refHeader) return

  const referrers = refHeader.split('; ').filter(Boolean)
  for (const referrer of referrers) {
    let prismaPromise, getData

    if (referrer.startsWith('item-')) {
      prismaPromise = models.item.findUnique({
        where: {
          id: parseInt(referrer.slice(5)),
          piconeros: {
            // NOFOLLOW_LIMIT is denominated in the fork's legacy sats (1 sats == 1000 piconeros)
            gt: BigInt(NOFOLLOW_LIMIT) * 1000n
          },
          weightedVotes: {
            gt: 0
          }
        }
      })
      getData = item => ({
        referrerId: item.userId,
        refereeId: parseInt(me.id),
        type: item.parentId ? 'COMMENT' : 'POST',
        typeId: String(item.id)
      })
    } else if (referrer.startsWith('profile-')) {
      const name = referrer.slice(8)
      // exclude all pages that are not user profiles
      if (['api', 'auth', 'day', 'invites', 'invoices', 'referrals', 'rewards',
        'statistics', 'settings', 'stashers', 'wallet', 'withdrawals', '404', '500',
        'email', 'live', 'login', 'notifications', 'offline', 'search', 'share',
        'signup', 'territory', 'new', 'top', 'edit', 'post', 'rss', 'saloon',
        'faq', 'story', 'privacy', 'copyright', 'tos', 'changes', 'guide', 'daily',
        'anon', 'ad'].includes(name)) continue

      prismaPromise = models.user.findUnique({ where: { name } })
      getData = user => ({
        referrerId: user.id,
        refereeId: parseInt(me.id),
        type: 'PROFILE',
        typeId: String(user.id)
      })
    } else if (referrer.startsWith('territory-')) {
      prismaPromise = models.sub.findUnique({ where: { name: referrer.slice(10) } })
      getData = sub => ({
        referrerId: sub.userId,
        refereeId: parseInt(me.id),
        type: 'TERRITORY',
        typeId: sub.name
      })
    } else {
      prismaPromise = models.user.findUnique({ where: { name: referrer } })
      getData = user => ({
        referrerId: user.id,
        refereeId: parseInt(me.id),
        type: 'REFERRAL',
        typeId: String(user.id)
      })
    }

    prismaPromise?.then(ref => {
      if (ref && getData) {
        const data = getData(ref)
        // can't refer yourself
        if (data.refereeId === data.referrerId) return
        models.oneDayReferral.create({ data }).catch(console.error)
      }
    }).catch(console.error)
  }
}

/**
 * Takes a query and variables and returns a getServerSideProps function
 *
 * @param opts Options
 * @param opts.query graphql query or function that return graphql query
 * @param opts.variables graphql variables or function that return graphql variables
 * @param opts.notFound function that tests data to determine if 404
 * @param opts.authRequired boolean that determines if auth is required
 */
export function getGetServerSideProps (
  { query: queryOrFunc, variables: varsOrFunc, notFound, authRequired }) {
  return async function ({ req, res, query: params }) {
    const { nodata, ...realParams } = params
    // we want to use client-side cache
    if (nodata) return { props: { } }

    const variables = typeof varsOrFunc === 'function' ? varsOrFunc(realParams) : varsOrFunc
    const vars = { ...realParams, ...variables }
    const query = typeof queryOrFunc === 'function' ? queryOrFunc(vars) : queryOrFunc

    const client = await getSSRApolloClient({ req, res })

    // independent lookups fire immediately and run concurrently; each gets a
    // no-op catch so a rejection between creation and its await below can never
    // become an unhandledRejection (which would kill the server process)
    const brandingPromise = req.headers.host ? getDomainBranding(req.headers.host) : Promise.resolve(null)
    brandingPromise.catch(() => {})
    const blockHeightPromise = client.query({ query: BLOCK_HEIGHT, variables: {} })
    blockHeightPromise.catch(() => {})

    let { data: { me } } = await client.query({ query: ME })

    // required to redirect to /signup on page reload
    // if we switched to anon and authentication is required
    if (req.cookies[MULTI_AUTH_POINTER] === MULTI_AUTH_ANON) {
      me = null
    }

    if (authRequired && !me) {
      // if we're on a custom domain, use the domain header instead of the main domain
      const branding = await brandingPromise
      const origin = branding ? `${SN_MAIN_DOMAIN.protocol}//${req.headers['x-stacker-news-domain']}` : process.env.NEXT_PUBLIC_URL
      let callback = origin + req.url
      // On client-side routing, the callback is a NextJS URL
      // so we need to remove the NextJS stuff.
      // Example: /_next/data/development/territory.json
      callback = callback.replace(/\/_next\/data\/\w+\//, '/').replace(/\.json$/, '')
      return {
        redirect: {
          destination: `/signup?callbackUrl=${encodeURIComponent(callback)}`
        }
      }
    }

    // PRICE needs ME only for the currency pref; the page query needs ME for
    // the notFound predicate — but they are independent of each other, so both
    // fire now instead of serializing after BLOCK_HEIGHT
    const pricePromise = client.query({
      query: PRICE, variables: { fiatCurrency: me?.privates?.fiatCurrency }
    })
    pricePromise.catch(() => {})
    const pagePromise = query ? client.query({ query, variables: vars }) : null
    if (pagePromise) pagePromise.catch(() => {})

    let error = null; let data = null; let props = {}
    if (pagePromise) {
      try {
        ({ error, data } = await pagePromise)
      } catch (e) {
        error = e
      }

      if (error) {
        // backend/transient error: the page EXISTS — degrade to null data instead of
        // lying with a 404. Verified null-safe: pages/~/index.js:21 (serves / via the
        // next.config.js:192 rewrite and /~:sub) and pages/items/[id]/index.js:20 render
        // <PageLoading /> when ssrData is null, then the client-side query hydrates them.
        logError({ route: req.url, error: error?.message }, 'SSR query failed')
        data = null
      } else if (!data || (notFound && notFound(data, vars, me))) {
        // genuinely not found (or caller-defined notFound): keep the 404 redirect
        if (!data) logWarn({ route: req.url }, 'SSR query returned no data')
        res.writeHead(302, {
          Location: '/404'
        }).end()
        return
      }

      props = {
        apollo: {
          query: print(query),
          variables: vars
        }
      }
    }

    const branding = await brandingPromise
    const { data: { price } } = await pricePromise
    const { data: { blockHeight } } = await blockHeightPromise

    oneDayReferral(req, { me })

    return {
      props: {
        ...props,
        branding,
        me,
        price,
        blockHeight,
        ssrData: data,
        // only non-httpOnly cookies should be passed here
        // passing httpOnly cookies would expose them to client JavaScript
        ssrPublicCookies: {
          [MULTI_AUTH_POINTER]: req.cookies[MULTI_AUTH_POINTER] || null,
          [MULTI_AUTH_LIST]: req.cookies[MULTI_AUTH_LIST] || null
        }
      }
    }
  }
}
