import { ApolloServer } from '@apollo/server'
import { startServerAndCreateNextHandler } from '@as-integrations/next'
import resolvers from '@/api/resolvers'
import models from '@/api/models'
import typeDefs from '@/api/typeDefs'
import { getServerSession } from 'next-auth/next'
import { getAuthOptions } from './auth/[...nextauth]'
import search from '@/api/search'
import { multiAuthMiddleware } from '@/lib/auth'
import { depthLimit } from '@graphile/depth-limit'
import { COMMENT_DEPTH_LIMIT } from '@/lib/constants'
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled'
import { logWarn, logError } from '@/lib/logger'
import { formatGraphqlError } from '@/lib/formatGraphqlError'
import { apiKeyGuardPlugin } from '@/lib/apiKeyGuard'
import { lexicalStateLoader } from '@/lib/lexical/server/loader'
import { createMoneroWallLoader, createRootItemLoader } from '@/lib/monero-wall/loader'
import { createMoneroWallRatingLoader } from '@/lib/monero-wall/rating-loader'
import { createUserLoader, createSubLoader } from '@/api/loaders'
import { lwsClient } from '@/api/monero/lwsClient'
import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/client-ip'

const apolloServer = new ApolloServer({
  typeDefs,
  resolvers,
  introspection: process.env.GRAPHQL_INTROSPECTION === 'true' ||
    (process.env.NODE_ENV !== 'production' && process.env.GRAPHQL_INTROSPECTION !== 'false'),
  validationRules: [depthLimit({
    revealDetails: true,
    maxListDepth: COMMENT_DEPTH_LIMIT,
    maxDepth: 20,
    maxIntrospectionDepth: 20,
    maxDepthByFieldCoordinates: {
      '__Type.ofType': 20,
      'Item.comments': COMMENT_DEPTH_LIMIT,
      'Comments.comments': COMMENT_DEPTH_LIMIT
    }
  })],
  formatError: formatGraphqlError,
  plugins: [{
    requestDidStart (initialRequestContext) {
      return {
        executionDidStart () {
          return {
            willResolveField ({ source, args, context, info }) {
              const start = process.hrtime.bigint()
              return (error, result) => {
                const end = process.hrtime.bigint()
                const ms = Number((end - start) / 1000000n)
                const fields = { path: `${info.parentType.name}.${info.fieldName}`, ms }
                if (process.env.GRAPHQL_SLOW_LOGS_MS && ms > process.env.GRAPHQL_SLOW_LOGS_MS) {
                  logWarn(fields, 'slow GraphQL field')
                }
                if (error) {
                  logWarn({ ...fields, error: error.message }, 'GraphQL field error')
                }
              }
            },
            async executionDidEnd (err) {
              if (err) {
                logError({ error: err.message }, 'GraphQL execution error')
              }
            }
          }
        }
      }
    }
  }, apiKeyGuardPlugin(), ApolloServerPluginLandingPageDisabled()]
})

const apolloHandler = startServerAndCreateNextHandler(apolloServer, {
  context: async (req, res) => {
    const apiKey = req.headers['x-api-key']
    let session
    if (apiKey) {
      const [user] = await models.$queryRaw`
      SELECT id, name, "apiKeyEnabled"
      FROM users
      WHERE "apiKeyHash" = encode(digest(${apiKey}, 'sha256'), 'hex')
      LIMIT 1`
      if (user?.apiKeyEnabled) {
        const { apiKeyEnabled, ...sessionFields } = user
        session = { user: { ...sessionFields, apiKey: true } }
      }
    } else {
      req = await multiAuthMiddleware(req, res)
      session = await getServerSession(req, res, getAuthOptions(req))
    }
    const me = session
      ? session.user
      : null
    const userLoader = createUserLoader(models)
    const subLoader = createSubLoader(models)
    const moneroWallLoader = createMoneroWallLoader({ models, me })
    return {
      models,
      headers: req.headers,
      me,
      search,
      userLoader,
      subLoader,
      monero: lwsClient,
      lexicalStateLoader: lexicalStateLoader({ me, userLoader }),
      moneroWallLoader,
      rootItemLoader: createRootItemLoader({ models }),
      moneroWallRatingLoader: createMoneroWallRatingLoader({ models, me, moneroWallLoader })
    }
  }
})

// Reject GET requests with non-standard Content-Type headers (e.g. message/*)
// to prevent cross-site timing attacks that bypass CORS preflight checks.
export default function protectedContentTypeHandler (req, res) {
  // Check raw headers so duplicate Content-Type headers can't hide an invalid value.
  const invalidGetContentType = req.method === 'GET' &&
    req.rawHeaders.some((name, i, headers) =>
      i % 2 === 0 &&
      name.toLowerCase() === 'content-type' &&
      headers[i + 1]
        .split(',')
        .some(value => value.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
    )

  if (invalidGetContentType) {
    return res.status(400).json({ error: 'Invalid Content-Type' })
  }

  const burst = Number(process.env.GRAPHQL_RATE_LIMIT ?? 300)
  const rl = rateLimit({ key: `gql:${clientIp(req.headers, req.socket?.remoteAddress)}`, limit: burst, windowMs: 10_000 })
  if (!rl.allowed) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000))
    return res.status(429).json({ error: 'Too many requests' })
  }

  return apolloHandler(req, res)
}
