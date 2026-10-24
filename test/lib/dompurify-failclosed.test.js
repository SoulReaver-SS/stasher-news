/* eslint-env jest */

// Fail-closed unit test for the sanitizer guard: a DOMPurify instance that
// reports itself unsupported must make sanitization THROW — the pre-fix
// behavior (returning input unchanged, silently) is the vulnerability this
// module closes. Mocked at the dompurify module boundary; no jsdom needed.

describe('server sanitizer fail-closed guard', () => {
  let sanitizeHTML

  beforeEach(() => {
    jest.resetModules()
    // keep the jsdom require inside getServerDOMPurify loadable under jest
    // (its ESM-only transitives cannot load in the sandbox); the window is
    // inert — the mocked dompurify factory below rejects it as unsupported
    jest.mock('jsdom', () => ({ JSDOM: function () { return { window: {} } } }))
    jest.mock('dompurify', () => {
      // plain module.exports = factory (no __esModule wrapper): lib/dompurify
      // calls require('dompurify')(...) directly
      const unsupported = { isSupported: false, sanitize: jest.fn(dirty => dirty) }
      const factory = jest.fn(() => unsupported)
      return factory
    })
    ;({ sanitizeHTML } = require('../../lib/dompurify'))
  })

  afterEach(() => {
    jest.dontMock('dompurify')
    jest.dontMock('jsdom')
  })

  test('throws instead of returning unsanitized HTML when the sanitizer DOM is unsupported', () => {
    expect(() => sanitizeHTML('<p>safe</p>'))
      .toThrow(/server sanitizer unsupported — refusing to return unsanitized HTML/)
  })
})
