/**
 * creates a fake DOM using LinkeDOM for server-side rendering
 * @param {string} html - HTML content to parse
 * @returns {Object} parsed HTML object with window and document
 */
export function createLinkeDOM (html) {
  // the typeof window guard is compile-time constant in Next bundles,
  // so webpack drops linkedom from client builds entirely
  if (isServer) {
    const { parseHTML } = require('linkedom')
    return parseHTML(html || '<!DOCTYPE html>')
  }
  throw new Error('createLinkeDOM is server-only')
}

// Captured at module load, BEFORE any withDOM() call installs a temporary
// global window: Lexical SSR sets global.window while rendering, and testing
// `typeof window` at call time would misroute sanitization into the browser
// branch (or hand DOMPurify a LinkeDOM window). Like the guard above, this is
// compile-time constant in Next bundles, keeping jsdom out of client builds.
const isServer = typeof window === 'undefined'

// One jsdom window + DOMPurify instance per process. jsdom is the only
// server DOM DOMPurify officially supports; LinkeDOM (used for rendering
// above) leaves DOMPurify unsupported, and an unsupported DOMPurify returns
// its input UNCHANGED — the silent no-op sanitizer this module shipped until
// 2026-10-24. jsdom defaults are inert: no script execution, no network.
let serverPurifier = null

function getServerDOMPurify () {
  if (!serverPurifier) {
    // !process.browser is true in every server runtime (plain Node leaves
    // process.browser undefined) and unaffected by withDOM's temporary
    // global window, while Next's DefinePlugin makes it constant-false in
    // client bundles so webpack prunes the jsdom require from them — the
    // indirection through `isServer` above would defeat that pruning
    if (!process.browser) {
      const { JSDOM } = require('jsdom')
      const purifier = require('dompurify')(new JSDOM('').window)
      if (!purifier.isSupported) {
        // fail closed: a sanitizer that cannot sanitize must never hand back
        // unsanitized HTML pretending to be clean
        throw new Error('dompurify: server sanitizer unsupported — refusing to return unsanitized HTML')
      }
      serverPurifier = purifier
    }
  }
  return serverPurifier
}

/**
 * returns DOMPurify instance for either browser or server environment
 * @param {Object} [domWindow] - ignored on the server (kept for API
 *   compatibility): sanitization always runs on the jsdom instance, never on
 *   a rendering window, which is what silently disabled it before
 * @returns {Object} DOMPurify instance
 */
export function getDOMPurify (domWindow) {
  if (isServer) {
    return getServerDOMPurify()
  }
  if (domWindow) {
    const DOMPurify = require('dompurify')
    return DOMPurify(domWindow)
  }
  return require('dompurify')
}

/**
 * sanitizes HTML using DOMPurify
 * @param {string} html - HTML content to sanitize
 * @returns {string} sanitized HTML string
 */
export function sanitizeHTML (html) {
  return getDOMPurify().sanitize(html)
}

/**
 * parses and sanitizes HTML, returning a document object
 * @param {string} html - HTML content to parse and sanitize
 * @returns {Document} parsed and sanitized document object
 */
export function getParsedHTML (html) {
  if (isServer) {
    const normalizedHTML = !html.toLowerCase().startsWith('<!doctype html>')
      ? `<!doctype html>
          <html lang="en">
            <body>
              ${html}
            </body>
          </html>`
      : html
    const parsed = createLinkeDOM(normalizedHTML)

    // sanitize on the supported jsdom instance; LinkeDOM only parses
    const sanitizedHTML = sanitizeHTML(html)

    // update the body with sanitized content
    parsed.document.body.innerHTML = sanitizedHTML
    return parsed.document
  }

  // client-side
  const sanitizedHTML = sanitizeHTML(html)
  return new window.DOMParser().parseFromString(sanitizedHTML, 'text/html')
}
