import { nip19 } from 'nostr-tools'
import { DEFAULT_CROSSPOSTING_RELAYS } from './nostr'
import { PUBLIC_MEDIA_URL } from './constants'

export function ensureProtocol (value) {
  if (!value) return value
  value = value.trim()
  let url

  try {
    url = new URL(value)
  } catch {
    try {
      url = new URL('http://' + value)
    } catch {
      return value
    }
  }

  // remove trailing slash if new URL() added it
  if (url.href.endsWith('/') && !value.endsWith('/')) {
    return url.href.slice(0, -1)
  }
  return url.href
}

export function isExternal (url) {
  if (url.startsWith('/')) return false
  if (url.startsWith(process.env.NEXT_PUBLIC_URL + '/')) return false
  if (typeof window !== 'undefined' && url.startsWith(window.location.origin + '/')) return false
  return true
}

export function isHashLink (url) {
  return url?.startsWith('#')
}

export function isInternalLink (url) {
  return isHashLink(url) || !isExternal(url)
}

export function getLinkAttributes (url, { target, rel } = {}) {
  // self-hosted media assets (PUBLIC_MEDIA_URL/<id>) are served same-origin in
  // prod (NEXT_PUBLIC_MEDIA_URL=https://stasher.news/uploads behind Caddy) but
  // are assets, not app routes: a target='' link makes Lexical's NextLinkPlugin
  // client-route /uploads/<id>, which matches the /[name]/[type] user page
  // route and crashes it on a null user (issue #14). classify them external so
  // they open in a new tab like any other non-app URL.
  const MEDIA_ASSET_PREFIX = (process.env.NEXT_PUBLIC_MEDIA_URL || process.env.NEXT_PUBLIC_MEDIA_DOMAIN)
    ? `${PUBLIC_MEDIA_URL}/`
    : null
  const isMediaAsset = !!MEDIA_ASSET_PREFIX && typeof url === 'string' && url.startsWith(MEDIA_ASSET_PREFIX)
  const internal = isInternalLink(url) && !isMediaAsset
  return {
    target: internal ? '' : (target ?? '_blank'),
    rel: internal ? '' : (rel ?? 'noopener nofollow noreferrer')
  }
}

export function removeTracking (value) {
  if (!value) return value
  const exprs = [
    // twitter URLs
    /^(?<url>https?:\/\/(?:twitter|x)\.com\/(?:#!\/)?(?<user>\w+)\/status(?:es)?\/(?<id>\d+))/
  ]
  for (const expr of exprs) {
    value = expr.exec(value)?.groups.url ?? value
  }
  return removeYoutubeTracking(value)
}

export function removeYoutubeTracking (value) {
  if (!value) return value
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) ||
      !(matchHost(url.hostname, 'youtube.com') || matchHost(url.hostname, 'youtu.be'))) return value
    let changed = false
    for (const key of [...url.searchParams.keys()]) {
      if (/^(si|feature|gclid|dclid|fbclid|msclkid|utm_.+)$/i.test(key)) {
        url.searchParams.delete(key)
        changed = true
      }
    }
    return changed ? url.href : value
  } catch {}
  return value
}

/**
 * parse links like https://stacker.news/items/123456 as #123456
 */

export function isItemPath (pathname) {
  if (!pathname) return false

  const [page, id] = pathname.split('/').filter(part => !!part)
  return page === 'items' && /^[0-9]+$/.test(id)
}

export function parseItemUrl (url) {
  const { pathname, searchParams } = url
  if (!isItemPath(pathname)) return {}

  // ignore empty parts which exist due to pathname starting with '/'
  const parts = pathname.split('/').filter(part => !!part)
  const itemId = parts[1]
  // check for valid item page due to referral links like /items/123456/r/ekzyis
  const itemPages = ['edit', 'ots', 'related']
  const itemPage = itemPages.includes(parts[2]) ? parts[2] : null
  if (itemPage) {
    // parse   https://stacker.news/items/1/related?commentId=2
    // as      #1/related
    // and not #2
    // since commentId will be ignored anyway
    return { itemId, linkText: `#${itemId}/${itemPage}` }
  }
  const commentId = searchParams.get('commentId')
  return { itemId, commentId, linkText: `#${commentId || itemId}` }
}

export function parseInternalLinks (href) {
  const url = new URL(href)
  const internalURL = process.env.NEXT_PUBLIC_URL

  const isInternal = url.origin === internalURL ||
    (typeof window !== 'undefined' && url.origin === window.location.origin)

  if (!isInternal) return {}
  return parseItemUrl(url)
}

export function parseYoutubeStart (t) {
  // https://stackoverflow.com/questions/17379268/youtube-dropped-t-start-time-support-in-direct-url-and-embed-videos
  // https://developers.google.com/youtube/player_parameters#start
  if (!t || !t.match(/^([0-9]+[smh])+$/g)) return t
  let r = 0
  for (const m of t.matchAll(/([0-9]+)([smh])/g)) {
    r += parseInt(m[1]) * Math.pow(60, 'smh'.indexOf(m[2]))
  }
  return r.toString()
}

// exact-host or subdomain match. hostname.endsWith('foo.com') also matched
// attacker-controlled evilfoo.com — a stored-XSS-class content injection that
// rendered an attacker-origin iframe inside the site (audit B-5).
function matchHost (hostname, base) {
  return hostname === base || hostname.endsWith('.' + base)
}

export function parseEmbedUrl (href) {
  if (!href) return null

  try {
    const twitter = href.match(/^https?:\/\/(?:twitter|x)\.com\/(?:#!\/)?\w+\/status(?:es)?\/(?<id>\d+)/)
    if (twitter?.groups?.id) {
      return {
        provider: 'twitter',
        id: twitter.groups.id
      }
    }

    const { hostname, pathname, searchParams } = new URL(href)

    // nostr prefixes: [npub1, nevent1, nprofile1, note1]
    const nostr = pathname.match(/\/(?<id>(?<type>npub1|nevent1|nprofile1|note1|naddr1)[02-9ac-hj-np-z]+)/)
    if (nostr?.groups?.id) {
      let id = nostr.groups.id
      if (nostr.groups.type === 'npub1') {
        const { data } = nip19.decode(id)
        id = nip19.nprofileEncode({ pubkey: data })
      }
      if (nostr.groups.type === 'note1') {
        const { data } = nip19.decode(id)
        // njump needs relays to embed
        id = nip19.neventEncode({ id: data, relays: DEFAULT_CROSSPOSTING_RELAYS, author: '' })
      }
      return {
        provider: 'nostr',
        id
      }
    }

    // https://wavlake.com/track/c0aaeff8-5a26-49cf-8dad-2b6909e4aed1
    if (matchHost(hostname, 'wavlake.com') && pathname.startsWith('/track')) {
      return {
        provider: 'wavlake',
        id: pathname.split('/')?.[2]
      }
    }

    if (matchHost(hostname, 'spotify.com') && (pathname.startsWith('/track') || pathname.startsWith('/episode'))) {
      return {
        provider: 'spotify'
      }
    }

    if (matchHost(hostname, 'youtube.com') || matchHost(hostname, 'youtu.be')) {
      const id = matchHost(hostname, 'youtu.be')
        ? pathname.split('/')[1]
        : /^\/watch\/?$/.test(pathname)
          ? searchParams.get('v')
          : pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1]
      if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
      return {
        provider: 'youtube',
        id,
        meta: {
          href,
          start: parseYoutubeStart(searchParams.get('t') ?? searchParams.get('start'))
        }
      }
    }

    if (matchHost(hostname, 'rumble.com') && pathname.includes('/embed')) {
      return {
        provider: 'rumble',
        id: null, // not required
        meta: {
          href
        }
      }
    }

    if (matchHost(hostname, 'peertube.tv') || matchHost(hostname, 'bitcointv.com')) {
      return {
        provider: 'peertube',
        id: null,
        meta: {
          href: href.replace('/w/', '/videos/embed/')
        }
      }
    }
  } catch (err) {
    console.log('Error parsing embed URL:', href)
  }

  return null
}

export function parseHandleFromUrl (url) {
  const m = url?.match(/^https?:\/\/(?:twitter|x)\.com\/(?:#!\/)?([A-Za-z0-9_]{1,15})\/status/)
  return m?.[1] ?? null
}

export function stripTrailingSlash (uri) {
  return uri.endsWith('/') ? uri.slice(0, -1) : uri
}

export class ResponseAssertError extends Error {
  constructor (res, { message, method } = {}) {
    const urlPart = method ? `${method} ${res.url}` : res.url
    const msgPart = message ?? `${res.status} ${res.statusText}`
    super(`${urlPart}: ${msgPart}`)
    this.name = 'ResponseAssertError'
    this.status = res.status
    this.statusText = res.statusText
    // consume response body to avoid memory leaks
    // see https://github.com/nodejs/node/issues/51162
    res.text().catch(() => {})
  }
}

class ContentTypeAssertError extends ResponseAssertError {
  constructor (res, { method, expected, actual } = {}) {
    const message = `wrong content-type: expected: ${expected}, got: ${actual}`
    super(res, { method, message })
    this.name = 'ContentTypeAssertError'
  }
}

export function assertResponseOk (res, { method } = {}) {
  if (!res.ok) {
    throw new ResponseAssertError(res, { method })
  }
}

export function assertContentTypeJson (res, { method } = {}) {
  const expected = 'application/json'
  const contentType = res.headers.get('content-type') ?? ''
  // Parse the MIME type before parameters (e.g. `;charset=utf-8`) so we never
  // accept content types like `text/application/json` that happen to contain
  // the expected substring.
  const mimeType = contentType.split(';')[0].trim().toLowerCase()
  if (mimeType !== expected) {
    throw new ContentTypeAssertError(res, { method, expected, actual: mimeType || 'none' })
  }
}

export function decodeProxyUrl (imgproxyUrl) {
  const parts = imgproxyUrl.split('/')
  // base64url is not a known encoding in browsers
  // so we need to replace the invalid chars
  // replace ALL invalid base64url chars, not just the first `_`
  const b64Url = parts[parts.length - 1].replace(/-/g, '+').replace(/_/g, '/')
  const originalUrl = Buffer.from(b64Url, 'base64').toString('utf-8')
  return originalUrl
}

export function canonicalizeMediaUrl (url) {
  if (!process.env.NEXT_PUBLIC_IMGPROXY_URL || typeof url !== 'string') return url
  return IMGPROXY_URL_REGEXP.test(url) ? decodeProxyUrl(url) : url
}

export function canonicalizeItemText (text) {
  if (!process.env.NEXT_PUBLIC_IMGPROXY_URL || typeof text !== 'string') return text
  // scan unanchored + global: match the imgproxy base then everything up to
  // whitespace or ')' so trailing markdown parens aren't swallowed.
  // Only decode matches with the signed-url shape BASE/<sig>/<options>/<b64>
  // (>=3 non-empty path segments after the base); plain mentions of the base
  // or partial paths are kept verbatim — decoding them would corrupt or
  // delete innocent text.
  return text.replace(new RegExp(`${process.env.NEXT_PUBLIC_IMGPROXY_URL}[^\\s)]*`, 'g'), m => {
    const rest = m.slice(process.env.NEXT_PUBLIC_IMGPROXY_URL.length)
    const segments = rest.split('/').filter(Boolean)
    return segments.length >= 3 ? decodeProxyUrl(m) : m
  })
}

/**
 * Foreign sites (e.g. x.com) paste anchors whose href is root-relative while
 * the visible text is the full URL. Stored verbatim, such hrefs resolve against
 * OUR origin and 404 (production: items 338968, 339643, 339760). If the href
 * is relative but the link text is itself an absolute http(s) URL, that URL is
 * the intended target.
 */
export function preferAbsoluteTextUrl (href, text) {
  if (!href || href.startsWith('#')) return href
  // absolute hrefs (any scheme, incl. mailto:) are kept verbatim; a href
  // without a scheme is relative and resolves against whatever origin
  // renders it — ours, when pasted from foreign DOM
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href
  const t = (text ?? '').trim()
  // texts with spaces are never URLs (mirrors isMisleadingLink)
  if (!t || /\s/.test(t)) return href
  try {
    const url = new URL(t)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return href
    return url.href
  } catch {
    return href
  }
}

export function isMisleadingLink (text, href) {
  let misleading = false

  // texts with non-trailing spaces are never urls
  if (/\s/.test(text.trim())) {
    return false
  }

  // numeric texts with periods that have less than 4 elements aren't hosts
  if (/^\d+\.(\d+)(\.\d)?$/.test(text.trim())) {
    return false
  }

  try {
    const hrefUrl = new URL(href)

    try {
      const textUrl = new URL(text)
      // if textUrl.origin has value 'null', it means the text is not trying to be a URL
      if (textUrl.origin !== 'null' && textUrl.origin !== hrefUrl.origin) {
        misleading = true
      }
    } catch {}

    if (/^\s*([\w-]+\.)+\w+/.test(text)) {
      if (new URL(hrefUrl.protocol + text).origin !== hrefUrl.origin) {
        misleading = true
      }
    }
  } catch {}

  return misleading
}

// eslint-disable-next-line
export const URL_REGEXP = /^((https?|ftp):\/\/)?(www.)?(((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:)*@)?(((\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]))|((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.?)(:\d*)?)(\/((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)+(\/(([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)*)*)?)?(\?((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)|[\uE000-\uF8FF]|\/|\?)*)?(\#((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)|\/|\?)*)?$/i

// eslint-disable-next-line
export const WS_REGEXP = /^(wss?:\/\/)([0-9]{1,3}(?:\.[0-9]{1,3}){3}|(?=[^\/]{1,254}(?![^\/]))(?:(?=[a-zA-Z0-9-]{1,63}\.)(?:xn--+)?[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,63})(:([0-9]{1,5}))?(\/[^\s`@#$^&=.?"{}\\]+\/?)*([^\s`@#$^&=?"{}\/\\]+)?(\?[^\s`#$^"{}\\]+)*$/

export const IMGPROXY_URL_REGEXP = new RegExp(`^${process.env.NEXT_PUBLIC_IMGPROXY_URL}.*$`)
export const MEDIA_DOMAIN_REGEXP = new RegExp(`^https?://${process.env.NEXT_PUBLIC_MEDIA_DOMAIN}/.*$`)

// this regex is not a bullet proof way of checking if a url points to an image. to be sure, fetch the url and check the mimetype
export const IMG_URL_REGEXP = /^(https?:\/\/.*\.(?:png|jpg|jpeg|gif))$/

export const TOR_REGEXP = /\.onion(:[0-9]+)?$/
