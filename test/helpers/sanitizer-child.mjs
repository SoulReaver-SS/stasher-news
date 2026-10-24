// Runs in a child process under plain Node via tsx — the same module system
// production uses — because jest 29's CJS sandbox cannot load jsdom 30's
// ESM-only @exodus/bytes transitives ("Must use import to load ES Module").
// The jest test that spawns this file (test/lib/dompurify-sanitize.test.js)
// asserts on the JSON verdict printed here, so the retained coverage
// exercises the REAL wrapper + REAL jsdom at real runtime fidelity.
const lib = await import('@/lib/dompurify')
const { sanitizeHTML, getDOMPurify } = lib
const { withDOM } = await import('@/lib/lexical/server/dom')

const hostile = '<img src=x onerror=alert(1)><script>alert(1)</script><p>safe</p>'
const rich = [
  '<h2 id="anchor-1">heading</h2>',
  '<p>text with <a href="https://example.com/a" rel="noopener nofollow noreferrer" target="_blank">a link</a> and <strong>bold</strong></p>',
  '<span data-sn-media-kind="image" data-sn-media-src="https://example.com/i.png"><img src="https://example.com/i.png" srcset="https://example.com/i.png 1x" alt="alt text" loading="lazy"></span>',
  '<span data-lexical-user-mention="true" data-lexical-user-mention-name="nym">@nym</span>',
  '<sup data-lexical-footnote-ref="true"><a href="#fn-1" aria-label="back to reference 1">1</a></sup>'
].join('')

const results = {}

const clean = sanitizeHTML(hostile)
results.stripsHostile = !/<script|onerror\s*=/i.test(clean) && /safe/.test(clean)
results.keepsBenignImg = /<img[^>]*src="x"/.test(clean)

const nested = withDOM(() => sanitizeHTML(hostile))
results.sanitizesUnderLexicalGlobals = !/<script|onerror\s*=/i.test(nested) && /safe/.test(nested)

const first = getDOMPurify()
const second = getDOMPurify()
results.singletonReused = first === second && typeof second.sanitize === 'function'
const once = sanitizeHTML(hostile)
results.idempotent = sanitizeHTML(once) === once

const cleanRich = sanitizeHTML(rich)
results.keepsReaderMarkup = [
  /id="anchor-1"/, /href="https:\/\/example\.com\/a"/, /rel="noopener nofollow noreferrer"/,
  /<strong>bold<\/strong>/, /data-sn-media-kind="image"/, /srcset="https:\/\/example\.com\/i\.png 1x"/,
  /loading="lazy"/, /data-lexical-user-mention-name="nym"/, /aria-label="back to reference 1"/
].every(re => re.test(cleanRich))

// rough per-call cost on a representative item-sized document, reported for
// the perf record (not asserted — informational)
const itemSized = rich.repeat(120)
sanitizeHTML(itemSized)
const t0 = process.hrtime.bigint()
sanitizeHTML(itemSized)
const ms = Number(process.hrtime.bigint() - t0) / 1e6

const pass = Object.values(results).every(v => v === true)
console.log(JSON.stringify({ pass, results, sample: clean, itemSizedMs: Math.round(ms * 10) / 10, itemSizedBytes: itemSized.length }))
if (!pass) process.exit(1)
