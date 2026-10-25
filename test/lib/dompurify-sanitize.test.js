/* eslint-env jest */

// Security regression for the server-side sanitizer. Until 2026-10-24 the
// wrapper handed DOMPurify a LinkeDOM window; DOMPurify never bound to it
// (isSupported undefined) and sanitize() returned hostile input UNCHANGED
// (<script> and onerror survived verbatim on dompurify 3.4.16 AND 3.4.17).
//
// The checks run in a child process under plain Node via tsx: jest 29's CJS
// sandbox cannot load jsdom 30's ESM-only @exodus/bytes transitives, but
// production (plain Node require) loads them natively — so the child
// exercises the REAL wrapper + REAL jsdom at production fidelity, and this
// harness asserts on its JSON verdict.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const runSanitizerChild = () => JSON.parse(execFileSync(
  path.join('node_modules', '.bin', 'tsx'),
  ['--tsconfig', 'jsconfig.json', path.join('test', 'helpers', 'sanitizer-child.mjs')],
  { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }
))

test('server sanitizer strips hostile markup, keeps reader markup, stays stable', () => {
  const out = runSanitizerChild()
  expect(out.results).toEqual({
    stripsHostile: true,
    keepsBenignImg: true,
    sanitizesUnderLexicalGlobals: true,
    singletonReused: true,
    idempotent: true,
    keepsReaderMarkup: true
  })
  // the exact regression: script tags and event handlers gone, benign kept
  expect(out.sample).toBe('<img src="x"><p>safe</p>')
})

test('per-call cost on an item-sized document stays interactive on shared runners', () => {
  const out = runSanitizerChild()
  // Magnitude guard, not a hard perf contract: catches order-of-magnitude
  // regressions (a jsdom path falling back to something quadratic). CI's
  // 2-core shared runners measured 57-104ms for this same code (2026-10-25),
  // so the ceiling must tolerate that noise or it fails on every run.
  expect(out.itemSizedBytes).toBeGreaterThan(50000)
  expect(out.itemSizedMs).toBeLessThan(500)
})
