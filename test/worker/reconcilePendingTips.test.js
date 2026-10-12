/* eslint-env jest */
import { randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519'
import { runReconcilePendingTipsOnce } from '@/worker/reconcilePendingTips'
import { RECONCILE_PENDING_AGE_MS } from '@/lib/constants'
import { alert } from '@/lib/alert'
import { moneroTipsRecoveredTotal, moneroTipsExpiredTotal } from '@/lib/metrics'
import { encryptViewKey } from '@/api/monero/viewkey'
import { maskFromTxPubKey, xorWithMask } from '@/api/monero/pidDecrypt'
import { createDaemonClient } from '@/api/monero/daemonClient'
import { createReconciliationRawReader } from '@/worker/reconciliationRawTransactions'

// lib/alert is mocked so operator pages are assertable without a network side
// effect (reverseStaleDetections.test.js pattern).
jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))

// The raw-decrypt fallback fixtures encrypt a recipient view key, which
// requires VIEWKEY_MASTER_KEY. CI doesn't set one — provide a dummy (32
// bytes, base64) so ensureLoaded() succeeds; these tests assert the
// recovery flow, not key material (lwsClient.test.js pattern).
process.env.VIEWKEY_MASTER_KEY = Buffer.from('a'.repeat(32)).toString('base64')

beforeEach(() => { jest.clearAllMocks() })

const STALE = new Date(Date.now() - (RECONCILE_PENDING_AGE_MS + 60_000))
const FRESH = new Date()

function tip (overrides) {
  return {
    id: 1n,
    postId: 42,
    paymentId: 'aabbccdd11223344',
    recipientAccountId: 7,
    piconeros: 1000000000n,
    detectedAt: STALE,
    state: 'PENDING',
    post: { userId: 5 },
    ...overrides
  }
}

function tips (n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => tip({ id: BigInt(i + 1), ...overrides }))
}

test('recovers a PENDING tip whose payment_id appears in the lws re-scan (PENDING->DETECTED + applyTipDetected)', async () => {
  const t = tip({ id: 1n })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [
        { hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n }
      ],
      blockchain_height: 110
    })
  }
  let applied = null
  // Capture the txdb raw SQL (the exclusion tests' idiom) so the rank-delta
  // persistence UPDATE is assertable.
  const execs = []
  const models = {
    observedTip: {
      findMany: async () => [t],
      // the raw claim UPDATE returns 1 row affected (recovered)
      $executeRaw: async () => {}
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      // emulate the serializable tx: the raw UPDATE claims 1 row, then apply runs
      const txdb = {
        $executeRaw: async (...args) => {
          const q = args[0]
          execs.push({ sql: Array.isArray(q) ? q.join('') : q.text, vals: [...args].slice(1).flat() })
          return 1
        },
        observedTip: { update: async () => {} }
      }
      await fn(txdb)
      applied = true
    }
  }
  // applyTipDetected is imported by the worker from ranking.js; spy via its effect by
  // stubbing the module is heavier — instead assert the recovery count + that $transaction ran.
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => { applied = true; return 700000000n } })
  expect(out.recovered).toBe(1)
  expect(applied).toBe(true)
  // The applied rank delta is persisted on the tip row (exact reorg reversal).
  const rankSet = execs.find(e => e.sql.includes('"rankPiconeros"'))
  expect(rankSet).toBeDefined()
  expect(rankSet.vals).toContain(700000000n)
})

test('the DETECTED recovery claim stamps amountVerifiedAt (lws-scanned by construction)', async () => {
  const t = tip({ id: 1n })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [
        { hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n }
      ],
      blockchain_height: 110
    })
  }
  const execs = []
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async (...args) => {
          const q = args[0]
          execs.push({ sql: Array.isArray(q) ? q.join('') : q.text, vals: [...args].slice(1).flat() })
          return 1
        }
      })
    }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => 700000000n })
  expect(out.recovered).toBe(1)
  // The DETECTED claim is the lws binding: the recovered row must carry the
  // verified stamp so the credit path never re-binds (trust-corrects) it.
  const detected = execs.find(e => e.sql.includes("state = 'DETECTED'") && e.sql.includes("state = 'PENDING'"))
  expect(detected).toBeDefined()
  expect(detected.sql).toContain('"amountVerifiedAt" = NOW()')
})

test('the DETECTED recovery claim carries the duplicate-txHash guard (NOT EXISTS, global unique)', async () => {
  // Review follow-up: one tx = one credit (the global ObservedTip.txHash
  // unique). A hash already credited to another tip must lose the claim here
  // (0 rows) instead of violating the unique — the tip stays PENDING and
  // expires at PENDING_EXPIRY_MS like any never-paid tip (the webhook's
  // detection claim guards the same class).
  const t = tip({ id: 1n })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n }],
      blockchain_height: 110
    })
  }
  const execs = []
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async (...args) => {
          const q = args[0]
          execs.push({ sql: Array.isArray(q) ? q.join('') : q.text, vals: [...args].slice(1).flat() })
          return 1
        }
      })
    }
  }
  await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => 700000000n })
  const detected = execs.find(e => e.sql.includes("state = 'DETECTED'") && e.sql.includes("state = 'PENDING'"))
  expect(detected).toBeDefined()
  expect(detected.sql).toContain('NOT EXISTS')
  expect(detected.sql).toContain('o."txHash"')
  expect(detected.sql).toContain('o.id <>')
})

test('the EXCLUDED recovery claim folds a duplicate txHash (CASE guard) — the exclusion itself always completes', async () => {
  // The exclusion's effect is load-bearing (no ranking credit, AbuseSignal —
  // which keeps its own txHash copy); the row's txHash is informational. A
  // hash already credited to another tip is simply not re-stored, so the
  // claim can never violate the global unique.
  const t = tip({ id: 12n, tipperId: 5, post: { userId: 5 } })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [] }],
      blockchain_height: 110
    })
  }
  const execs = []
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async (...args) => {
          const q = args[0]
          execs.push({ sql: Array.isArray(q) ? q.join('') : q.text, vals: [...args].slice(1).flat() })
          return 1
        },
        $queryRaw: async () => [{ subName: null }],
        abuseSignal: { create: async () => {} }
      })
    }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(out.excluded).toBe(1)
  const excluded = execs.find(e => e.sql.includes("state = 'EXCLUDED'") && e.sql.includes("state = 'PENDING'"))
  expect(excluded).toBeDefined()
  expect(excluded.sql).toContain('CASE WHEN EXISTS')
  expect(excluded.sql).toContain('o."txHash"')
  expect(excluded.sql).toContain('o.id <>')
})

test('a unique-violation on the claim is folded into a clean no-op (deduped alert, tip not credited)', async () => {
  // Concurrent-race shape: two claims for different pids collide inside the
  // Serializable transaction despite the NOT EXISTS. The catch folds the
  // P2002 into the same clean refusal as the webhook's — alert deduped on the
  // hash (shared dedupeKey), tip not credited, run continues.
  const t = tip({ id: 1n })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n }],
      blockchain_height: 110
    })
  }
  let applied = false
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async (...args) => {
          const sql = Array.isArray(args[0]) ? args[0].join('') : args[0].text
          if (sql.includes("state = 'DETECTED'")) {
            throw Object.assign(new Error('Unique constraint failed on the fields: (`txHash`)'), { code: 'P2002' })
          }
          return 1
        }
      })
    }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => { applied = true } })
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
  expect(applied).toBe(false)
  expect(alert).toHaveBeenCalledWith('warn', 'tip txHash collision refused',
    expect.stringContaining('deadbeef'),
    expect.objectContaining({ dedupeKey: 'tip-collision-deadbeef' }))
})

test('a non-unique claim error still propagates (no blanket swallow)', async () => {
  const t = tip({ id: 1n })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n }],
      blockchain_height: 110
    })
  }
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async (...args) => {
          const sql = Array.isArray(args[0]) ? args[0].join('') : args[0].text
          if (sql.includes("state = 'DETECTED'")) throw new Error('connection reset')
          return 1
        }
      })
    }
  }
  await expect(runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} }))
    .rejects.toThrow('connection reset')
})

test('expires a PENDING tip with no matching payment after PENDING_EXPIRY_MS (-> EXPIRED)', async () => {
  const expiredDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000))
  const t = tip({ id: 2n, detectedAt: expiredDate })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {} }
  const lws = { getAddressTxs: async () => ({ transactions: [], blockchain_height: 110 }) }
  let expiredWhere = null
  const models = {
    observedTip: {
      findMany: async () => [t],
      updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(out.expired).toBe(1)
  expect(expiredWhere).toEqual({ id: 2n, state: 'PENDING' })
})

test('expires a PENDING tip older than 24h (PENDING_EXPIRY_MS default)', async () => {
  // 2 days is inside the old 7-day default but past the 24h default: unpaid
  // tips must not linger longer than downvote pid-maps or fee reservations.
  const expiredDate = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000))
  const t = tip({ id: 5n, detectedAt: expiredDate })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {} }
  const lws = { getAddressTxs: async () => ({ transactions: [], blockchain_height: 110 }) }
  let expiredWhere = null
  const models = {
    observedTip: {
      findMany: async () => [t],
      updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(out.expired).toBe(1)
  expect(expiredWhere).toEqual({ id: 5n, state: 'PENDING' })
})

test('never calls lws for an account without a viewKey, but still expires its PENDING tips (soft-deleted account)', async () => {
  const expiredDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000))
  const t = tip({ id: 4n, detectedAt: expiredDate })
  // Soft-deleted account: viewKey wiped + status INACTIVE (unregisterMoneroAccount).
  // Scanning it would throw in lws walletLogin and abort the whole run.
  const account = { id: 7, address: 'ADDR', viewKey: null, status: 'INACTIVE' }
  const lws = { getAddressTxs: jest.fn() }
  let expiredWhere = null
  const models = {
    observedTip: {
      findMany: async () => [t],
      updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(lws.getAddressTxs).not.toHaveBeenCalled()
  expect(out).toEqual({ recovered: 0, expired: 1, excluded: 0, pidFallback: 0 })
  expect(expiredWhere).toEqual({ id: 4n, state: 'PENDING' })
})

test('does NOT touch fresh PENDING tips (younger than RECONCILE_PENDING_AGE_MS)', async () => {
  const t = tip({ id: 3n, detectedAt: FRESH })
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: { getAddressTxs: async () => ({ transactions: [] }) }, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
})

test('recovers a PENDING direct self-tip as EXCLUDED (no apply, AbuseSignal written)', async () => {
  const t = tip({ id: 10n, tipperId: 5, post: { userId: 5 } }) // tipper === author
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [] }],
      blockchain_height: 110
    })
  }
  let applied = false
  let signalData = null
  // Capture BOTH the SQL text and the bound values: the exclusionReason is a
  // tagged-template BIND PARAM, so it never appears in the SQL text — only in
  // the call's trailing arguments.
  const execs = []
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      const txdb = {
        $executeRaw: async (...args) => {
          const q = args[0]
          execs.push({ sql: Array.isArray(q) ? q.join('') : q.text, vals: [...args].slice(1).flat() })
          return 1
        },
        $queryRaw: async () => [{ subName: null }],
        abuseSignal: { create: async ({ data }) => { signalData = data } }
      }
      await fn(txdb)
    }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => { applied = true } })
  expect(out.excluded).toBe(1)
  expect(out.recovered).toBe(0)
  expect(applied).toBe(false)
  const excluded = execs.find(e => e.sql.includes("state = 'EXCLUDED'") && e.sql.includes("state = 'PENDING'"))
  expect(excluded).toBeDefined()
  expect(excluded.sql).toContain('"TipExclusionReason"')
  expect(excluded.vals).toContain('DIRECT_SELF_TIP')
  expect(signalData).toMatchObject({ kind: 'SELF_TIP_EXCLUDED', subjectUserId: 5, actorUserId: 5, tipId: 10n, postId: 42 })
})

test('recovers a PENDING self-send (anon tip from the author registered wallet) as EXCLUDED', async () => {
  const t = tip({ id: 11n, tipperId: null, post: { userId: 5 } })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 0, min_i: 0 } }] }],
      blockchain_height: 110
    })
  }
  let applied = false
  let signalData = null
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      const txdb = {
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ subName: 'stasher' }],
        abuseSignal: { create: async ({ data }) => { signalData = data } }
      }
      await fn(txdb)
    }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => { applied = true } })
  expect(out.excluded).toBe(1)
  expect(applied).toBe(false)
  expect(signalData).toMatchObject({ kind: 'SELF_SEND_EXCLUDED', subName: 'stasher' })
})

test('a normal recovered tip still detects (exclusion check passes it through)', async () => {
  const t = tip({ id: 12n, tipperId: 6, post: { userId: 5 } })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 110
    })
  }
  let applied = false
  const models = {
    observedTip: { findMany: async () => [t] },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({ $executeRaw: async () => 1 })
    }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => { applied = true; return 700000000n } })
  expect(out.recovered).toBe(1)
  expect(out.excluded).toBe(0)
  expect(applied).toBe(true)
})

test('does NOT alert on a large pool of unpaid young tips (cry-wolf regression pin)', async () => {
  // 12 abandoned checkouts past reconcile age but inside the 24h expiry window:
  // nothing on chain, so nothing is recovered — no alert may fire.
  const t = tips(12)
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = { getAddressTxs: async () => ({ transactions: [], blockchain_height: 110 }) }
  const models = {
    observedTip: { findMany: async () => t, updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
  expect(alert).not.toHaveBeenCalled()
})

test('fires a warn alert when a small batch of tips is recovered (missed webhooks)', async () => {
  const t = tips(1)
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 110
    })
  }
  const models = {
    observedTip: { findMany: async () => t },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => { await fn({ $executeRaw: async () => 1 }) }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => 700000000n })
  expect(out.recovered).toBe(1)
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert).toHaveBeenCalledWith('warn', 'missed tip webhooks',
    expect.stringContaining('1 tips recovered by reconciliation scan'),
    { dedupeKey: 'missed-tip-webhooks' })
  expect(alert).not.toHaveBeenCalledWith('critical', expect.any(String), expect.any(String), expect.anything())
})

test('fires a critical alert when a large batch of tips is recovered (webhook outage)', async () => {
  // All 10 tips share the default paymentId; one matching tx recovers all 10
  // (each claim UPDATE returns 1, so recovered = 10 = CRITICAL threshold).
  const t = tips(10)
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 110
    })
  }
  const models = {
    observedTip: { findMany: async () => t },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => { await fn({ $executeRaw: async () => 1 }) }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => 700000000n })
  expect(out.recovered).toBe(10)
  expect(alert).toHaveBeenCalledWith('critical', 'missed tip webhooks',
    expect.stringContaining('10 tips recovered by reconciliation scan'),
    { dedupeKey: 'missed-tip-webhooks' })
})

test('run counters tick monero_tips_recovered_total / monero_tips_expired_total', async () => {
  moneroTipsRecoveredTotal.reset()
  moneroTipsExpiredTotal.reset()
  // One recoverable tip + one unpaid tip past the 24h expiry window
  // (unpaid = its paymentId is absent from the lws scan).
  const t = [
    tip({ id: 20n }),
    tip({ id: 21n, paymentId: 'ffffffffffffffff', detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  ]
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'AABBCCDD11223344', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 110
    })
  }
  const models = {
    observedTip: { findMany: async () => t, updateMany: async () => ({ count: 1 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => { await fn({ $executeRaw: async () => 1 }) }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => 700000000n })
  expect(out).toEqual({ recovered: 1, expired: 1, excluded: 0, pidFallback: 0 })
  expect((await moneroTipsRecoveredTotal.get()).values[0].value).toBe(1)
  expect((await moneroTipsExpiredTotal.get()).values[0].value).toBe(1)
})

// ---------------------------------------------------------------------------
// Wrong-pid fallback (lws shared-derivation pid misattribution; see
// internal incident notes). When both sender and recipient are
// lws-registered and the sender scans a tx first, lws stores/serves the
// SENDER-side pid decryption for the recipient's row: webhooks never fire and
// the primary pid-keyed reconcile match above finds nothing. The fallback
// fetches the raw tx from monerod and decrypts the encrypted pid with the
// RECIPIENT's view key (pidDecrypt.js), recovering the tip without lws.
// ---------------------------------------------------------------------------

const L_ORDER = ed25519.CURVE.n
const G_BASE = ed25519.ExtendedPoint.BASE

function randomScalarHexLE () {
  // wallet-grade scalar 1 <= s < l (Monero sc_check rejects >= l), LE hex
  const b = randomBytes(31)
  const bytes = Buffer.concat([b, Buffer.alloc(1)])
  let v = 0n
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i])
  v = (v % (L_ORDER - 2n)) + 1n
  const out = Buffer.alloc(32)
  let x = v
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out.toString('hex')
}

// Build the fixture for a two-account tip whose lws row carries the WRONG pid:
//  - viewKey envelope for a random recipient view key `a`
//  - raw tx extra whose encrypted pid decrypts (under 8*a*R) to `pidHex`
//  - a daemon fake serving that extra for `txHash`
function wrongPidFixture ({ pidHex, txHash, spentOutputs = [{ sender: { maj_i: 4, min_i: 2 } }] }) {
  const viewKeyHex = randomScalarHexLE()
  const rHex = randomScalarHexLE()
  const R = G_BASE.multiply(BigInt('0x' + Buffer.from(rHex, 'hex').reverse().toString('hex').padStart(64, '0')))
  const RBytes = Buffer.from(R.toRawBytes())
  const mask = maskFromTxPubKey(RBytes, viewKeyHex)
  const stored = xorWithMask(Buffer.from(pidHex, 'hex'), mask)
  const extra = Buffer.concat([
    Buffer.from([0x01, ...RBytes]),
    Buffer.from([0x02, 9, 0x01, ...stored])
  ])
  return {
    account: (over = {}) => ({ id: 7, address: 'ADDR', status: 'ACTIVE', subaddresses: [], ...over }),
    viewKey: encryptViewKey(viewKeyHex),
    daemon: { getTransactions: async () => [{ hash: txHash, extra }] },
    extra
  }
}

test('fallback recovers a PENDING tip when lws serves the sender-side pid (raw-decrypt with recipient view key)', async () => {
  const realPid = '661bf254912cb9f7' // the issued pid (HMAC-minted)
  const servedPid = 'd048685749d57220' // what lws stored (sender derivation)
  const t = tip({ id: 30n, paymentId: realPid, tipperId: 6 })
  const fx = wrongPidFixture({ pidHex: realPid, txHash: 'b9c84119f7275b39' })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'b9c84119f7275b39', height: 3216990, payment_id: servedPid, piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 3217000
    })
  }
  const execs = []
  let applied = false
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async (...args) => {
          const q = args[0]
          execs.push({ sql: Array.isArray(q) ? q.join('') : q.text, vals: [...args].slice(1).flat() })
          return 1
        },
        $queryRaw: async () => [{ subName: null }],
        abuseSignal: { create: async () => {} }
      })
    }
  }
  const out = await runReconcilePendingTipsOnce({
    models, lwsClient: lws, daemonClient: fx.daemon, apply: async () => { applied = true; return 700000000n }
  })
  expect(out).toEqual({ recovered: 1, expired: 0, excluded: 0, pidFallback: 1 })
  expect(applied).toBe(true)
  const detected = execs.find(e => e.sql.includes("state = 'DETECTED'"))
  expect(detected).toBeDefined()
  expect(detected.vals).toContain('b9c84119f7275b39')
  expect(alert).toHaveBeenCalledWith('warn', 'lws payment-id misattribution recovered',
    expect.stringContaining('1 tip(s) recovered by raw-decrypt fallback'),
    expect.objectContaining({ dedupeKey: 'lws-pid-misattribution' }))
})

test('fallback recovery goes through the self-send exclusion check (spent_outputs honored)', async () => {
  const realPid = 'a0211a0a2c1217c6'
  const servedPid = '871967eaeb0fa5e4'
  const t = tip({ id: 31n, paymentId: realPid, tipperId: null }) // anon tip
  const fx = wrongPidFixture({ pidHex: realPid, txHash: '780e241fe18f0543' })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      // self-send: a spent output owned by the recipient's own primary (0,0)
      transactions: [{ hash: '780e241fe18f0543', height: 3216991, payment_id: servedPid, piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 0, min_i: 0 } }] }],
      blockchain_height: 3217000
    })
  }
  let signalData = null
  let applied = false
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ subName: 'stasher' }],
        abuseSignal: { create: async ({ data }) => { signalData = data } }
      })
    }
  }
  const out = await runReconcilePendingTipsOnce({
    models, lwsClient: lws, daemonClient: fx.daemon, apply: async () => { applied = true; return 0n }
  })
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 1, pidFallback: 1 })
  expect(applied).toBe(false)
  expect(signalData).toMatchObject({ kind: 'SELF_SEND_EXCLUDED', paymentId: realPid })
})

test('daemon failure during the fallback does NOT expire unmatched tips (anti-strand)', async () => {
  // 2 days old, unmatched, and the raw-tx fetch fails: expiring now would
  // strand a possibly-paid tip; the next run retries.
  const t = tip({ id: 32n, detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const fx = wrongPidFixture({ pidHex: t.paymentId, txHash: 'deadbeef' })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'deadbeef', height: 100, payment_id: 'd048685749d57220', piconeros: 1000000000n, spent_outputs: [] }],
      blockchain_height: 110
    })
  }
  let expiredWhere = null
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } } },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const daemon = {
    getTransactions: async () => { throw new Error('monerod get_transactions unavailable') }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, daemonClient: daemon, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
  expect(expiredWhere).toBeNull()
  // Fixed category only — the transport message (which can embed view-key or
  // payload material for other failure classes) never reaches the alert.
  expect(alert).toHaveBeenCalledWith('warn', 'lws raw-decrypt fallback failed',
    expect.stringContaining('RAW_LOOKUP_FAILED'),
    expect.objectContaining({ dedupeKey: 'lws-pid-fallback-error' }))
  expect(alert.mock.calls.map(args => args.join(' ')).join('\n')).not.toContain('monerod get_transactions unavailable')
})

test.each([
  ['DAEMON_TIMEOUT', 'DAEMON_TIMEOUT'],
  ['RAW_SCAN_BUDGET_EXHAUSTED', 'RAW_SCAN_BUDGET_EXHAUSTED'],
  ['RAW_EVIDENCE_RESPONSE_INVALID', 'RAW_EVIDENCE_RESPONSE_INVALID'],
  ['SOME_UNKNOWN_CODE', 'RAW_LOOKUP_FAILED']
])('fallback failure alert surfaces only the fixed category for %s', async (code, expected) => {
  const t = tip({ id: 43n, detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'cafebabe', height: 100, payment_id: 'd048685749d57220', piconeros: 1000000000n, spent_outputs: [] }],
      blockchain_height: 110
    })
  }
  let expiredWhere = null
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } } },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const rawReader = {
    read: async () => {
      throw Object.assign(new Error(`sensitive-detail-${code}`), { code })
    }
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, rawReader, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
  expect(expiredWhere).toBeNull()
  expect(alert).toHaveBeenCalledWith('warn', 'lws raw-decrypt fallback failed',
    expect.stringContaining(expected), { dedupeKey: 'lws-pid-fallback-error' })
  const alerted = alert.mock.calls.map(args => args.join(' ')).join('\n')
  expect(alerted).not.toContain('sensitive-detail-')
  if (code !== expected) expect(alerted).not.toContain(code)
})

test('fallback that runs clean still expires genuinely unpaid tips', async () => {
  const t = tip({ id: 33n, paymentId: 'ffffffffffffffff', detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const fx = wrongPidFixture({ pidHex: '0000000000000000', txHash: 'cafebabe' })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      // one tx on the account whose (wrong) pid matches nothing we issued
      transactions: [{ hash: 'cafebabe', height: 100, payment_id: 'd048685749d57220', piconeros: 1000000000n, spent_outputs: [] }],
      blockchain_height: 110
    })
  }
  let expiredWhere = null
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } } },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, daemonClient: fx.daemon, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 1, excluded: 0, pidFallback: 0 })
  expect(expiredWhere).toEqual({ id: 33n, state: 'PENDING' })
})

test('a partial raw response recovers a proven tip but defers expiry of the unmatched remainder', async () => {
  // One candidate hash is answered, the other is missing. The proven tip is
  // recovered (missing evidence never blocks a cryptographic match), but the
  // still-unmatched expired-age tip must NOT be expired from a partial read.
  const realPid = '661bf254912cb9f7'
  const servedPid = 'd048685749d57220'
  const txHash = 'b9c84119f7275b39'
  const missingHash = 'cccc000000000000000000000000000000000000000000000000000000000000'
  const recoverable = tip({ id: 46n, paymentId: realPid, tipperId: 6 })
  const unpaid = tip({ id: 47n, paymentId: 'ffffffffffffffff', detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const fx = wrongPidFixture({ pidHex: realPid, txHash })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      transactions: [
        { hash: txHash, height: 3216990, payment_id: servedPid, piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] },
        { hash: missingHash, height: 100, payment_id: servedPid, piconeros: 1n, spent_outputs: [] }
      ],
      blockchain_height: 3217000
    })
  }
  let expiredWhere = null
  const models = {
    observedTip: {
      findMany: async () => [recoverable, unpaid],
      updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => { await fn({ $executeRaw: async () => 1 }) }
  }
  const daemon = { getTransactions: async () => [{ hash: txHash, extra: fx.extra }] }
  const rawReader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, rawReader, apply: async () => 700000000n })
  expect(out).toEqual({ recovered: 1, expired: 0, excluded: 0, pidFallback: 1 })
  expect(expiredWhere).toBeNull()
  expect(alert).toHaveBeenCalledWith(
    'warn', 'lws raw-decrypt fallback incomplete', expect.any(String),
    expect.objectContaining({ dedupeKey: 'lws-pid-fallback-incomplete-7' })
  )
})

test('zero raw candidates is a complete pass with no RPC (unpaid tips still expire)', async () => {
  const t = tip({ id: 52n, paymentId: 'ffffffffffffffff', detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = { getAddressTxs: async () => ({ transactions: [], blockchain_height: 110 }) }
  let expiredWhere = null
  const models = {
    observedTip: {
      findMany: async () => [t],
      updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const rawReader = { read: jest.fn(async () => { throw new Error('must not be called') }) }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, rawReader, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 1, excluded: 0, pidFallback: 0 })
  expect(expiredWhere).toEqual({ id: 52n, state: 'PENDING' })
  expect(rawReader.read).not.toHaveBeenCalled()
})

test('account-local freshness: a warm reader re-joins cached raw bytes to the CURRENT lws row', async () => {
  // The reader caches only the public `extra` bytes. Height/amount/spent
  // metadata must keep coming from the fresh lws scan row, or a stale amount
  // could be credited (or a fresh self-send missed).
  const realPid = '661bf254912cb9f7'
  const servedPid = 'd048685749d57220'
  const txHash = 'b9c84119f7275b39'
  const fx = wrongPidFixture({ pidHex: realPid, txHash })
  const account = fx.account({ viewKey: fx.viewKey })
  const daemon = { getTransactions: jest.fn(async () => [{ hash: txHash, extra: fx.extra }]) }
  const rawReader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })
  const row = over => ({
    hash: txHash,
    height: 100,
    payment_id: servedPid,
    piconeros: 1000000000n,
    spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }],
    ...over
  })

  // Run 1 (cold): reads and caches the raw bytes. Nothing matches; complete
  // evidence lets the decoy's stale unpaid tip expire.
  const decoy = tip({ id: 48n, paymentId: 'ffffffffffffffff', detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const models1 = {
    observedTip: { findMany: async () => [decoy], updateMany: async () => ({ count: 1 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const first = await runReconcilePendingTipsOnce({
    models: models1,
    lwsClient: { getAddressTxs: async () => ({ transactions: [row()], blockchain_height: 110 }) },
    rawReader,
    apply: async () => {}
  })
  expect(first).toEqual({ recovered: 0, expired: 1, excluded: 0, pidFallback: 0 })
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)

  // Run 2 (warm): lws serves CHANGED height/amount for the same tx; the claim
  // must bind the fresh row, not any remembered metadata.
  const fresh = tip({ id: 49n, paymentId: realPid, tipperId: 6 })
  const execs = []
  const models2 = {
    observedTip: { findMany: async () => [fresh], updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async (...args) => {
          const q = args[0]
          execs.push({ sql: Array.isArray(q) ? q.join('') : q.text, vals: [...args].slice(1).flat() })
          return 1
        }
      })
    }
  }
  const lws2 = { getAddressTxs: async () => ({ transactions: [row({ height: 222, piconeros: 2500000000n })], blockchain_height: 300 }) }
  const second = await runReconcilePendingTipsOnce({ models: models2, lwsClient: lws2, rawReader, apply: async () => 700000000n })
  expect(second).toEqual({ recovered: 1, expired: 0, excluded: 0, pidFallback: 1 })
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1) // warm cache: no second RPC
  const detected = execs.find(e => e.sql.includes("state = 'DETECTED'") && e.sql.includes("state = 'PENDING'"))
  expect(detected).toBeDefined()
  expect(detected.vals).toContain(222)
  expect(detected.vals).toContain(2500000000n)

  // Restart: a new reader starts cold and refetches; the safety verdict is
  // unchanged, only the RPC count moves.
  const restarted = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })
  const third = await runReconcilePendingTipsOnce({ models: models2, lwsClient: lws2, rawReader: restarted, apply: async () => 700000000n })
  expect(third).toEqual({ recovered: 1, expired: 0, excluded: 0, pidFallback: 1 })
  expect(daemon.getTransactions).toHaveBeenCalledTimes(2)
})

test('a hash removed from the current lws scan cannot mint a receipt from cached raw bytes', async () => {
  const realPid = '661bf254912cb9f7'
  const servedPid = 'd048685749d57220'
  const txHash = 'b9c84119f7275b39'
  const fx = wrongPidFixture({ pidHex: realPid, txHash })
  const account = fx.account({ viewKey: fx.viewKey })
  const daemon = { getTransactions: jest.fn(async () => [{ hash: txHash, extra: fx.extra }]) }
  const rawReader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })
  const read = jest.spyOn(rawReader, 'read')

  // Run 1: the current scan anchors the tx, so its extra enters the cache.
  const decoy = tip({ id: 60n, paymentId: 'ffffffffffffffff', detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const models1 = {
    observedTip: { findMany: async () => [decoy], updateMany: async () => ({ count: 1 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const lws1 = {
    getAddressTxs: async () => ({
      transactions: [{ hash: txHash, height: 3216990, payment_id: servedPid, piconeros: 1000000000n, spent_outputs: [] }],
      blockchain_height: 3217000
    })
  }
  const first = await runReconcilePendingTipsOnce({ models: models1, lwsClient: lws1, rawReader, apply: async () => {} })
  expect(first).toEqual({ recovered: 0, expired: 1, excluded: 0, pidFallback: 0 })
  expect(read).toHaveBeenCalledTimes(1)

  // Run 2: lws no longer serves the row. The cached extra still decrypts to
  // realPid, but with no current row to anchor it, no receipt may be built.
  const trap = tip({ id: 61n, paymentId: realPid })
  const claimed = []
  const models2 = {
    observedTip: { findMany: async () => [trap], updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const lws2 = { getAddressTxs: async () => ({ transactions: [], blockchain_height: 3217000 }) }
  const second = await runReconcilePendingTipsOnce({
    models: models2, lwsClient: lws2, rawReader, apply: async () => { claimed.push(trap.id) }
  })
  expect(second).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
  expect(claimed).toEqual([])
  expect(read).toHaveBeenCalledTimes(1) // zero candidates: the cache is never re-read
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1) // only the warming read
})

test('raw acquisition summary logs counts only — no hashes, keys, or payloads', async () => {
  const realPid = '661bf254912cb9f7'
  const servedPid = 'd048685749d57220'
  const txHash = 'b9c84119f7275b39'
  const missingHash = 'cccc000000000000000000000000000000000000000000000000000000000000'
  const t = tip({ id: 45n, paymentId: realPid, tipperId: 6 })
  const fx = wrongPidFixture({ pidHex: realPid, txHash })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      transactions: [
        { hash: txHash, height: 3216990, payment_id: servedPid, piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] },
        { hash: missingHash, height: 100, payment_id: servedPid, piconeros: 1n, spent_outputs: [] }
      ],
      blockchain_height: 3217000
    })
  }
  const daemon = { getTransactions: async () => [{ hash: txHash, extra: fx.extra }] }
  const rawReader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async () => ({ count: 0 }) },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => { await fn({ $executeRaw: async () => 1 }) }
  }
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, rawReader, apply: async () => 700000000n })
    expect(out).toEqual({ recovered: 1, expired: 0, excluded: 0, pidFallback: 1 })
    const logged = log.mock.calls.map(args => args.join(' ')).join('\n')
    expect(logged).toContain('requested=2')
    expect(logged).toContain('fetched=1')
    expect(logged).toContain('missing=1')
    expect(logged).not.toContain(txHash)
    expect(logged).not.toContain(missingHash)
    expect(logged).not.toContain(servedPid)
    expect(logged).not.toContain(realPid)
  } finally {
    log.mockRestore()
  }
})

test('fallback is skipped entirely when no daemon is injected (legacy callers keep today\'s behavior)', async () => {
  const t = tip({ id: 34n, detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)) })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = { getAddressTxs: async () => ({ transactions: [], blockchain_height: 110 }) }
  let expiredWhere = null
  const models = {
    observedTip: { findMany: async () => [t], updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } } },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 1, excluded: 0, pidFallback: 0 })
  expect(expiredWhere).toEqual({ id: 34n, state: 'PENDING' })
})

test('chunked fallback recovers a wrong-pid tip on an account with >100 transactions (no silent cap failure)', async () => {
  const realPid = '661bf254912cb9f7'
  const servedPid = 'd048685749d57220'
  const txHash = 'aaaa000000000000000000000000000000000000000000000000000000000000'
  const t = tip({
    id: 40n,
    paymentId: realPid,
    tipperId: 6,
    detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000))
  })
  const fx = wrongPidFixture({ pidHex: realPid, txHash })
  const account = fx.account({ viewKey: fx.viewKey })
  // 153 unrelated historical txs + the misattributed one = 154 candidates:
  // over monerod restricted mode's 100-hash cap, so the pre-fix client sent
  // ONE oversized request and got a silent [] -> the tip expired (2026-09-15).
  const history = Array.from({ length: 153 }, (_, i) => ({
    hash: 'bbbb' + i.toString(16).padStart(60, '0'),
    height: 100 + i,
    payment_id: 'ffff' + i.toString(16).padStart(12, '0'),
    piconeros: 1000000000n,
    spent_outputs: []
  }))
  history.push({
    hash: txHash,
    height: 3216990,
    payment_id: servedPid,
    piconeros: 1000000000n,
    spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }]
  })
  const lws = {
    getAddressTxs: async () => ({ transactions: history, blockchain_height: 3217000 })
  }
  const requests = []
  const transport = async (url, { body }) => {
    const { txs_hashes: batch } = JSON.parse(body)
    requests.push(batch.length)
    if (batch.length > 100) {
      // the pre-fix cap response shape: HTTP 200, status message, NO txs array
      return { status: 200, ok: true, text: async () => JSON.stringify({ status: 'Too many transactions requested in restricted mode' }) }
    }
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        status: 'OK',
        // Genuine full evidence: every requested hash is answered (empty extra
        // for the unrelated history), so this run is COMPLETE. An omission
        // here would make the fixture silently incomplete and unable to assert
        // exhaustive expiry safety.
        txs: batch.map(h => ({
          tx_hash: h,
          as_json: JSON.stringify({ extra: h === txHash ? Array.from(fx.extra) : [] })
        }))
      })
    }
  }
  const daemon = createDaemonClient({ daemonUrl: 'http://monerod:38081', transport })
  // Fresh reader: module-level singleton cache state must not hide requests.
  const rawReader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })
  let expiredWhere = null
  let applied = false
  const models = {
    observedTip: {
      findMany: async () => [t],
      updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => { await fn({ $executeRaw: async () => 1 }) }
  }
  const out = await runReconcilePendingTipsOnce({
    models,
    lwsClient: lws,
    rawReader,
    apply: async () => { applied = true; return 700000000n }
  })
  expect(out).toEqual({ recovered: 1, expired: 0, excluded: 0, pidFallback: 1 })
  expect(applied).toBe(true)
  expect(expiredWhere).toBeNull()
  // acceptance criterion: no /get_transactions request exceeds the 100-hash cap
  expect(requests.every(n => n <= 100)).toBe(true)
  expect(requests).toEqual([50, 50, 50, 4])
})

test('a non-empty candidate list with zero raw evidence is incomplete: expiry deferred, no updateMany', async () => {
  // A non-empty candidate list answered with NO usable raw records is the
  // exact shape a lookup failure takes (restricted-cap [] or a shrunken
  // response). Missing evidence is not proof of nonpayment: the tip must stay
  // PENDING and the next 2-min run retries — never expire on incomplete data.
  const t = tip({
    id: 41n,
    paymentId: 'ffffffffffffffff',
    detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000))
  })
  const account = { id: 7, address: 'ADDR', status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: 'cafebabe', height: 100, payment_id: 'd048685749d57220', piconeros: 1000000000n, spent_outputs: [] }],
      blockchain_height: 110
    })
  }
  let expiredWhere = null
  const models = {
    observedTip: {
      findMany: async () => [t],
      updateMany: async ({ where }) => { expiredWhere = where; return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async () => {}
  }
  const daemon = { getTransactions: async () => [] }
  const rawReader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })
  const out = await runReconcilePendingTipsOnce({ models, lwsClient: lws, rawReader, apply: async () => {} })
  expect(out).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
  expect(expiredWhere).toBeNull()
  expect(alert).toHaveBeenCalledWith(
    'warn', 'lws raw-decrypt fallback incomplete', expect.any(String),
    expect.objectContaining({ dedupeKey: 'lws-pid-fallback-incomplete-7' })
  )
})

test('a malformed raw extra is missing evidence: expiry deferred, then refetched once corrected', async () => {
  // Finding 1 end-to-end: '01zz' used to be silently truncated by
  // Buffer.from(hex) into [0x01], so the daemonClient returned a "valid"
  // Buffer, the reader counted the hash as available, the pass reported
  // COMPLETE, and an unmatched, expired-age tip was EXPIRED off a malformed
  // acquisition — and the malformed bytes then served from cache. After the
  // fix the record is omitted (hash missing -> incomplete -> deferral), and a
  // later read with corrected bytes must hit the RPC again.
  const realPid = '661bf254912cb9f7'
  const servedPid = 'd048685749d57220'
  const txHash = 'b9c84119f7275b39'
  const t = tip({
    id: 50n,
    paymentId: realPid,
    tipperId: 6,
    detectedAt: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000))
  })
  const fx = wrongPidFixture({ pidHex: realPid, txHash })
  const account = fx.account({ viewKey: fx.viewKey })
  const lws = {
    getAddressTxs: async () => ({
      transactions: [{ hash: txHash, height: 3216990, payment_id: servedPid, piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
      blockchain_height: 3217000
    })
  }
  const requestedHashes = []
  let malformed = true
  const transport = async (url, { body }) => {
    const { txs_hashes: batch } = JSON.parse(body)
    requestedHashes.push(...batch)
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        status: 'OK',
        txs: batch.map(h => ({
          tx_hash: h,
          as_json: JSON.stringify({ extra: malformed ? '01zz' : Array.from(fx.extra) })
        }))
      })
    }
  }
  const daemon = createDaemonClient({ daemonUrl: 'http://monerod:38081', transport })
  const rawReader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })
  const expiredWheres = []
  const models = {
    observedTip: {
      findMany: async () => [t],
      updateMany: async ({ where }) => { expiredWheres.push(where); return { count: 1 } }
    },
    moneroAccount: { findMany: async () => [account] },
    $transaction: async (fn) => {
      await fn({
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ subName: null }],
        abuseSignal: { create: async () => {} }
      })
    }
  }

  const first = await runReconcilePendingTipsOnce({
    models, lwsClient: lws, rawReader, apply: async () => { throw new Error('must not apply') }
  })
  expect(first).toEqual({ recovered: 0, expired: 0, excluded: 0, pidFallback: 0 })
  expect(expiredWheres).toEqual([]) // no EXPIRED updateMany off malformed evidence
  expect(alert).toHaveBeenCalledWith(
    'warn', 'lws raw-decrypt fallback incomplete', expect.any(String),
    expect.objectContaining({ dedupeKey: 'lws-pid-fallback-incomplete-7' })
  )
  expect(requestedHashes).toEqual([txHash])

  // Corrected acquisition: the malformed response warmed nothing, so the same
  // hash is fetched again and now recovers the tip.
  malformed = false
  const second = await runReconcilePendingTipsOnce({
    models, lwsClient: lws, rawReader, apply: async () => 700000000n
  })
  expect(second).toEqual({ recovered: 1, expired: 0, excluded: 0, pidFallback: 1 })
  expect(requestedHashes).toEqual([txHash, txHash])
  expect(expiredWheres).toEqual([])
})
