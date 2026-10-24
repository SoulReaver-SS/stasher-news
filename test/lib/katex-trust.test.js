/* eslint-env jest */
/* eslint-disable no-extend-native -- this file deliberately pollutes
   Object.prototype inside the jest sandbox to simulate the precondition of
   GHSA-238p-pmpm-9mq7; every assignment is cleaned up in afterEach */

// Security regression for GHSA-238p-pmpm-9mq7 (CVE-2026-103923): KaTeX
// >=0.11.0 <0.18.2 treated inherited Object.prototype properties as renderer
// settings, setting metadata, and namespace entries. Verified 2026-10-24 on
// the previously resolved 0.16.47: with Object.prototype.trust = true and NO
// own `trust` in the options, katex rendered \href{javascript:...} into a
// real clickable javascript: link. The app's two call sites
// (components/katex-renderer.js and lib/lexical/nodes/formatting/math.jsx)
// both pass an explicit trust:false, which blocks that primary path, but the
// advisory (and the roadmap's exposure note) say explicit trust:false is not
// a complete fix for the inherited-metadata paths. These tests pin the
// patched library contract so a lockfile regression below 0.18.2 fails CI.

const katex = require('katex')

// the app's SSR render options (keep in sync with math.jsx exportDOM)
const appOpts = {
  displayMode: false,
  errorColor: '#cc0000',
  output: 'html',
  strict: 'warn',
  throwOnError: false,
  trust: false
}

afterEach(() => {
  // never leave the prototype polluted for other tests in this file
  delete Object.prototype.trust
  delete Object.prototype.default
  delete Object.prototype.processor
})

describe('KaTeX trust boundary (GHSA-238p-pmpm-9mq7)', () => {
  test('inherited Object.prototype.trust must not enable javascript: links', () => {
    Object.prototype.trust = true
    // no own `trust` in options: the renderer-default path where the
    // inherited value used to be accepted on vulnerable versions
    const html = katex.renderToString('\\href{javascript:alert(1)}{click}', {
      throwOnError: false
    })
    expect(html).not.toMatch(/href="javascript:/i)
    expect(html).not.toMatch(/<a[^>]*href/i)
  })

  test('inherited setting metadata (default/processor) stays inert under the app options', () => {
    Object.prototype.default = { trust: true }
    Object.prototype.processor = { trust: () => true }
    const html = katex.renderToString('\\href{javascript:alert(1)}{click}', appOpts)
    expect(html).not.toMatch(/href="javascript:/i)
    expect(html).not.toMatch(/<a[^>]*href/i)
  })

  test('hostile trusted commands stay inert with the app options even when trust is inherited too', () => {
    Object.prototype.trust = true
    for (const tex of ['\\href{javascript:alert(1)}{click}', '\\url{javascript:alert(1)}']) {
      const html = katex.renderToString(tex, appOpts)
      expect(html).not.toMatch(/href="javascript:/i)
    }
    const img = katex.renderToString('\\includegraphics{https://evil.invalid/x.png}', appOpts)
    expect(img).not.toMatch(/src="https:\/\/evil\.invalid/i)
  })
})

describe('math rendering through the app options', () => {
  test('renders inline, display and matrix math into katex markup', () => {
    for (const [tex, opts] of [
      ['c = \\pm\\sqrt{a^2 + b^2}', appOpts],
      ['x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\\;\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', appOpts],
      ['\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}', { ...appOpts, displayMode: true }]
    ]) {
      const html = katex.renderToString(tex, opts)
      expect(html).toMatch(/class="katex/)
      expect(html).not.toMatch(/#cc0000/)
    }
  })

  test('malformed input renders the error color, never throws (throwOnError: false)', () => {
    for (const tex of ['\\frac{1}', '\\unknownthing{x}']) {
      const html = katex.renderToString(tex, appOpts)
      expect(html).toMatch(/#cc0000/)
    }
  })
})
