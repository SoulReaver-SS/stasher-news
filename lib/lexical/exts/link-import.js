import { defineExtension } from 'lexical'
import { $createLinkNode } from '@lexical/link'
import { preferAbsoluteTextUrl, removeYoutubeTracking } from '@/lib/url'

// $convertAnchorElement from @lexical/link, except the href runs through
// preferAbsoluteTextUrl: anchors pasted from foreign DOM (x.com renders
// root-relative hrefs like /<handle>/status/<id> while the anchor text is the
// full URL) must not silently re-target to our origin and 404 (production:
// items 338968, 339643, 339760).
function $convertAnchorElement (domNode) {
  let node = null
  if (domNode.nodeName.toLowerCase() === 'a') {
    const content = domNode.textContent
    if ((content !== null && content !== '') || domNode.children.length > 0) {
      const href = domNode.getAttribute('href') || ''
      node = $createLinkNode(removeYoutubeTracking(preferAbsoluteTextUrl(href, content || '')), {
        rel: domNode.getAttribute('rel'),
        target: domNode.getAttribute('target'),
        title: domNode.getAttribute('title')
      })
    }
  }
  return { node }
}

// HTMLConfig['import'] conversions are appended after node importDOM entries
// and win ties at equal priority (getConversionFunction prefers the last
// registered importer), so priority 1 exactly shadows LinkNode.importDOM for
// plain anchors while guarded conversions (footnote backrefs) still win by
// returning null here.
export const anchorImportConversion = domNode => {
  // let specialized conversions claim their own serialized anchors
  if (domNode.hasAttribute?.('data-lexical-footnote-backref')) return null
  return { conversion: $convertAnchorElement, priority: 1 }
}

export const SNLinkImportExtension = defineExtension({
  name: 'SNLinkImportExtension',
  html: {
    import: {
      a: anchorImportConversion
    }
  }
})
