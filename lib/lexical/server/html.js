import { $generateHtmlFromNodes } from '@lexical/html'
import { sanitizeHTML } from '@/lib/dompurify'
import { withDOM } from '@/lib/lexical/server/dom'
import { createSNHeadlessEditor } from '@/lib/lexical/headless'
import { rewritePrivacyLinks } from '@/lib/privacy'

export function generateHTML (editor, selection = null, sanitize = true, window = global.window, readerXLinks = false) {
  let html = ''
  try {
    html = editor.read(() => $generateHtmlFromNodes(editor, selection))
    const container = window.document.createElement('div')
    container.innerHTML = html
    if (readerXLinks) replaceTwitterEmbeds(container, window)
    rewritePrivacyLinks(container)
    html = container.innerHTML
    if (sanitize) {
      html = sanitizeHTML(html, window)
    }
  } catch (error) {
    console.error('error generating HTML:', error)
    return 'Error generating HTML, content will be loaded in a moment.'
  }
  return html
}

// Read-only item HTML downgrades standalone X embeds to plain links: the item
// renders one cached preview card instead, and hydration re-renders the same
// link. The writer's own exports (clipboard) never pass readerXLinks and keep
// the embed nodes intact.
function replaceTwitterEmbeds (container, window) {
  for (const el of container.querySelectorAll('[data-lexical-embed-provider="twitter"][data-lexical-embed-src]')) {
    const src = el.getAttribute('data-lexical-embed-src')
    const anchor = window.document.createElement('a')
    anchor.href = src
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer nofollow'
    anchor.textContent = src
    el.replaceWith(anchor)
  }
}

/**
 * generates HTML from Lexical state on server-side
 *
 * note: gets called by APIs to submit items, check performance
 * @param {string} lexicalState - serialized lexical editor state
 * @param {Object} [options={}] - generation options
 * @param {boolean} [options.sanitize=true] - whether to sanitize HTML
 * @param {Object} [options.selection=null] - optional selection for partial HTML generation
 * @param {Object} [editorOptions={}] - editor configuration options
 * @returns {string} generated HTML or error message
 */
export function lexicalHTMLGenerator (lexicalState, options = {}, editorOptions = {}) {
  if (typeof window !== 'undefined') {
    throw new Error('can\'t use lexicalHTMLGenerator in a client environment as it creates a DOM and sets global window and document')
  }

  const {
    sanitize = true,
    selection = null,
    readerXLinks = false
  } = options

  return withDOM(() => {
    const editor = createSNHeadlessEditor(editorOptions)

    try {
      editor.setEditorState(editor.parseEditorState(lexicalState))
    } catch (error) {
      return 'Error generating rich content, another attempt will be made. Mention an admin if this persists.'
    }

    return generateHTML(editor, selection, sanitize, global.window, readerXLinks)
  })
}
