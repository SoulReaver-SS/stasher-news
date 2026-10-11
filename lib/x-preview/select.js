import { extractLinkUrls } from '@/lib/md'
import { moneroWallEnabled, splitMoneroWallText } from '@/lib/monero-wall'
import { canonicalXStatus } from './status-url'

// First X status among Markdown link nodes in document order. Link
// extraction lives in lib/md (the repo's mdast boundary: the ESM-only mdast
// chain cannot load under jest outside a mocked lib/md). Bare GFM autolinks
// count; code fences/spans and image URLs do not.
function firstLinkedStatus (markdown) {
  if (!markdown) return null
  for (const url of extractLinkUrls(markdown)) {
    const status = canonicalXStatus(url)
    if (status) return status
  }
  return null
}

function linkedStatuses (markdown) {
  if (!markdown) return []
  return extractLinkUrls(markdown)
    .map(url => canonicalXStatus(url))
    .filter(Boolean)
}

/**
 * Pick the single X status an item may preview: the main URL first, then the
 * first eligible body link. `publicSource` is false only when the selection
 * came from below an active Monero wall. One parse of the body and, when
 * walled, one of the teaser.
 * @param {{ url?: string, text?: string, moneroWallEnabledAt?: Date|null, moneroWallRemovedAt?: Date|null }} item
 * @returns {{ sourceUrl: string, statusUrl: string, publicSource: boolean } | null}
 */
export function selectXPreviewCandidate (item) {
  const main = canonicalXStatus(item?.url)
  if (main) return { ...main, publicSource: true }

  const selected = firstLinkedStatus(item?.text)
  if (!selected) return null
  if (!moneroWallEnabled(item)) return { ...selected, publicSource: true }

  const { teaserText } = splitMoneroWallText(item.text)
  const publicSource = linkedStatuses(teaserText)
    .some(link => link.statusUrl === selected.statusUrl)
  return { ...selected, publicSource }
}
