import { parseYoutubeStart, removeYoutubeTracking } from './url'

const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/
const matchHost = (host, base) => host === base || host.endsWith('.' + base)

// Invalid configuration disables rewriting; original stored URLs stay intact.
function instance (value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.origin + url.pathname.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

function instances (provider) {
  return provider === 'youtube'
    ? [instance(process.env.NEXT_PUBLIC_INVIDIOUS_URL), instance(process.env.NEXT_PUBLIC_INVIDIOUS_URL_ALT)]
    : [instance(process.env.NEXT_PUBLIC_NITTER_URL)]
}

function destinations ([primary, alternate], path) {
  return primary ? { primary: primary + path, alternate: alternate ? alternate + path : null } : null
}

function timestamp (value) {
  const seconds = parseYoutubeStart(String(value ?? ''))
  return /^\d+$/.test(seconds) && Number(seconds) > 0 ? seconds : null
}

function watchPath (id, start, privatePlayback = true) {
  return `/watch?v=${id}${privatePlayback ? '&local=true' : ''}${start ? '&t=' + start : ''}`
}

export function privacyUrls (href) {
  try {
    const url = new URL(href)
    if (!['https:', 'http:'].includes(url.protocol)) return null
    let provider, path
    if (matchHost(url.hostname, 'youtube.com') || matchHost(url.hostname, 'youtu.be')) {
      const id = matchHost(url.hostname, 'youtu.be')
        ? url.pathname.split('/')[1]
        : /^\/watch\/?$/.test(url.pathname)
          ? url.searchParams.get('v')
          : url.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1]
      if (!id || !VIDEO_ID.test(id)) return null
      provider = 'youtube'
      path = watchPath(id, timestamp(url.searchParams.get('t') ?? url.searchParams.get('start')))
      for (const key of ['list', 'index', 'end']) {
        if (url.searchParams.has(key)) path += `&${key}=${encodeURIComponent(url.searchParams.get(key))}`
      }
    } else if (matchHost(url.hostname, 'x.com') || matchHost(url.hostname, 'twitter.com')) {
      const status = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)(?:\/|$)/)
      if (!status) return null
      provider = 'x'
      path = `/${status[1]}/status/${status[2]}`
    } else return null
    const urls = destinations(instances(provider), path)
    return urls ? { provider, ...urls, original: removeYoutubeTracking(href) } : null
  } catch {
    return null
  }
}

export function privacyEmbed (id, start, href) {
  if (!id || !VIDEO_ID.test(id)) return null
  let source
  try {
    source = new URL(removeYoutubeTracking(href || 'https://www.youtube.com' + watchPath(id, timestamp(start), false)))
  } catch { return null }
  const seconds = timestamp(source.searchParams.get('t') ?? source.searchParams.get('start')) ?? timestamp(start)
  if (seconds && !source.searchParams.has('t') && !source.searchParams.has('start')) source.searchParams.set('t', seconds)
  const original = source.href
  const urls = privacyUrls(original)
  const params = new URLSearchParams({ autoplay: '1' })
  if (seconds) params.set('start', seconds)
  for (const key of ['list', 'index', 'end']) {
    const value = source.searchParams.get(key)
    if (value != null) params.set(key, value)
  }
  return {
    src: `https://www.youtube-nocookie.com/embed/${id}?${params}`,
    watch: urls?.primary ?? null,
    alternate: urls?.alternate ?? null,
    original
  }
}

// Display HTML only: Lexical's HTML clipboard export must retain original hrefs.
export function rewritePrivacyLinks (element) {
  for (const anchor of element.querySelectorAll('a[href]')) {
    if (anchor.closest('.sn-private-link')) continue
    const rendered = privacyLinkElement(anchor, anchor.getAttribute('href'))
    if (rendered !== anchor) anchor.replaceWith(rendered)
  }
}

export function privacyLinkElement (anchor, href) {
  const urls = privacyUrls(href)
  if (anchor.tagName !== 'A' || !urls) return anchor
  const wrapper = anchor.ownerDocument.createElement('span')
  wrapper.className = 'sn-private-link'
  const original = anchor.ownerDocument.createElement('a')
  original.className = 'sn-private-original'
  original.href = urls.original
  original.target = '_blank'
  original.rel = anchor.rel || 'noopener nofollow noreferrer'
  original.textContent = 'original ↗'
  anchor.setAttribute('href', urls.primary)
  // Leave the original anchor in place until its caller installs the wrapper.
  wrapper.append(anchor.cloneNode(true), ' ', original)
  return wrapper
}
