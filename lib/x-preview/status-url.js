// Input-only recognition of X status links for preview selection.
// Pure and isomorphic: no HTTP, no Markdown, no database. Accepting a host
// here never makes it a navigation destination — outbound links still go
// through the configured Nitter frontend (lib/privacy.js).
//
// The mirror list is a reviewed snapshot (spec 2026-10-11): the HTTPS hosts
// from the Nitter project's instance list and the Shitter instance list.
// Update it explicitly when those sources change; never pattern-match
// arbitrary hosts.

export const MIRROR_HOSTS = [
  'nitter.net',
  'xcancel.com',
  'nitter.poast.org',
  'nitter.privacyredirect.com',
  'nitter.tiekoetter.com',
  'nuku.trabun.org',
  'nitter.catsarch.com',
  'nitter.kareem.one',
  'shitter.thepixora.com',
  'nitter.pp.ua',
  'nitter.meowing.monster',
  'nitter.netbub.com',
  'shi.meowing.de',
  'nitter.jaydenha.uk',
  'nitter.click',
  'nitter.xitter.cc',
  'x.n0g.xyz',
  'tw.eir-nya.gay',
  'xcopy.uk',
  'bitter.st',
  'nitt.tr',
  'twit.0r.cx',
  'xxcancel.com',
  'twiiit.com'
]

const NATIVE_HOSTS = ['x.com', 'twitter.com']
const KNOWN_HOSTS = new Set([...NATIVE_HOSTS, ...MIRROR_HOSTS])

const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)\/?$/

// The pinned list accepts root paths; the configured Nitter URL may live on
// a pinned host under a path prefix (e.g. https://nitter.net/nitter), so both
// the pinned root and the configured prefix are candidate path roots. Read at
// call time so tests and runtime env changes stay effective; invalid
// configuration contributes nothing.
function configuredPathPrefix (hostname) {
  try {
    const configured = new URL(process.env.NEXT_PUBLIC_NITTER_URL)
    if (configured.protocol !== 'https:' || configured.username || configured.password || configured.port) return null
    if (configured.hostname !== hostname) return null
    return configured.pathname.replace(/\/+$/, '')
  } catch {
    return null
  }
}

// Returns the path remainder after the accepted host prefix, or null.
function statusRemainder (parsed) {
  const candidates = []
  if (KNOWN_HOSTS.has(parsed.hostname)) candidates.push('')
  const configured = configuredPathPrefix(parsed.hostname)
  if (configured != null) candidates.push(configured)
  for (const prefix of candidates) {
    if (prefix && parsed.pathname !== prefix && !parsed.pathname.startsWith(prefix + '/')) continue
    const remainder = parsed.pathname.slice(prefix.length)
    if (STATUS_PATH.test(remainder)) return remainder
  }
  return null
}

/**
 * Canonicalize an X status link for preview use.
 * @param {string} sourceUrl
 * @returns {{ sourceUrl: string, statusUrl: string } | null}
 */
export function canonicalXStatus (sourceUrl) {
  if (!sourceUrl) return null
  let parsed
  try {
    parsed = new URL(sourceUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null

  const remainder = statusRemainder(parsed)
  if (!remainder) return null
  const status = remainder.match(STATUS_PATH)

  return {
    sourceUrl,
    statusUrl: `https://x.com/${status[1]}/status/${status[2]}`
  }
}
