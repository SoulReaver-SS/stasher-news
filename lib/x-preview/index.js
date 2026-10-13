import domino from 'domino'
import { getMetadata, metadataRuleSets } from 'page-metadata-parser'
import { snFetch } from '@/lib/fetch'
import { parseEmbedUrl, parseHandleFromUrl } from '@/lib/url'
import { canonicalXStatus } from './status-url'
import { logWarn } from '@/lib/logger'

export { parseHandleFromUrl }

const OEMBED_URL = 'https://publish.twitter.com/oembed'

// <br> is the line-break token in oEmbed HTML (including <br><br> for blank
// lines). textContent would drop it and splice the surrounding words together,
// so walk the DOM and keep line breaks as newlines.
function textWithLineBreaks (node) {
  let text = ''
  for (const child of node.childNodes) {
    if (child.nodeName === 'BR') text += '\n'
    else if (child.nodeType === 3) text += child.nodeValue
    else text += textWithLineBreaks(child)
  }
  return text
}

export function parseOembedHtml (html) {
  const doc = domino.createWindow(html).document
  const blockquote = doc.querySelector('blockquote')
  if (!blockquote) return null
  const p = blockquote.querySelector('p')
  const text = p ? textWithLineBreaks(p).trim() : null
  let date = null
  const tcoHrefs = []
  // t.co hrefs live on the anchors' href attribute, NOT the visible text: media
  // shortlinks render as `pic.twitter.com/…` while their href is still `t.co/…`.
  // Matching the textContent would miss every media shortlink.
  for (const a of Array.from(blockquote.querySelectorAll('a'))) {
    const href = a.href
    if (href.includes('/status/')) {
      date = a.textContent.trim()
    } else if (href.startsWith('https://t.co/')) {
      tcoHrefs.push(href)
    }
  }
  return { text, date, tcoHrefs }
}

export async function unshortenTco (href) {
  try {
    const res = await snFetch(href, { timeout: 5000, method: 'HEAD', redirect: 'manual' })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      return new URL(location, href).toString()
    }
    return href
  } catch (err) {
    logWarn({ href, error: err?.message }, 'x-preview: t.co unshorten failed')
    return null
  }
}

async function fetchOgImage (url) {
  try {
    // x.com pages can exceed snFetch's 256KB default body cap; without a larger
    // cap res.text() throws and the og:image scrape silently fails (no image).
    const res = await snFetch(url, { timeout: 10000, size: 2 * 1024 * 1024 })
    if (!res.ok) return null
    const html = await res.text()
    const doc = domino.createWindow(html).document
    const metadata = getMetadata(doc, url, metadataRuleSets)
    const image = metadata?.image || null
    // X puts the author's profile picture in og:image when a post has no
    // media; it is never the post's media, so drop it. (Blocklist, not
    // allowlist: real media can also live outside /media/ — e.g. video
    // thumbnails on ton.twimg.com — so only reject what is definitely an
    // avatar/banner.)
    if (image && /https?:\/\/[^/]+\/profile_(images|banners)\//.test(image)) return null
    return image
  } catch (err) {
    logWarn({ url, error: err?.message }, 'x-preview: og:image scrape failed')
    return null
  }
}

export async function fetchXPreview (url) {
  // defense in depth: only ever fetch a canonical native X status URL —
  // mirrors are accepted as inputs, never fetched or used as metadata sources
  const canonical = canonicalXStatus(url)
  if (!canonical || canonical.statusUrl !== url) return null
  if (parseEmbedUrl(url)?.provider !== 'twitter') return null

  let oembed
  try {
    const res = await snFetch(`${OEMBED_URL}?url=${encodeURIComponent(url)}`, { timeout: 10000 })
    if (!res.ok) return null
    oembed = await res.json()
  } catch (err) {
    logWarn({ url, error: err?.message }, 'x-preview: oembed fetch failed')
    return null
  }

  const parsed = parseOembedHtml(oembed.html)
  if (!parsed?.text) return null

  // handle comes from the status URL (always has /status), NOT oembed.author_url
  // (a bare profile URL like https://x.com/Handle — no /status — which
  // parseHandleFromUrl would reject, returning null for every valid tweet).
  const handle = parseHandleFromUrl(url)
  if (!handle) return null

  let text = parsed.text
  for (const tco of parsed.tcoHrefs.slice(0, 3)) {
    const dest = await unshortenTco(tco)
    if (dest) {
      text = text.replace(tco, dest.replace(/^https?:\/\//, ''))
    } else {
      text = text.replace(tco, '')
    }
  }
  // drop self-referential media tokens and tidy spacing without flattening
  // line breaks (the card renders the text with white-space: pre-line)
  text = text
    .replace(/\bpic\.twitter\.com\/\w+/g, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim()

  const preview = {
    authorName: oembed.author_name,
    handle,
    text,
    date: parsed.date,
    statusUrl: url
  }

  const imageUrl = await fetchOgImage(url)
  if (imageUrl) preview.imageUrl = imageUrl

  return preview
}
