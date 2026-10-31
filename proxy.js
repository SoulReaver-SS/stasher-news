import 'urlpattern-polyfill'
import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { cookieOptions } from '@/lib/auth'
import {
  deriveChallenge,
  DOMAINS_AUTH_VERIFIER_COOKIE,
  DOMAINS_AUTH_VERIFIER_BYTES,
  DOMAINS_AUTH_VERIFIER_TTL_S
} from '@/lib/domains/auth'
import { getDomainMapping, createDomainsDebugLogger } from '@/lib/domains'
import { onionLocationFor } from '@/lib/onion'
import { GATE_COOKIE, shouldGateRequest } from '@/lib/invite-gate'

const REFERRER_TTL_S = 60 * 60 * 24

const referrerPattern = new URLPattern({ pathname: ':pathname(*)/r/:referrer([\\w_]+)' })
const itemPattern = new URLPattern({ pathname: '/items/:id(\\d+){/:other(\\w+)}?' })
const profilePattern = new URLPattern({ pathname: '/:name([\\w_]+){/:type(\\w+)}?' })
const territoryPattern = new URLPattern({ pathname: '/~:name([\\w_]+){/*}?' })

// key for /r/... link referrers
const ST_REFERRER = 'st_referrer'
// we use this to hold /r/... referrers through the redirect
const ST_REFERRER_NONCE = 'st_referrer_nonce'
// key for referred pages
const ST_REFEREE_LANDING = 'st_referee_landing'
// territory paths that needs to be rewritten to ~subname
const ST_TERRITORY_PATHS = ['/new', '/top', '/post', '/edit', '/rss']

function isTerritoryPath (pathname) {
  return ST_TERRITORY_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))
}

function isPrefetchRequest (request) {
  return request.headers.has('next-router-prefetch') || request.headers.get('purpose') === 'prefetch'
}

async function customDomainMiddleware (request, domain, subName) {
  // logger is enabled if NEXT_PUBLIC_CUSTOM_DOMAINS_DEBUG == 1
  const logger = createDomainsDebugLogger(domain)
  // clone the url to build on top of it
  const url = request.nextUrl.clone()
  // we need pathname, searchParams and origin
  const { pathname, searchParams } = url
  // set the subname and domain in the request headers
  const reqHeaders = new Headers(request.headers)
  reqHeaders.set('x-stacker-news-subname', subName)
  reqHeaders.set('x-stacker-news-domain', domain)

  // log the original request path
  const from = `${pathname}${url.search}`

  // Auth Sync
  if (pathname === '/login' || pathname === '/signup') {
    const signup = pathname.startsWith('/signup')
    return redirectToAuth(request, searchParams, domain, signup)
  }

  // clean up the pathname from any subname
  if (pathname.startsWith('/~')) {
    url.pathname = pathname.replace(/^\/~[^/]+/, '') || '/'
    logger.log(`${from} -> redirect ${url.pathname}${url.search} (strip subname)`)
    return NextResponse.redirect(url)
  }

  // if sub param exists and doesn't match the domain's subname, update it
  if (searchParams.has('sub') && searchParams.get('sub') !== subName) {
    searchParams.set('sub', subName)
    url.search = searchParams.toString()
    logger.log(`${from} -> redirect ${url.pathname}${url.search} (fix sub=${subName})`)
    return NextResponse.redirect(url)
  }

  // if we're at the root or on some territory path, hide the subname by rewriting
  if (pathname === '/' || isTerritoryPath(pathname)) {
    url.pathname = `/~${subName}${pathname === '/' ? '' : pathname}`
    logger.log(`${from} -> rewrite ${url.pathname}`)
    return NextResponse.rewrite(url, { request: { headers: reqHeaders } })
  }

  logger.log(`${from} -> pass-through`)
  return NextResponse.next({ request: { headers: reqHeaders } })
}

async function redirectToAuth (request, searchParams, domain, signup) {
  // mint verifier as httponly cookie
  const verifier = randomBytes(DOMAINS_AUTH_VERIFIER_BYTES).toString('hex')
  const hashedVerifier = deriveChallenge(verifier)

  // /api/auth/domains/begin is a workaround to handle localhost redirects.
  const redirectUrl = new URL('/api/auth/domains/begin', request.url)
  redirectUrl.searchParams.set('domain', domain)
  redirectUrl.searchParams.set('challenge', hashedVerifier)
  if (signup) redirectUrl.searchParams.set('signup', '1')
  if (searchParams.has('callbackUrl')) {
    redirectUrl.searchParams.set('callbackUrl', searchParams.get('callbackUrl'))
  }
  // forward the "add account" intent so the main /login renders the multi-auth UI
  // instead of short-circuiting to callbackUrl when the user already has a session.
  // never paired with signup, which always creates a fresh user.
  if (!signup && searchParams.get('multiAuth') === 'true') {
    redirectUrl.searchParams.set('multiAuth', 'true')
  }

  const response = NextResponse.redirect(redirectUrl)
  response.cookies.set(
    DOMAINS_AUTH_VERIFIER_COOKIE,
    verifier,
    cookieOptions({ req: request, maxAge: DOMAINS_AUTH_VERIFIER_TTL_S })
  )
  return response
}

function getContentReferrer (request, url) {
  if (itemPattern.test(url)) {
    let id = request.nextUrl.searchParams.get('commentId')
    if (!id) {
      ({ id } = itemPattern.exec(url).pathname.groups)
    }
    return `item-${id}`
  }
  if (profilePattern.test(url)) {
    const { name } = profilePattern.exec(url).pathname.groups
    return `profile-${name}`
  }
  if (territoryPattern.test(url)) {
    const { name } = territoryPattern.exec(url).pathname.groups
    return `territory-${name}`
  }
}

// we store the referrers in cookies for a future signup event
// we pass the referrers in the request headers so we can use them in referral rewards for logged in stackers
function referrerMiddleware (request) {
  // referrer cookies are read only by middleware/SSR — keep them httpOnly.
  // Secure follows isSecureRequest(req); TLS-terminating dev proxies must send
  // X-Forwarded-Proto: https or st_referrer stays non-Secure.
  const referrerOptions = (maxAge) => cookieOptions({ req: request, maxAge })

  if (referrerPattern.test(request.url)) {
    const { pathname, referrer } = referrerPattern.exec(request.url).pathname.groups

    const url = new URL(pathname || '/', request.url)
    url.search = request.nextUrl.search
    url.hash = request.nextUrl.hash

    const response = NextResponse.redirect(url)
    // explicit referrers are set for a day and can only be overriden by other explicit
    // referrers. Content referrers do not override explicit referrers because
    // explicit referees might click around before signing up.
    response.cookies.set(ST_REFERRER, referrer, referrerOptions(REFERRER_TTL_S))

    // we record the first page the user lands on and keep it for 24 hours
    // in addition to the explicit referrer, this allows us to tell the referrer
    // which share link the user clicked on
    const contentReferrer = getContentReferrer(request, url)
    if (contentReferrer) {
      response.cookies.set(ST_REFEREE_LANDING, contentReferrer, referrerOptions(REFERRER_TTL_S))
    }
    // store the explicit referrer for one page load
    // this allows us to attribute both explicit and implicit referrers after the redirect
    // e.g. items/<num>/r/<referrer> links should attribute both the item op and the referrer
    // without this the /r/<referrer> would be lost on redirect
    response.cookies.set(ST_REFERRER_NONCE, referrer, referrerOptions(1))
    return response
  }

  const contentReferrer = getContentReferrer(request, request.url)

  // pass the referrers to SSR in the request headers for one day referrer attribution
  const requestHeaders = new Headers(request.headers)
  const referrers = [request.cookies.get(ST_REFERRER_NONCE)?.value, contentReferrer].filter(Boolean)
  if (referrers.length) {
    requestHeaders.set('x-stacker-news-referrer', referrers.join('; '))
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders
    }
  })

  // if we don't already have an explicit referrer, give them the content referrer as one
  if (!request.cookies.has(ST_REFERRER) && contentReferrer) {
    response.cookies.set(ST_REFERRER, contentReferrer, referrerOptions(REFERRER_TTL_S))
  }

  return response
}

function applyReferrerCookies (response, referrer) {
  for (const { name, value, ...options } of referrer.cookies.getAll()) {
    // forward all attributes (secure, httpOnly, sameSite, ...), not just timing,
    // so referrer cookies inherit the security flags set by referrerMiddleware.
    response.cookies.set(name, value, options)
  }
  return response
}

function applySecurityHeaders (resp) {
  const isDev = process.env.NODE_ENV === 'development'

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  // we want to load media from other localhost ports during development
  const devSrc = isDev ? ' localhost:* http: ws:' : ''
  // unsafe-eval is required during development due to react-refresh.js
  // see https://github.com/vercel/next.js/issues/14221
  const devScriptSrc = isDev ? " 'unsafe-eval'" : ''

  const cspHeader = [
    // if something is not explicitly allowed, we don't allow it.
    "default-src 'self' a.stasher.news",
    "font-src 'self' a.stasher.news",
    // we want to load images from everywhere but we can limit to HTTPS at least
    "img-src 'self' a.stasher.news m.stasher.news https: data: blob:" + devSrc,
    "media-src 'self' a.stasher.news m.stasher.news https: blob:" + devSrc,
    // Using nonces and strict-dynamic deploys a strict CSP.
    // see https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html#strict-policy.
    // Old browsers will ignore nonce and strict-dynamic and fallback to host-based matching and unsafe-inline
    `script-src 'self' a.stasher.news 'unsafe-inline' 'wasm-unsafe-eval' 'nonce-${nonce}' 'strict-dynamic' https:` + devScriptSrc,
    // unsafe-inline for styles is not ideal but okay if script-src is using nonces
    "style-src 'self' a.stasher.news 'unsafe-inline'",
    "manifest-src 'self'",
    'frame-src www.youtube.com www.youtube-nocookie.com platform.twitter.com njump.me open.spotify.com rumble.com embed.wavlake.com bitcointv.com peertube.tv',
    "connect-src 'self' https: wss:" + devSrc,
    // disable dangerous plugins like Flash
    "object-src 'none'",
    // blocks injection of <base> tags
    "base-uri 'none'",
    // tell user agents to replace HTTP with HTTPS
    isDev ? '' : 'upgrade-insecure-requests',
    // prevents any domain from framing the content (defense against clickjacking attacks)
    "frame-ancestors 'none'"
  ].join('; ')

  resp.headers.set('Content-Security-Policy', cspHeader)
  // for browsers that don't support CSP
  resp.headers.set('X-Frame-Options', 'DENY')
  // more useful headers
  resp.headers.set('X-Content-Type-Options', 'nosniff')
  resp.headers.set('Referrer-Policy', 'origin-when-cross-origin')
  resp.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')

  return resp
}

export async function proxy (req) {
  // clear subname header to prevent potential spoofing
  const headers = new Headers(req.headers)
  headers.delete('x-stacker-news-subname')
  headers.delete('x-stacker-news-domain')
  const request = new NextRequest(req, { headers })

  // invite gate (closed beta): gate everything except the gate page itself,
  // static assets, and the explicit exempt paths. Gate-off ('pass') is a no-op.
  const gate = shouldGateRequest({
    pathname: request.nextUrl.pathname,
    cookie: request.cookies.get(GATE_COOKIE)?.value
  })
  if (gate === 'api-401') {
    return NextResponse.json({ error: 'invite gate: unauthorized' }, { status: 401 })
  }
  if (gate === 'data-redirect') {
    // Same shape getServerSideProps redirects produce; the client router
    // navigates to /gate natively instead of erroring on an HTML redirect.
    // Keep the next target, like the HTML redirect below, so a bounce
    // preserves where the user was headed. _next/data paths map back to
    // the page path (same strip as api/ssrApollo.js authRequired).
    const gateUrl = new URL('/gate', request.url)
    const pagePath = request.nextUrl.pathname.replace(/\/_next\/data\/[^/]+\//, '/').replace(/\.json$/, '')
    gateUrl.searchParams.set('next', pagePath + request.nextUrl.search)
    return NextResponse.json({ pageProps: {}, __N_REDIRECT: gateUrl.pathname + gateUrl.search, __N_REDIRECT_BASE_PATH: true })
  }
  if (gate === 'redirect') {
    const gateUrl = new URL('/gate', request.url)
    gateUrl.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search)
    return applySecurityHeaders(NextResponse.redirect(gateUrl))
  }

  // domain can have a port (local dev), so we pass the whole domain to the middleware
  // instead of the domain retrieved from the mapping
  const domain = request.headers.get('host')
  const mapping = await getDomainMapping(domain)

  // prefetches need to be custom-domain aware.
  // for these requests, we skip referrer attribution and CSP/security headers
  if (isPrefetchRequest(request)) {
    return mapping
      ? customDomainMiddleware(request, domain, mapping.subName)
      : NextResponse.next()
  }

  // non-prefetch reqs: referrer + custom domain + security headers
  let resp = referrerMiddleware(request)
  // if resp is a redirect, apply security headers immediately and return
  if (resp.headers.get('Location')) {
    return applySecurityHeaders(resp)
  }

  if (mapping) {
    const domainResp = await customDomainMiddleware(request, domain, mapping.subName)
    // apply referrer cookies to the custom domain response
    resp = applyReferrerCookies(domainResp, resp)
  } else {
    const onionLocation = onionLocationFor({
      onionUrl: process.env.ONION_URL,
      host: domain,
      mainUrl: process.env.NEXT_PUBLIC_URL,
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search
    })
    if (onionLocation) resp.headers.set('Onion-Location', onionLocation)
  }

  return applySecurityHeaders(resp)
}

export const config = {
  matcher: [
    // NextJS recommends to not add the CSP header to prefetches and static assets
    // prefetches are handled separately in the middleware for custom domain rewrites
    // See https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy
    {
      source: '/((?!api|_next/static|_error|404|500|offline|_next/image|_next/webpack-hmr|favicon.ico).*)'
    },
    // the invite gate also protects the GraphQL API and the media-check proxy
    // (media-check joined the gated set per the capture-infra plan; gate-off
    // is a no-op); all other /api/* routes (next-auth, webhooks, metrics,
    // health, ots) are intentionally NOT gated
    {
      source: '/api/graphql'
    },
    {
      source: '/api/media-check'
    }
  ]
}
