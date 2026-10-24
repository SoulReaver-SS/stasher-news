/* eslint-env jest */
import { runReverseStaleDetectionsOnce } from '@/worker/reverseStaleDetections'
import { reverseBoostDetected } from '@/worker/rewardsWalletObserver'
import { reverseDownvotePenalty } from '@/api/monero/downvote'
import { alert } from '@/lib/alert'
import { STALE_DETECTED_EXPIRY_MS } from '@/lib/constants'

// The worker imports reverseBoostDetected from the observer directly (only
// reverseTip is DI'd), so the BOOST reversal is assertable only by mocking the
// observer at the module boundary (webhook.test.js pattern — also keeps the
// observer's heavier module graph out of jest). lib/alert is mocked so operator
// pages are assertable without a network side effect.
jest.mock(`${process.cwd()}/worker/rewardsWalletObserver`, () => ({
  reverseBoostDetected: jest.fn().mockResolvedValue(undefined)
}))
jest.mock(`${process.cwd()}/api/monero/downvote`, () => ({
  reverseDownvotePenalty: jest.fn().mockResolvedValue(undefined)
}))
jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))

beforeEach(() => { jest.clearAllMocks() })

const STALE = new Date(Date.now() - (STALE_DETECTED_EXPIRY_MS + 60_000))
const FRESH = new Date()

function tipRow (overrides) {
  return {
    id: 1n,
    postId: 42,
    tipperId: 5,
    paymentId: 'aabb',
    piconeros: 1000000000n,
    rankPiconeros: 700000000n,
    height: null,
    detectedAt: STALE,
    state: 'DETECTED',
    webhookEventId: 'w1',
    ...overrides
  }
}

function claimTx (execs) {
  return {
    $executeRaw: async (...args) => { execs.push({ sql: args[0], vals: args.slice(1) }); return 1 },
    $queryRaw: async (...args) => { execs.push({ sql: args[0], vals: args.slice(1) }); return [{ id: 42 }] },
    feeObservation: { count: async () => 0 },
    observedSubFee: { count: async () => 0 },
    payIn: { findUnique: async () => null },
    item: { findUnique: async () => ({ id: 42, parentId: null }) }
  }
}

test('claims a stale NULL-height DETECTED tip REORGED and reverses it with the stored rank delta', async () => {
  const execs = []
  const reversals = []
  const models = {
    observedTip: {
      findMany: async () => [tipRow({ id: 1n })],
      findFirst: async () => null
    },
    observedDownvote: { findMany: async () => [], findFirst: async () => null },
    feeObservation: { findMany: async () => [] },
    observedSubFee: { findMany: async () => [] },
    item: { findUnique: async () => ({ id: 42, parentId: null }) },
    $transaction: async (fn) => { await fn(claimTx(execs)) }
  }
  const monero = { deleteWebhook: async () => {} }
  const out = await runReverseStaleDetectionsOnce({
    models,
    monero,
    reverse: async (...args) => { reversals.push(args) }
  })
  expect(out.tips).toBe(1)
  const claim = execs.find(e => String(e.sql).includes("state = 'REORGED'"))
  expect(claim).toBeDefined()
  expect(reversals).toEqual([[42, 5, 1000000000n, 700000000n, expect.anything()]])
})

test('skips rows with a height (they may still confirm) and fresh rows', async () => {
  const models = {
    observedTip: {
      // mock normalization (see report): emulate the DB applying the scan's
      // where clause, so height-set/fresh rows never reach the sweep loop and
      // a missing height/detectedAt term in the where fails this test loudly
      findMany: async ({ where }) => [tipRow({ id: 2n, height: 900 }), tipRow({ id: 3n, detectedAt: FRESH })]
        .filter(r => r.state === where.state &&
          (where.height === null ? r.height === null : true) &&
          (where.detectedAt?.lt ? r.detectedAt < where.detectedAt.lt : true)),
      findFirst: async () => null
    },
    observedDownvote: { findMany: async () => [], findFirst: async () => null },
    feeObservation: { findMany: async () => [] },
    observedSubFee: { findMany: async () => [] },
    $transaction: async (fn) => { await fn(claimTx([])) }
  }
  const out = await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => { throw new Error('must not reverse') } })
  expect(out.tips).toBe(0)
})

test('a lost claim (concurrent webhook advanced the row) reverses nothing', async () => {
  const execs = []
  const models = {
    observedTip: {
      findMany: async () => [tipRow({ id: 4n })],
      findFirst: async () => null
    },
    observedDownvote: { findMany: async () => [], findFirst: async () => null },
    feeObservation: { findMany: async () => [] },
    observedSubFee: { findMany: async () => [] },
    $transaction: async (fn) => {
      const tx = { ...claimTx(execs), $executeRaw: async (...args) => { execs.push(args[0]); return 0 } }
      await fn(tx)
    }
  }
  const out = await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => { throw new Error('must not reverse') } })
  expect(out.tips).toBe(0)
})

// --- ObservedDownvote (penalty applied ONLY by the NULL->height transition,
// so only height-set DETECTED rows have something to reverse) ---

// Emulates the DB applying the scan's WHERE clause so a missing/incorrect
// height term in the sweep fails these tests loudly (mock normalization, same
// idiom as the tip "skips rows with a height" test above).
function filterDownvotes (rows, where) {
  return rows.filter(r =>
    r.state === where.state &&
    (where.height === null
      ? r.height === null
      : where.height?.not === null
        ? r.height !== null
        : true) &&
    (where.detectedAt?.lt ? r.detectedAt < where.detectedAt.lt : true))
}

function downvoteRow (overrides) {
  return {
    id: 7n,
    postId: 42,
    downvoterId: 5,
    paymentId: 'dd01',
    piconeros: 1000000000n,
    height: null,
    detectedAt: STALE,
    state: 'DETECTED',
    ...overrides
  }
}

test('a stale NULL-height DETECTED downvote is NOT reversed (no penalty was ever applied)', async () => {
  const execs = []
  const models = {
    observedTip: { findMany: async () => [], findFirst: async () => null },
    observedDownvote: {
      findMany: async ({ where }) => filterDownvotes([downvoteRow({ height: null })], where),
      findFirst: async () => null
    },
    feeObservation: { findMany: async () => [] },
    observedSubFee: { findMany: async () => [] },
    $transaction: async (fn) => { await fn(claimTx(execs)) }
  }
  const out = await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(out.downvotes).toBe(0)
  expect(reverseDownvotePenalty).not.toHaveBeenCalled()
  expect(execs.map(e => String(e.sql)).some(s => s.includes('"ObservedDownvote"') && s.includes("state = 'REORGED'"))).toBe(false)
})

test('a stale DETECTED downvote whose penalty WAS applied (verified height set) is reversed', async () => {
  const execs = []
  const models = {
    observedTip: { findMany: async () => [], findFirst: async () => null },
    observedDownvote: {
      findMany: async ({ where }) => filterDownvotes([downvoteRow({ height: 2186635 })], where),
      findFirst: async () => null
    },
    feeObservation: { findMany: async () => [] },
    observedSubFee: { findMany: async () => [] },
    $transaction: async (fn) => { await fn(claimTx(execs)) }
  }
  const out = await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(out.downvotes).toBe(1)
  expect(reverseDownvotePenalty).toHaveBeenCalledTimes(1)
  expect(reverseDownvotePenalty).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ id: 42 }),
    5,
    1000000000n
  )
  const claim = execs.map(e => String(e.sql)).find(s => s.includes('"ObservedDownvote"') && s.includes("state = 'REORGED'"))
  expect(claim).toContain('height IS NOT NULL')
})

test('fee reversal soft-deletes the live item only when NO CONFIRMED receipt exists', async () => {
  const execs = []
  let confirmedCount = 0
  const models = {
    observedTip: { findMany: async () => [], findFirst: async () => null },
    observedDownvote: { findMany: async () => [], findFirst: async () => null },
    feeObservation: {
      findMany: async () => [{ id: 1n, payInId: 10, postId: 42, piconeros: 2500000000n, height: null, detectedAt: STALE, state: 'DETECTED' }]
    },
    observedSubFee: { findMany: async () => [] },
    $transaction: async (fn) => {
      const tx = {
        $executeRaw: async (...args) => { execs.push(args[0]); return 1 },
        $queryRaw: async (sql) => { execs.push(sql); return [{ id: 42 }] },
        feeObservation: { count: async () => confirmedCount },
        observedSubFee: { count: async () => 0 }
      }
      await fn(tx)
    }
  }
  const out = await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(out.fees).toBe(1)
  expect(out.itemsAbandoned).toBe(1)
  const del = execs.map(String).find(s => s.includes('*deleted — fee never confirmed*'))
  expect(del).toBeDefined()

  // now the confirmed-receipt case: item must NOT be deleted
  confirmedCount = 1
  execs.length = 0
  const out2 = await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(out2.fees).toBe(1)
  expect(out2.itemsAbandoned).toBe(0)
  expect(execs.map(String).find(s => s.includes('*deleted — fee never confirmed*'))).toBeUndefined()
})

// --- platform-routed BOOST + TERRITORY_* fee legs (FeeObservation branch) ---

function feeRow (overrides) {
  return {
    id: 1n,
    payInId: 10,
    postId: 42,
    piconeros: 2500000000n,
    height: null,
    detectedAt: STALE,
    state: 'DETECTED',
    ...overrides
  }
}

function feeModels ({ fee, confirmedCount = 0, payIn = null, claimResult = 1 } = {}) {
  const subUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
  const tx = {
    $executeRaw: async () => claimResult,
    $queryRaw: async () => [],
    feeObservation: { count: async () => confirmedCount },
    observedSubFee: { count: async () => 0 },
    payIn: { findUnique: async () => payIn },
    sub: { updateMany: subUpdateMany }
  }
  const models = {
    observedTip: { findMany: async () => [], findFirst: async () => null },
    observedDownvote: { findMany: async () => [], findFirst: async () => null },
    feeObservation: { findMany: async () => [fee] },
    observedSubFee: { findMany: async () => [] },
    $transaction: async (fn) => { await fn(tx) }
  }
  return { models, tx, subUpdateMany }
}

test('a stale platform-routed BOOST fee reverses its boost weight via reverseBoostDetected', async () => {
  const payIn = { id: 10, payInType: 'BOOST' }
  const { models, tx } = feeModels({ fee: feeRow({ feeType: 'BOOST' }), payIn })
  await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(reverseBoostDetected).toHaveBeenCalledTimes(1)
  expect(reverseBoostDetected).toHaveBeenCalledWith(tx, payIn, 2500000000n)
})

test('a stale POSTING fee never touches boost weight (undefined feeType stays on the old path)', async () => {
  const { models } = feeModels({ fee: feeRow({ feeType: 'POSTING' }), payIn: { id: 10, payInType: 'ITEM_CREATE' } })
  await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(reverseBoostDetected).not.toHaveBeenCalled()
})

// Integrated (PID-bound) receipts bump boosts and open gates only at the
// verified height transition, so a stale height-NULL one applied nothing:
// it goes REORGED with no boost/territory/item side effect.
test.each(['BOOST', 'TERRITORY_BILLING', 'POSTING'])('a stale integrated %s receipt is ledger-only on reversal', async feeType => {
  const { models, subUpdateMany } = feeModels({ fee: feeRow({ feeType, paymentId: 'a1b2c3d4e5f60718' }), payIn: { id: 10, payInType: feeType === 'POSTING' ? 'ITEM_CREATE' : feeType } })
  const out = await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(out.fees).toBe(1)
  expect(reverseBoostDetected).not.toHaveBeenCalled()
  expect(subUpdateMany).not.toHaveBeenCalled()
  expect(out.itemsAbandoned).toBe(0)
})

test('a lost BOOST fee claim reverses no boost weight', async () => {
  const { models } = feeModels({
    fee: feeRow({ feeType: 'BOOST' }),
    payIn: { id: 10, payInType: 'BOOST' },
    claimResult: 0
  })
  await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(reverseBoostDetected).not.toHaveBeenCalled()
})

test('a stale TERRITORY_BILLING fee reverts Sub.billingStatus PAID -> PENDING_FEE only with zero CONFIRMED receipts', async () => {
  const { models, subUpdateMany } = feeModels({
    fee: feeRow({ feeType: 'TERRITORY_BILLING' }),
    payIn: { id: 10, payInType: 'TERRITORY_BILLING' }
  })
  const out = await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(subUpdateMany).toHaveBeenCalledWith({
    where: { billingPayInId: 10, billingStatus: 'PAID' },
    data: { billingStatus: 'PENDING_FEE' }
  })
  expect(out.territoriesReverted).toBe(1)
  expect(alert).toHaveBeenCalledWith('critical', expect.any(String), expect.stringContaining('payIn 10'),
    { dedupeKey: 'stale-territory-fee-10' })

  // partially-confirmed funding is real — billing must stay PAID
  jest.clearAllMocks()
  const confirmed = feeModels({
    fee: feeRow({ feeType: 'TERRITORY_BILLING' }),
    payIn: { id: 10, payInType: 'TERRITORY_BILLING' },
    confirmedCount: 1
  })
  await runReverseStaleDetectionsOnce({ models: confirmed.models, monero: {}, reverse: async () => {} })
  expect(confirmed.subUpdateMany).not.toHaveBeenCalled()
  expect(alert).not.toHaveBeenCalledWith('critical', expect.any(String), expect.any(String),
    { dedupeKey: 'stale-territory-fee-10' })
})

test('a failed boost reversal (platform fee leg) still commits the REORGED flip and pages the operator', async () => {
  const { models } = feeModels({ fee: feeRow({ feeType: 'BOOST' }), payIn: { id: 10, payInType: 'BOOST' } })
  reverseBoostDetected.mockRejectedValueOnce(new Error('CTE boom'))
  const out = await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(out.fees).toBe(1) // the claim committed despite the reversal failure
  expect(alert).toHaveBeenCalledWith('critical', expect.any(String), expect.stringContaining('payIn 10'),
    { dedupeKey: 'stale-boost-reversal-failed-10' })
})

test('a failed boost reversal (owner subFee leg) still commits the REORGED flip and pages the operator', async () => {
  const payIn = { id: 10, payInType: 'BOOST' }
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    observedSubFee: { count: async () => 0 },
    payIn: { findUnique: async () => payIn }
  }
  const models = {
    observedTip: { findMany: async () => [], findFirst: async () => null },
    observedDownvote: { findMany: async () => [], findFirst: async () => null },
    feeObservation: { findMany: async () => [] },
    observedSubFee: { findMany: async () => [{ id: 1n, payInId: 10, piconeros: 2500000000n, height: null, detectedAt: STALE, state: 'DETECTED' }] },
    $transaction: async (fn) => { await fn(tx) }
  }
  reverseBoostDetected.mockRejectedValueOnce(new Error('CTE boom'))
  const out = await runReverseStaleDetectionsOnce({ models, monero: {}, reverse: async () => {} })
  expect(out.subFees).toBe(1) // the claim committed despite the reversal failure
  expect(alert).toHaveBeenCalledWith('critical', expect.any(String), expect.stringContaining('payIn 10'),
    { dedupeKey: 'stale-subfee-boost-reversal-failed-10' })
})
