// Inline markdown links in plain text.
//
// The compose (rich/WYSIWYG) editor has no markdown link input: text typed or
// pasted there arrives as a plain TextNode, not a LinkNode. When that text is
// serialized to markdown the brackets would normally be escaped, so
// `[Wingbits](https://wingbits.com/)` is stored as `\[Wingbits\]\(...)` and the
// published post shows the raw markup instead of a link (issue #16). These
// helpers let the serializer keep link syntax intact.

// http(s) destinations only: enough for the links users paste, and narrow
// enough that prose like `[note](above)` is not silently turned into a
// site-relative link at render time.
export const MARKDOWN_LINK_REGEXP = /\[([^[\]]+)\]\((https?:\/\/[^()\s]+)\)/g

/**
 * emits inline markdown links in `value` verbatim while handing every other
 * span to `escape`.
 *
 * @param {string} value - text of a single TextNode
 * @param {(text: string) => string} escape - escapes markdown syntax
 * @returns {string}
 */
export function preserveMarkdownLinks (value, escape) {
  // cheap precheck for inline link syntax
  if (!value.includes('](')) return escape(value)

  let output = ''
  let lastIndex = 0
  for (const match of value.matchAll(MARKDOWN_LINK_REGEXP)) {
    // don't reinterpret image syntax (`![alt](url)`) as a link
    if (match.index > 0 && value[match.index - 1] === '!') continue

    output += escape(value.slice(lastIndex, match.index)) + match[0]
    lastIndex = match.index + match[0].length
  }

  return output + escape(value.slice(lastIndex))
}
