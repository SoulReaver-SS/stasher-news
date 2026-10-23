/* eslint-env jest */

// Unit tests for the lws tx-confirmation webhook receiver (spec §4.4).
//
// The receiver is a Next.js API route whose core logic is exported as
// `handleWebhook(req, res, models, monero, daemon)` so it can be tested with
// mocked prisma + lwsClient + daemonClient (the network/DI seams), without
// touching the DB or the network. The real applyTipDetected runs against a
// fake transaction client that provides $executeRaw (the only method it calls
// when a tx is passed), so the ranking side-effect path is exercised
// end-to-end.

import { handleWebhook } from '@/pages/api/monero/webhook'
import { verifyReceiptAmount } from '@/api/monero/receiptVerification'
import { recheckDetectedTip } from '@/api/monero/selfTip'
import { flipPendingToLive, applyBoostDetected } from '@/worker/rewardsWalletObserver'
import { alert } from '@/lib/alert'
import logger from '@/lib/logger'
import { moneroDetectionLevelTotal } from '@/lib/metrics'
import { WEBHOOK_MISS_CHECK_DELAY_SECONDS } from '@/lib/constants'
import { encryptViewKey } from '@/api/monero/viewkey'
import { maskFromTxPubKey, xorWithMask } from '@/api/monero/pidDecrypt'
import ownershipFixture from './fixtures/ownership-fixture.json'

// Pin the view-key master key before the lazy master-key registry can first
// load under the container's own key: the daemon-level detection test below
// runs the REAL pid-decrypt / recipient-ownership crypto (same pin as
// receiptVerification.test.js).
process.env.VIEWKEY_MASTER_KEY = Buffer.from('b'.repeat(32)).toString('base64')

// lib/auth pulls in next-auth/jwt -> uuid (ESM-only under jest CJS require); the
// webhook graph only uses lib/domains/auth's `safeEqual` (pure node:crypto), so
// mock lib/auth at the module boundary — safeEqual stays real, only the unused
// secureCookie helper is stubbed. (Same lib/auth boundary-mock pattern as
// test/components/header-merged.test.js.)
jest.mock(`${process.cwd()}/lib/auth`, () => ({
  secureCookie: (name) => name
}))

// The fee: branch (owner-routed turf fees) delegates the gated live-flip and
// the boost bump to the observer's shared helpers. Mock the module at the
// boundary (same pattern as lib/auth above) so the gate/bump CALLS are
// assertable and the observer's heavier module graph (monero-ts via
// feePoolDerive) never loads under jest.
jest.mock(`${process.cwd()}/worker/rewardsWalletObserver`, () => ({
  flipPendingToLive: jest.fn().mockResolvedValue(undefined),
  applyBoostDetected: jest.fn().mockResolvedValue(undefined)
}))

// The abandoned-fee-leg and abandoned-bounty branches page operators via
// lib/alert. Mock it at the module boundary (same pattern as above) so the
// alert CALLS are assertable without a network side effect.
jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))

// Credit callers consume recheckDetectedTip's { action } object contract now;
// spy at the module boundary so the corrected-credit test can pin the caller's
// use of the corrected amount without a chain fixture. Every other export
// stays real (self-send exclusion, lookups), so the exclusion tests below still
// exercise the production re-check.
jest.mock(`${process.cwd()}/api/monero/selfTip`, () => {
  const actual = jest.requireActual(`${process.cwd()}/api/monero/selfTip`)
  return { ...actual, recheckDetectedTip: jest.fn(actual.recheckDetectedTip) }
})

// monerod is a network seam, and handleWebhook defaults `daemon` to the real
// client. Mock the module boundary with a no-tx default so tests that predate
// the daemon level keep the lws-miss + daemon-miss = tx_not_found behavior
// without touching monerod. Tests exercising the daemon level pass their own
// `daemon` as handleWebhook's fifth argument instead.
jest.mock(`${process.cwd()}/api/monero/daemonClient`, () => ({
  daemonClient: { getTransactions: jest.fn().mockResolvedValue([]) }
}))

// The credit-side `allowProvisional` gate in verifyOrReject is unreachable by
// construction (credit call sites omit `daemon`, so verifyReceiptAmount can
// never return a daemon verdict there). Wrap the real verifier in a jest.fn
// delegate so specific tests can force the daemon level at this boundary and
// exercise the gate itself (Task 10 review ZCD10-2); every other test runs the
// REAL verification through the delegate.
jest.mock(`${process.cwd()}/api/monero/receiptVerification`, () => {
  const actual = jest.requireActual(`${process.cwd()}/api/monero/receiptVerification`)
  return { ...actual, verifyReceiptAmount: jest.fn(actual.verifyReceiptAmount) }
})

// The webhook emits a structured log line (instead of an alert) for a
// tx_not_found (both sources missed); capture the pino calls without printing.
const logInfoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})
const logErrorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

function mockModels (overrides = {}) {
  const txUpdate = overrides.txUpdate || jest.fn().mockResolvedValue({})
  const userUpdate = overrides.userUpdate || jest.fn().mockResolvedValue({})
  const execRaw = overrides.execRaw || jest.fn().mockResolvedValue(1)
  // applyTipDetected reads the tipped item's parentId (to pick zapPostTrust vs
  // zapCommentTrust) via a $queryRaw on the tx; default to no rows so isComment
  // resolves false (a post) in these unit tests.
  const queryRaw = overrides.queryRaw || jest.fn().mockResolvedValue([])
  return {
    observedTip: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      // The skipped-verification (unscannable) sub-N path writes ONLY the
      // callback height via a state-guarded updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      ...overrides.observedTip
    },
    // Self-send scan cursor: the tip branch advances MoneroAccount.lastTxId
    // forward-only via updateMany (best-effort, guarded WHERE). Base stub so
    // any scan that sees newer numeric tx ids can advance without throwing.
    // findFirst defaults to null so the C6 fee/downvote receipt verifications
    // skip (no account -> unscannable -> fail-open) unless a test overrides
    // it with a scannable account expecting chain binding.
    moneroAccount: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
      ...overrides.moneroAccount
    },
    // Bounty branch models (A-13): default to "no matching bounty payment id"
    // so tip-only tests exercise the fall-through as a 200 no-op. The pid-map
    // lookup is findFirst with the live-guard (consumedAt: null, expiresAt in
    // the future) — stale/consumed pids are unconsumable.
    bountyPidMap: {
      findFirst: jest.fn().mockResolvedValue(null),
      ...overrides.bountyPidMap
    },
    observedBounty: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      ...overrides.observedBounty
    },
    // Downvote branch models: dv:-namespace pids fall through tip+bounty.
    // Default to "no matching map" so existing tests stay 200 no-ops.
    downvotePidMap: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.downvotePidMap
    },
    observedDownvote: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      ...overrides.observedDownvote
    },
    // Fee branch models (owner-routed "fee:" pids): reverse-mapped through
    // PayIn.moneroPaymentId (unique). Default to "no matching payin" so
    // existing tests fall through to the downvote branch as 200 no-ops.
    payIn: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.payIn
    },
    // Abandoned-fee-leg attribution map: money on a "fee:" pid whose PayIn is
    // gone. Default to "no matching map" so non-fee pids keep falling through
    // to the downvote dispatch.
    subFeePidMap: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.subFeePidMap
    },
    observedSubFee: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: null } }),
      ...overrides.observedSubFee
    },
    // The downvote 0-conf path fetches the item via tx.item.findUnique with the
    // models object doubling as the tx (see the downvote tests' $transaction
    // stub); default to null = "no item, skip the penalty".
    item: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...overrides.item
    },
    $transaction: jest.fn(async (fn) => fn({
      observedTip: { update: txUpdate },
      user: { update: userUpdate },
      observedBounty: { update: overrides.txBountyUpdate || jest.fn().mockResolvedValue({}) },
      // Receipt fold (underpayment support): recordBountyReceipt sums
      // ObservedBountyReceipt rows on the tx. Default _sum null -> cumulative
      // 0n (underfunded, funding held); the funding-path tests override
      // txReceiptAggregate with a sum that crosses the expected total.
      observedBountyReceipt: {
        aggregate: overrides.txReceiptAggregate || jest.fn().mockResolvedValue({ _sum: { piconeros: null } })
      },
      bountyPidMap: { update: overrides.txPidMapUpdate || jest.fn().mockResolvedValue({}) },
      item: {
        update: overrides.txItemUpdate || jest.fn().mockResolvedValue({}),
        // driveBountyFunding computes the fee from the DECLARED bounty
        // (item.bountyPiconeros), not the observed amount. 1e11 declared → fee
        // 1e10 (floor regime), matching the 1.1e11 observed → 1e11 frozen
        // assertions below.
        findUnique: overrides.txItemFind || jest.fn().mockResolvedValue({ bountyPiconeros: 100_000_000_000n })
      },
      platformFeeConfig: {
        findUnique: overrides.txConfigFind || jest.fn().mockResolvedValue({
          bountyFeeMinPiconeros: 10_000_000_000n,
          bountyFeePct: 1,
          tipRankCapPiconeros: 100_000_000_000n,
          tipRankFactorFloor: 0.7,
          tipRankRampDays: 14,
          anonTipRankCapPiconeros: 100_000_000_000n,
          anonTipRankFactor: 0.7
        })
      },
      abuseSignal: {
        create: overrides.txAbuseSignalCreate || jest.fn().mockResolvedValue({})
      },
      $executeRaw: execRaw,
      $queryRaw: queryRaw
    })),
    // Top-level raw seams for the downvote branch's non-transactional claims
    // (pid-map consume, CONFIRMED flip); share the tx mocks so call-count
    // assertions stay uniform.
    $executeRaw: execRaw,
    $queryRaw: queryRaw
  }
}

function mockMonero (overrides = {}) {
  return {
    deleteWebhook: jest.fn().mockResolvedValue({}),
    getAddressTxs: jest.fn().mockResolvedValue({ transactions: [] }),
    ...overrides
  }
}

// A monero client whose lws scan reports exactly the receipt the callback
// claims: same tx hash (default 'deadbeef', the body most tests send) and the
// same piconeros, MINED at height 2172600 with the chain 10 blocks past it
// (derived maturity >= REQUIRED_CONFIRMATIONS). C4's chain verification
// requires this binding for any scannable account that expects a credit;
// spread/override spent_outputs when a self-send fixture needs real spend
// evidence, or pass an immature { height, chainHeight } for sub-N callbacks.
function verifiedMonero (paymentId, piconeros, hash = 'deadbeef', { height = 2172600, chainHeight = 2172609 } = {}) {
  return mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash, payment_id: paymentId, piconeros: BigInt(piconeros), spent_outputs: [], height }],
      blockchain_height: chainHeight
    })
  })
}

function mockRes () {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis()
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.LWS_WEBHOOK_TOKEN
})

test('returns 200 for an unknown payment ID (not our tip)', async () => {
  const models = mockModels()
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'unknown123', event: 'tx-confirmation', confirmations: 0 } }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.observedTip.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { paymentId: 'unknown123' } }))
  expect(models.$transaction).not.toHaveBeenCalled()
})

test('returns 200 when payment_id is missing', async () => {
  const res = mockRes()
  await handleWebhook({ body: { event: 'tx-confirmation', confirmations: 0 } }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(200)
})

test('flips PENDING -> DETECTED at 0 confirmations and runs the ranking delta', async () => {
  const tip = { id: 1, postId: 10, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-1', post: { userId: 99 }, recipientAccount: { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: null, subaddresses: [] } }
  const txUpdate = jest.fn().mockResolvedValue({ ...tip, state: 'DETECTED' })
  const execRaw = jest.fn().mockResolvedValue(1)
  // The tip has no tipperId, so applyTipDetected skips the guard lookup and
  // calls $queryRaw exactly once — for the delta chain, which ends in
  // `SELECT rank_delta`.
  const queryRaw = jest.fn().mockResolvedValue([{ rank_delta: 700000000n }])
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    txUpdate,
    execRaw,
    queryRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // The PENDING branch now uses an atomic conditional UPDATE via $executeRaw,
  // NOT tx.observedTip.update (the claim mirrors reconcilePendingTips).
  expect(txUpdate).not.toHaveBeenCalled()
  // The conditional claim ran ($executeRaw); applyTipDetected then runs inside
  // the same transaction and also calls $executeRaw on the tx, so execRaw is
  // invoked one or more times (>= 1 = at least the claim).
  expect(execRaw.mock.calls.length).toBeGreaterThanOrEqual(1)
  // The applied rank delta is persisted on the tip row (exact reorg reversal).
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const raws = [...execRaw.mock.calls.map(sqlOf), ...queryRaw.mock.calls.map(sqlOf)]
  expect(raws.some(sql => sql.includes('"rankPiconeros"'))).toBe(true)
})

test('does NOT apply ranking delta when the conditional claim loses (race with reconcile sweep)', async () => {
  const tip = { id: 1, postId: 10, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-1', post: { userId: 99 }, recipientAccount: { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: null, subaddresses: [] } }
  const txUpdate = jest.fn().mockResolvedValue({})
  // The sweep already flipped the row DETECTED, so the conditional UPDATE
  // matches 0 rows -> the webhook loses the claim and must NOT apply the delta.
  const execRaw = jest.fn().mockResolvedValue(0)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    txUpdate,
    execRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // Exactly one $executeRaw call: the claim. applyTipDetected never ran
  // (claimed === 0), so there is no second apply call -> no double-count.
  expect(execRaw).toHaveBeenCalledTimes(1)
  expect(txUpdate).not.toHaveBeenCalled()
})

test('txHash collision with an already-credited tip is a clean 200 no-op with a deduped alert (global unique)', async () => {
  // Review follow-up: the global unique on ObservedTip.txHash (one tx = one
  // credit) must not turn a replayed hash into an unhandled 500 that lws
  // retries forever. Unscannable recipient (viewKey null -> verification
  // skipped, fail-open) so the callback hash is trusted; the claim UPDATE
  // throws the unique violation (concurrent-race shape) -> caught, alerted,
  // 200 no-op. The NOT EXISTS clause in the claim SQL is the common-case guard.
  const tip = { id: 2, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'otherpid', piconeros: 0n, webhookEventId: 'evt-2', post: { userId: 99 }, recipientAccount: { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: null, subaddresses: [] } }
  const execRaw = jest.fn(async (strings) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings)
    if (sql.includes('UPDATE "ObservedTip"') && sql.includes('NOT EXISTS')) {
      throw Object.assign(new Error('Unique constraint failed on the fields: (`txHash`)'), { code: 'P2002' })
    }
    return 1
  })
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'otherpid', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // the claim SQL carries the collision guard
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const claimSql = execRaw.mock.calls.map(sqlOf).find(sql => sql.includes('UPDATE "ObservedTip"'))
  expect(claimSql).toContain('NOT EXISTS')
  expect(alert).toHaveBeenCalledWith('warn', 'tip txHash collision refused',
    expect.stringContaining('deadbeef'),
    expect.objectContaining({ dedupeKey: 'tip-collision-deadbeef' }))
})

test('direct self-tip (tipperId === post.userId) -> EXCLUDED: no ranking delta, no streaks, AbuseSignal written, webhook deleted', async () => {
  const ACCT = { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, subaddresses: [] }
  const tip = { id: 1, postId: 10, tipperId: 99, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-1', post: { userId: 99 }, recipientAccount: ACCT }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw,
    txAbuseSignalCreate
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // the EXCLUDED claim ran
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes("state = 'EXCLUDED'") && sql.includes("state = 'PENDING'"))).toBe(true)
  // exactly ONE $executeRaw: the claim. applyTipDetected never ran.
  expect(execRaw).toHaveBeenCalledTimes(1)
  // AbuseSignal row written in the same transaction
  expect(txAbuseSignalCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ kind: 'SELF_TIP_EXCLUDED', subjectUserId: 99, actorUserId: 99, postId: 10, tipId: 1 })
  }))
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-1')
})

test('self-tip EXCLUSION claim folds a duplicate txHash instead of violating the global unique (CASE guard)', async () => {
  // Review follow-up: the EXCLUSION's effect is load-bearing (blocks the
  // ranking credit, writes the AbuseSignal — which keeps its own txHash
  // copy), while the row's txHash is informational. A hash already credited
  // to another tip must not crash the claim into a P2002/500 lws retries
  // forever: the CASE stores the hash only when free, so the exclusion
  // itself always completes.
  const ACCT = { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, subaddresses: [] }
  const tip = { id: 3, postId: 10, tipperId: 99, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-3', post: { userId: 99 }, recipientAccount: ACCT }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw,
    txAbuseSignalCreate
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'replayedhash', block: 2172600, amount: 1000000000 } }
  }, res, models, mockMonero())
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const claimSql = execRaw.mock.calls.map(sqlOf).find(sql => sql.includes("state = 'EXCLUDED'"))
  expect(claimSql).toBeDefined()
  expect(claimSql).toContain('CASE WHEN EXISTS')
  expect(claimSql).toContain('o."txHash"')
  expect(claimSql).toContain('o.id <>')
  // the exclusion itself still completed (AbuseSignal written, webhook deleted)
  expect(txAbuseSignalCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ kind: 'SELF_TIP_EXCLUDED', txHash: 'replayedhash' })
  }))
})

test('self-send (spent output from the recipient own wallet) -> EXCLUDED with reason SELF_SEND', async () => {
  const ACCT = { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, subaddresses: [] }
  const tip = { id: 2, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-2', post: { userId: 99 }, recipientAccount: ACCT }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw,
    txAbuseSignalCreate
  })
  // the self-send lookup scans the recipient account; the tip tx's inputs come
  // from the recipient's own primary subaddress
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ hash: 'deadbeef', height: 2172600, payment_id: 'abc123', piconeros: 1000000000n, fee: 0n, spent_outputs: [{ amount: '1000000000', sender: { maj_i: 0, min_i: 0 } }] }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(monero.getAddressTxs).toHaveBeenCalledTimes(1)
  // The exclusionReason is a BOUND PARAM (${exclusionReason}::"TipExclusionReason"),
  // never SQL text — assert the claim via its SQL shape and the reason via the
  // call's bound values (the [...call].slice(1).flat() idiom used to read them).
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const claimCall = execRaw.mock.calls.find(call => sqlOf(call).includes("state = 'EXCLUDED'") && sqlOf(call).includes("state = 'PENDING'"))
  expect(claimCall).toBeDefined()
  expect(sqlOf(claimCall)).toContain('"TipExclusionReason"')
  expect([...claimCall].slice(1).flat()).toContain('SELF_SEND')
  expect(execRaw).toHaveBeenCalledTimes(1)
  expect(txAbuseSignalCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ kind: 'SELF_SEND_EXCLUDED', actorUserId: null })
  }))
})

test.each([
  ['foreign-index candidate', { spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }],
  ['own-index decoy without closure', { fee: 0n, spent_outputs: [{ amount: '500', sender: { maj_i: 0, min_i: 0 } }] }]
])('%s: detection proceeds without exclusion or abuse signal', async (_, txFields) => {
  const ACCT = { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, subaddresses: [] }
  const tip = { id: 3, postId: 10, tipperId: 77, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-3', post: { userId: 99 }, recipientAccount: ACCT }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw,
    txAbuseSignalCreate
  })
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ hash: 'deadbeef', height: 2172600, payment_id: 'abc123', piconeros: 1000000000n, ...txFields }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // NOT excluded: the DETECTED claim ran instead
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes("state = 'DETECTED'") && sql.includes("state = 'PENDING'"))).toBe(true)
  expect(sqls.some(sql => sql.includes("state = 'EXCLUDED'"))).toBe(false)
  expect(txAbuseSignalCreate).not.toHaveBeenCalled()
})

test('self-send scan passes the account cursor as since_tx_id (no full history)', async () => {
  const ACCT = { id: 7, label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: 41n, subaddresses: [] }
  const tip = { id: 2, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-2', post: { userId: 99 }, recipientAccount: ACCT }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw,
    txAbuseSignalCreate
  })
  // the tip tx is returned by the INCREMENTAL fetch (id 42 > cursor 41)
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 42, hash: 'deadbeef', height: 2172600, payment_id: 'abc123', piconeros: 1000000000n, fee: 0n, spent_outputs: [{ amount: '1000000000', sender: { maj_i: 0, min_i: 0 } }] }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // incremental scan keyed on the account's cursor — NOT a full history scan,
  // and NO fallback (the incremental response already contains our pid)
  expect(monero.getAddressTxs).toHaveBeenCalledTimes(1)
  expect(monero.getAddressTxs).toHaveBeenCalledWith(ACCT, 41n, null)
  // the tip tx found in the incremental response is evaluated for exclusion
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const claimCall = execRaw.mock.calls.find(call => sqlOf(call).includes("state = 'EXCLUDED'") && sqlOf(call).includes("state = 'PENDING'"))
  expect(claimCall).toBeDefined()
})

test('cursor advance is forward-only after a scan that saw newer txs', async () => {
  const ACCT = { id: 7, label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: 41n, subaddresses: [] }
  const tip = { id: 2, postId: 10, tipperId: 77, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-2', post: { userId: 99 }, recipientAccount: ACCT }
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw
  })
  // id 55 is newer than the stored cursor (41); it carries OUR pid so no
  // fallback — the forward-only advance must still run on the incremental scan
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 55, hash: 'deadbeef', height: 2172600, payment_id: 'abc123', piconeros: 1000000000n, spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // cursor advanced forward-only: WHERE never lets the write regress a stored
  // cursor >= maxId, and the data is exactly the max numeric id observed
  expect(models.moneroAccount.updateMany).toHaveBeenCalledWith({
    where: { id: 7, OR: [{ lastTxId: null }, { lastTxId: { lt: 55n } }] },
    data: { lastTxId: 55n }
  })
  expect(monero.getAddressTxs).toHaveBeenCalledTimes(1)
})

test('pid missing from the incremental response triggers exactly one full-history fallback scan', async () => {
  const ACCT = { id: 7, label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: 41n, subaddresses: [] }
  const tip = { id: 2, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-2', post: { userId: 99 }, recipientAccount: ACCT }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw,
    txAbuseSignalCreate
  })
  const getAddressTxs = jest.fn()
    .mockResolvedValueOnce({ transactions: [{ id: 60, hash: 'other', height: 2172600, payment_id: '999999', piconeros: 1n }] })
    .mockResolvedValueOnce({ transactions: [{ id: 42, hash: 'deadbeef', height: 2172600, payment_id: 'abc123', piconeros: 1000000000n, fee: 0n, spent_outputs: [{ amount: '1000000000', sender: { maj_i: 0, min_i: 0 } }] }] })
  const monero = mockMonero({ getAddressTxs })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // exactly ONE fallback: incremental (since cursor 41) then full history (0)
  expect(getAddressTxs).toHaveBeenCalledTimes(2)
  expect(getAddressTxs.mock.calls[0]).toEqual([ACCT, 41n, null])
  expect(getAddressTxs.mock.calls[1]).toEqual([ACCT, 0, null])
  // detection proceeds with the tip tx found in the fallback (self-send -> EXCLUDED)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const claimCall = execRaw.mock.calls.find(call => sqlOf(call).includes("state = 'EXCLUDED'") && sqlOf(call).includes("state = 'PENDING'"))
  expect(claimCall).toBeDefined()
  expect([...claimCall].slice(1).flat()).toContain('SELF_SEND')
})

test('self-send scan is hash-first: a same-pid dust tx cannot drive exclusion for a foreign callback hash', async () => {
  const tip = { id: 41, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'hash2', piconeros: 0n, webhookEventId: 'evt-h2', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }, execRaw, txAbuseSignalCreate })
  // The account's scan carries a same-pid tx on a DIFFERENT hash with evidence
  // that would look like a self-send; the callback names 'fakehash'. Hash-first
  // means this tx is not evidence for the named hash.
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: 'realhash', payment_id: 'hash2', piconeros: 1000n, spent_outputs: [{ sender: { maj_i: 0, min_i: 0 } }] }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'hash2', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'fakehash', amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // no EXCLUDED claim driven by the wrong tx, and no DETECTED claim either
  // (chain verification rejects the foreign hash as tx_not_found)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes("state = 'EXCLUDED'"))).toBe(false)
  expect(sqls.some(sql => sql.includes("state = 'DETECTED'"))).toBe(false)
  expect(txAbuseSignalCreate).not.toHaveBeenCalled()
})

test('retried callback for an already-EXCLUDED tip is a 200 no-op + best-effort webhook delete', async () => {
  const tip = { id: 4, postId: 10, tipperId: 99, state: 'EXCLUDED', paymentId: 'abc123', piconeros: 1000000000n, webhookEventId: 'evt-4', post: { userId: 99 } }
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) } })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 3, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.$transaction).not.toHaveBeenCalled()
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-4')
})

test('a callback for a REORGED tip is a 200 no-op with a best-effort webhook delete', async () => {
  const tip = { id: 8, postId: 10, tipperId: 99, state: 'REORGED', paymentId: 'abc123', piconeros: 1000000000n, webhookEventId: 'w-reorged', post: { userId: 99 } }
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) } })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 12, tx_info: { tx_hash: 'late', block: 999, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // the sweep already tried the delete once; the late callback retries it
  expect(monero.deleteWebhook).toHaveBeenCalledTimes(1)
  expect(monero.deleteWebhook).toHaveBeenCalledWith('w-reorged')
  // nothing advanced or flipped: no state write, no transaction, and the
  // fall-through bounty/downvote lookups are never reached
  expect(models.observedTip.update).not.toHaveBeenCalled()
  expect(models.$transaction).not.toHaveBeenCalled()
  expect(models.observedBounty.findFirst).not.toHaveBeenCalled()
})

test('lws scan failure during the self-send check fails closed (non-200, lws will retry)', async () => {
  const ACCT = { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, subaddresses: [] }
  const tip = { id: 5, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-5', post: { userId: 99 }, recipientAccount: ACCT }
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) } })
  const monero = mockMonero({ getAddressTxs: jest.fn().mockRejectedValue(new Error('lws down')) })
  const res = mockRes()
  await expect(handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)).rejects.toThrow(/lws down/)
})

test('skips the self-send scan for an unscannable account (no viewKey) and detects normally', async () => {
  const ACCT = { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: null, subaddresses: [] }
  const tip = { id: 6, postId: 10, tipperId: 77, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-6', post: { userId: 99 }, recipientAccount: ACCT }
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }, execRaw })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(monero.getAddressTxs).not.toHaveBeenCalled()
})

test('flips DETECTED -> CONFIRMED at REQUIRED_CONFIRMATIONS, bumps stackedPiconeros, deletes webhook', async () => {
  const tip = { id: 1, postId: 10, state: 'DETECTED', paymentId: 'abc123', piconeros: 1000000000n, height: 2172600, webhookEventId: 'evt-1', post: { userId: 99 }, recipientAccount: { label: 'author' } }
  const txUpdate = jest.fn().mockResolvedValue({})
  const userUpdate = jest.fn().mockResolvedValue({})
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    txUpdate,
    userUpdate,
    execRaw
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // The CONFIRMED transition is an atomic conditional claim via $executeRaw
  // (mirrors the PENDING->DETECTED guard), not tx.observedTip.update.
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes("state = 'CONFIRMED'") && sql.includes("state = 'DETECTED'"))).toBe(true)
  expect(txUpdate).not.toHaveBeenCalled()
  expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 99 },
    data: { stackedPiconeros: { increment: 1000000000n } }
  }))
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-1')
})

test('an N-conf callback credits the recheck-corrected chain amount, not the provisional one', async () => {
  const tip = {
    id: 2,
    postId: 10,
    state: 'DETECTED',
    paymentId: 'correct1',
    piconeros: 1000n,
    txHash: 'deadbeef',
    height: 2172600,
    webhookEventId: 'evt-c1',
    tipperId: 5,
    amountVerifiedAt: null,
    post: { userId: 99 },
    recipientAccount: scannableAccount()
  }
  const userUpdate = jest.fn().mockResolvedValue({})
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    userUpdate,
    execRaw
  })
  // Mature on chain: tx at 2172600 with the chain height 10 blocks ahead.
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: 'deadbeef', height: 2172600, payment_id: 'correct1', piconeros: 1000n, spent_outputs: [] }],
      blockchain_height: 2172609
    })
  })
  // The re-check corrects the unbound row to the chain-verified 400n.
  recheckDetectedTip.mockResolvedValueOnce({ action: 'corrected', piconeros: 400n, txHash: 'deadbeef' })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'correct1', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(recheckDetectedTip).toHaveBeenCalledWith(expect.objectContaining({
    confirmations: 10,
    prefetchedTx: expect.objectContaining({ hash: 'deadbeef' })
  }))
  // credit uses the CORRECTED amount (400n), never the provisional 1000n
  expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 99 },
    data: { stackedPiconeros: { increment: 400n } }
  }))
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-c1')
})

test('an N-conf callback whose re-check lost the binding race credits the winner-bound amount, not the snapshot', async () => {
  const tip = {
    id: 4,
    postId: 10,
    state: 'DETECTED',
    paymentId: 'race1',
    piconeros: 1000n,
    txHash: 'deadbeef',
    height: 2172600,
    webhookEventId: 'evt-r1',
    tipperId: 5,
    amountVerifiedAt: null,
    post: { userId: 99 },
    recipientAccount: scannableAccount()
  }
  const userUpdate = jest.fn().mockResolvedValue({})
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    userUpdate,
    execRaw
  })
  const monero = verifiedMonero('race1', 1000n)
  // The re-check lost the binding race: the row is already bound to the
  // chain's 400n by the concurrent claimer, so the contract result must carry
  // that amount and the credit below must use it — never the 1000n snapshot.
  recheckDetectedTip.mockResolvedValueOnce({ action: 'clean', piconeros: 400n })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'race1', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 99 },
    data: { stackedPiconeros: { increment: 400n } }
  }))
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-r1')
})

test('an N-conf callback whose re-check is deferred is a 200 no-op: no credit, no exclusion, no delete', async () => {
  const tip = {
    id: 3,
    postId: 10,
    state: 'DETECTED',
    paymentId: 'defer1',
    piconeros: 1000000000n,
    txHash: 'deadbeef',
    height: 2172600,
    webhookEventId: 'evt-d1',
    tipperId: 5,
    amountVerifiedAt: null,
    post: { userId: 99 },
    recipientAccount: scannableAccount()
  }
  const userUpdate = jest.fn().mockResolvedValue({})
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    userUpdate,
    execRaw,
    txAbuseSignalCreate
  })
  const monero = verifiedMonero('defer1', 1000000000)
  // lws miss corroborated by monerod: never credit or exclude on it.
  recheckDetectedTip.mockResolvedValueOnce({ action: 'deferred', reason: 'lws_miss_monerod_has_tx' })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'defer1', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  expect(execRaw.mock.calls.map(sqlOf).some(sql => sql.includes("state = 'CONFIRMED'"))).toBe(false)
  expect(txAbuseSignalCreate).not.toHaveBeenCalled()
  expect(userUpdate).not.toHaveBeenCalled()
  // the webhook is kept for the retry (a later callback / the finalizer)
  expect(monero.deleteWebhook).not.toHaveBeenCalled()
})

test('an N-conf callback for a legacy DETECTED row with a forged stored amount is EXCLUDED (CHAIN_MISMATCH), not credited', async () => {
  // Pre-verification-webhook row: the STORED 999n was attacker-supplied and
  // no callback ever carried it. The callback amount (1000) matches the
  // chain tx — C4 passes — so only the stored-vs-chain binding in
  // recheckDetectedTip can catch it (audit 2026-09-11, finding 2).
  const tip = {
    id: 2,
    postId: 10,
    state: 'DETECTED',
    paymentId: 'forged',
    piconeros: 999n,
    txHash: 'deadbeef',
    height: 2172600,
    webhookEventId: null,
    tipperId: 5,
    amountVerifiedAt: new Date('2026-09-01T00:00:00Z'),
    post: { userId: 99 },
    recipientAccount: { id: 3, label: 'author', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
  }
  const userUpdate = jest.fn().mockResolvedValue({})
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    userUpdate,
    execRaw,
    txAbuseSignalCreate
  })
  const monero = verifiedMonero('forged', 1000n)
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'forged', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // no CONFIRMED flip, no stacked bump — the forged row was excluded instead
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes("state = 'CONFIRMED'"))).toBe(false)
  expect(userUpdate).not.toHaveBeenCalled()
  expect(txAbuseSignalCreate).toHaveBeenCalledWith({
    data: expect.objectContaining({ kind: 'CHAIN_MISMATCH_EXCLUDED', piconeros: 999n })
  })
  // verification + re-check share ONE lws lookup (prefetchedTx)
  expect(monero.getAddressTxs).toHaveBeenCalledTimes(1)
})

test('does NOT bump author stackedPiconeros when the recipient is the rewards wallet (wallet-less tip)', async () => {
  const tip = {
    id: 1,
    postId: 10,
    state: 'DETECTED',
    paymentId: 'abc123',
    piconeros: 1000000000n,
    height: 2172600,
    webhookEventId: 'evt-1',
    post: { userId: 99 },
    recipientAccount: { label: 'platform_rewards' }
  }
  const userUpdate = jest.fn().mockResolvedValue({})
  const txUpdate = jest.fn().mockResolvedValue({})
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    txUpdate,
    userUpdate,
    execRaw
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // the tip row still flips to CONFIRMED via the conditional claim ...
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes("state = 'CONFIRMED'") && sql.includes("state = 'DETECTED'"))).toBe(true)
  expect(txUpdate).not.toHaveBeenCalled()
  // ... but the author stackedPiconeros bump is SKIPPED (nobody was paid)
  expect(userUpdate).not.toHaveBeenCalled()
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-1')
})

test('sub-maturity DETECTED callbacks never write the callback confirmations/height/txHash', async () => {
  // Unscannable account (no view key): verification is skipped (documented
  // fail-open), so the callback's count is all the maturity evidence there is
  // — but it is still below REQUIRED_CONFIRMATIONS, so nothing is credited and
  // nothing is persisted: verified writes belong to the recheck/finalizer.
  const tip = { id: 1, postId: 10, state: 'DETECTED', paymentId: 'abc123', piconeros: 1000000000n, height: 2172600, webhookEventId: 'evt-1', post: { userId: 99 }, recipientAccount: { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: null, subaddresses: [] } }
  const models = mockModels({
    observedTip: {
      findFirst: jest.fn().mockResolvedValue(tip),
      update: jest.fn().mockResolvedValue({})
    }
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 5, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.observedTip.update).not.toHaveBeenCalled()
})

test('sub-N skipped verification (unscannable account) writes ONLY the callback height to a height-NULL DETECTED row', async () => {
  // Unscannable account: verifyReceiptAmount skips (documented fail-open), so
  // there is no chain view and the re-check early-returns clean without ever
  // writing a height. Without this minimal write a missed N-conf callback
  // would strand the row height-NULL, invisible to the finalizer's
  // height-not-null scan — a silent non-credit.
  const tip = { id: 26, postId: 10, state: 'DETECTED', paymentId: 'skip1', piconeros: 1000000000n, height: null, confirmations: 0, txHash: 'deadbeef', webhookEventId: 'evt-s1', post: { userId: 99 }, recipientAccount: { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: null, subaddresses: [] } }
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'skip1', event: 'tx-confirmation', confirmations: 5, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // height only: no piconeros, no txHash, no confirmations
  expect(models.observedTip.updateMany).toHaveBeenCalledWith({
    where: { id: 26, state: 'DETECTED', height: null },
    data: { height: 2172600 }
  })
  // the legacy callback-metadata write never runs
  expect(models.observedTip.update).not.toHaveBeenCalled()
})

test('is idempotent — a callback when already CONFIRMED is a no-op', async () => {
  const tip = { id: 1, postId: 10, state: 'CONFIRMED', paymentId: 'abc123', piconeros: 1000000000n, post: { userId: 99 }, recipientAccount: { label: 'author', ownerUserId: 99, status: 'ACTIVE', viewKey: null, subaddresses: [] } }
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip), update: jest.fn() }
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.observedTip.update).not.toHaveBeenCalled()
  expect(monero.deleteWebhook).not.toHaveBeenCalled()
})

test('rejects requests with a wrong webhook token when LWS_WEBHOOK_TOKEN is set', async () => {
  process.env.LWS_WEBHOOK_TOKEN = 'test-secret'
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'abc' }, headers: { 'x-lws-token': 'wrong' } }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(401)
})

test('accepts requests with the correct webhook token', async () => {
  process.env.LWS_WEBHOOK_TOKEN = 'test-secret'
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'unknown' }, headers: { 'x-lws-token': 'test-secret' } }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(200)
})

test('skips token check when LWS_WEBHOOK_TOKEN is not set (dev default)', async () => {
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'unknown' } }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(200)
})

test('accepts requests with the correct token delivered in the body (monero-lws callback format)', async () => {
  process.env.LWS_WEBHOOK_TOKEN = 'test-secret'
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'unknown', token: 'test-secret' }, headers: {} }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(200)
})

test('rejects requests with a wrong token in the body', async () => {
  process.env.LWS_WEBHOOK_TOKEN = 'test-secret'
  const res = mockRes()
  await handleWebhook({ body: { payment_id: 'unknown', token: 'wrong' }, headers: {} }, res, mockModels())
  expect(res.status).toHaveBeenCalledWith(401)
})

test('a claimed tip enqueues no streak jobs and mints no streaks', async () => {
  const tip = { id: 1, postId: 10, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, tipperId: 5, webhookEventId: 'evt-1', post: { userId: 999 }, recipientAccount: { ownerUserId: 99 } }
  const execRaw = jest.fn().mockResolvedValue(1)
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw,
    queryRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const allSql = [...execRaw.mock.calls, ...queryRaw.mock.calls].map(sqlOf)
  // The flame is quest-driven now (the daily evaluation owns it) and the coin
  // badge is deleted: a claim must not enqueue streak jobs or mint streaks.
  expect(allSql.some(sql => sql.includes('checkStreak'))).toBe(false)
  expect(allSql.some(sql => sql.includes('COIN'))).toBe(false)
})

test('bounty branch: claims a PENDING ObservedBounty via the conditional UPDATE and consumes its BountyPidMap', async () => {
  const bounty = { id: 7, postId: 5, state: 'PENDING', paymentId: 'bn123', webhookEventId: 'evt-b' }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txPidMapUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue({ paymentId: 'bn123', postId: 5, userId: 2 }) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    execRaw,
    txPidMapUpdate
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 15000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // The claim is the atomic conditional UPDATE (mirrors the tip branch).
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes('UPDATE "ObservedBounty"') && sql.includes("state = 'PENDING'"))).toBe(true)
  // The pid map is consumed only when the claim won.
  expect(txPidMapUpdate).toHaveBeenCalledWith({
    where: { paymentId: 'bn123' },
    data: expect.objectContaining({ consumedAt: expect.any(Date) })
  })
  // No ranking delta / streak side effects ran for a bounty.
  expect(sqls.some(sql => sql.includes('checkStreak'))).toBe(false)
})

test('bounty branch: a daemon-verified 0-conf funding claims DETECTED with ONLY the verdict values and records a PROVISIONAL (height-null) receipt', async () => {
  // lws REST cannot see mempool txs, so a 0-conf bounty funding callback is
  // admitted on a daemon verdict: tx + payment id + recipient output are
  // proven, but NOT the RingCT amount, and tx_info (block/confirmations) is
  // attacker-supplied. The claim must write the verdict's canonical tx hash,
  // force confirmations to 0, and keep height NULL; the receipt stays
  // height-NULL (display-only) until an lws sight proves the amount and claims
  // the height via the atomic CAS — otherwise a dust tx with a fabricated
  // amount/block/confirmations would gate FUNDED.
  const bounty = { id: 7, postId: 5, state: 'PENDING', paymentId: DAEMON_PID, webhookEventId: 'evt-bd', recipientAccount: daemonAccount() }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txPidMapUpdate = jest.fn().mockResolvedValue({})
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue({ paymentId: DAEMON_PID, postId: 5, userId: 2 }) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    execRaw,
    txPidMapUpdate,
    queryRaw
  })
  const monero = mockMonero({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 10 }) })
  // The daemon returns the canonical lowercase hash while the callback names
  // the same tx in uppercase (+ forged confirmations): only the VERDICT values
  // may reach the row.
  const daemon = { getTransactions: jest.fn().mockResolvedValue([{ hash: DAEMON_HASH, extra: daemonOwnedExtra(DAEMON_PID), vout: ownershipFixture.voutKeys }]) }
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: DAEMON_PID, event: 'tx-confirmation', confirmations: 5, tx_info: { tx_hash: DAEMON_HASH.toUpperCase(), block: 2172600, amount: 1010000000000 } }
  }, res, models, monero, daemon)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(daemon.getTransactions).toHaveBeenCalledWith([DAEMON_HASH.toUpperCase()])
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  // The claim binds the DAEMON verdict's hash and forces confirmations 0, with
  // height NULL — never the callback's tx_info values.
  const claim = execRaw.mock.calls.find(call => sqlOf(call).includes("state = 'DETECTED'") && sqlOf(call).includes("state = 'PENDING'"))
  expect(claim).toBeDefined()
  const bound = [...claim].slice(1).flat()
  expect(bound).toContain(DAEMON_HASH)
  expect(bound).not.toContain(DAEMON_HASH.toUpperCase())
  expect(bound).toContain(null)
  expect(sqlOf(claim)).toMatch(/confirmations = 0/)
  expect(bound).not.toContain(5)
  expect(bound).not.toContain(2172600)
  // The receipt insert carries the verdict's hash, renders a literal NULL
  // height, and no CAS height claim follows (the amount is unverified).
  const sqls = queryRaw.mock.calls.map(sqlOf)
  const insert = sqls.find(sql => sql.includes('INSERT INTO "ObservedBountyReceipt"'))
  expect(insert).toBeDefined()
  expect(insert).toContain('NULL')
  const insertCall = queryRaw.mock.calls.find(call => sqlOf(call).includes('INSERT INTO "ObservedBountyReceipt"'))
  const insertVals = [...insertCall].slice(1)
  expect(insertVals).toContain(DAEMON_HASH)
  expect(insertVals).not.toContain(DAEMON_HASH.toUpperCase())
  expect(sqls.some(sql => sql.includes('UPDATE "ObservedBountyReceipt"'))).toBe(false)
})

test('bounty branch: the N-conf funding path binds the lws height, never the callback tx_info.block', async () => {
  // Credit path (allowProvisional: false): the callback binds to the lws tx,
  // and every height that gates/serves maturity must come from that verdict —
  // a fabricated tx_info.block on a scannable escrow account must never reach
  // the receipt CAS or the funding row.
  const CALLBACK_BLOCK = 2999999
  const LWS_HEIGHT = 2172600
  const TX_HASH = 'beefbeef'
  const bounty = { id: 7, postId: 5, state: 'DETECTED', paymentId: 'bnlwsh', txHash: TX_HASH, webhookEventId: 'evt-bh', recipientAccount: scannableAccount() }
  const txBountyUpdate = jest.fn().mockResolvedValue({})
  const txItemUpdate = jest.fn().mockResolvedValue({})
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    txReceiptAggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: 110_000_000_000n } }),
    txBountyUpdate,
    txItemUpdate,
    queryRaw
  })
  const monero = verifiedMonero('bnlwsh', 110_000_000_000n, TX_HASH, { height: LWS_HEIGHT, chainHeight: LWS_HEIGHT + 9 })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bnlwsh', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: TX_HASH, block: CALLBACK_BLOCK, amount: 110000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // The funding row takes the lws height...
  expect(txBountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 7 },
    data: expect.objectContaining({ state: 'CONFIRMED', height: LWS_HEIGHT, confirmations: 10 })
  }))
  // ...and the receipt CAS binds the same lws height, never the callback block.
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const casCall = queryRaw.mock.calls.find(call => sqlOf(call).includes('UPDATE "ObservedBountyReceipt"'))
  expect(casCall).toBeDefined()
  const casVals = [...casCall].slice(1)
  expect(casVals).toContain(LWS_HEIGHT)
  expect(casVals).not.toContain(CALLBACK_BLOCK)
})

test('bounty branch: the DETECTED sub-conf height backfill takes the lws height, never the callback tx_info.block', async () => {
  const CALLBACK_BLOCK = 2999999
  const LWS_HEIGHT = 2172600
  const TX_HASH = 'f00d1234'
  const bounty = { id: 11, postId: 8, state: 'DETECTED', paymentId: 'bnsub', txHash: TX_HASH, webhookEventId: 'evt-d', recipientAccount: scannableAccount() }
  const bountyUpdate = jest.fn().mockResolvedValue({})
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty), update: bountyUpdate },
    txReceiptAggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: null } }),
    queryRaw
  })
  const monero = verifiedMonero('bnsub', 11000000000n, TX_HASH, { height: LWS_HEIGHT, chainHeight: LWS_HEIGHT + 3 })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bnsub', event: 'tx-confirmation', confirmations: 3, tx_info: { tx_hash: TX_HASH, block: CALLBACK_BLOCK, amount: 11000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // The row takes the lws height/hash and the CHAIN-DERIVED confirmation count
  // (tip - height + 1 = 4 for a tip 3 blocks above the tx), never the stale
  // callback count (3) or the callback block.
  expect(bountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 11 },
    data: expect.objectContaining({ height: LWS_HEIGHT, txHash: TX_HASH, confirmations: 4 })
  }))
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const casCall = queryRaw.mock.calls.find(call => sqlOf(call).includes('UPDATE "ObservedBountyReceipt"'))
  expect(casCall).toBeDefined()
  const casVals = [...casCall].slice(1)
  expect(casVals).toContain(LWS_HEIGHT)
  expect(casVals).not.toContain(CALLBACK_BLOCK)
})

test('bounty branch: a FORGED callback confirmation count does not fund — maturity is chain-derived', async () => {
  // The callback claims 10 confirmations; the chain says the lws-verified tx
  // is only 6 blocks deep. A forged count must not open the FUNDED gate: the
  // branch derives maturity from chainHeight - verifiedHeight + 1 and falls
  // through to the immature receipt-fold/anchor path.
  const LWS_HEIGHT = 2172600
  const TX_HASH = 'cafe0001'
  const bounty = { id: 21, postId: 9, state: 'DETECTED', paymentId: 'bnforged', txHash: TX_HASH, height: null, webhookEventId: 'evt-f', recipientAccount: scannableAccount() }
  const bountyUpdate = jest.fn().mockResolvedValue({})
  const txBountyUpdate = jest.fn().mockResolvedValue({})
  const txItemUpdate = jest.fn().mockResolvedValue({})
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty), update: bountyUpdate },
    txReceiptAggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: 110_000_000_000n } }),
    txBountyUpdate,
    txItemUpdate,
    queryRaw
  })
  const monero = verifiedMonero('bnforged', 110_000_000_000n, TX_HASH, { height: LWS_HEIGHT, chainHeight: LWS_HEIGHT + 5 })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bnforged', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: TX_HASH, block: 2999999, amount: 110000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // no funding side effects: no Item -> FUNDED, no webhook delete
  expect(txItemUpdate).not.toHaveBeenCalled()
  expect(txBountyUpdate).not.toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ state: 'CONFIRMED' })
  }))
  expect(monero.deleteWebhook).not.toHaveBeenCalled()
  // the row keeps the DERIVED count (6) and backfills the lws height (NULL -> 2172600)
  expect(bountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 21 },
    data: expect.objectContaining({ confirmations: 6, height: LWS_HEIGHT })
  }))
})

test('bounty branch: a replayed older callback cannot LOWER the ObservedBounty.height anchor (advance-only)', async () => {
  // The funding row already advanced to a later top-up's height; a replay of
  // the OLDER tx (still an lws-verified verdict) must not regress the maturity
  // anchor. The immature path advances only.
  const STORED_HEIGHT = 2172700
  const OLD_HEIGHT = 2172600
  const TX_HASH = 'cafe0002'
  const bounty = { id: 22, postId: 9, state: 'DETECTED', paymentId: 'bnolder', txHash: 'ff'.repeat(32), height: STORED_HEIGHT, webhookEventId: 'evt-o', recipientAccount: scannableAccount() }
  const bountyUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty), update: bountyUpdate },
    txReceiptAggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: null } }),
    queryRaw: jest.fn().mockResolvedValue([])
  })
  const monero = verifiedMonero('bnolder', 110_000_000_000n, TX_HASH, { height: OLD_HEIGHT, chainHeight: OLD_HEIGHT + 5 })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bnolder', event: 'tx-confirmation', confirmations: 6, tx_info: { tx_hash: TX_HASH, block: 2999999, amount: 110000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  const data = bountyUpdate.mock.calls[0][0].data
  expect(data.confirmations).toBe(6) // derived from the chain
  expect(data.height).toBeUndefined() // advance-only: the stored anchor survives
})

test('bounty branch: an unscannable escrow account keeps the callback-confirmation fail-open and can still fund', async () => {
  // No view key -> verification skipped (the documented fail-open edge): there
  // is no chain view, so derived maturity keeps the callback count and the
  // funding path stays reachable.
  const unscanable = { id: 9, label: 'escrow', address: 'X', status: 'ACTIVE', viewKey: null }
  const bounty = { id: 23, postId: 9, state: 'DETECTED', paymentId: 'bnskip', txHash: 'skip1', height: null, webhookEventId: 'evt-s', recipientAccount: unscanable }
  const txBountyUpdate = jest.fn().mockResolvedValue({})
  const txItemUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    txReceiptAggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: 110_000_000_000n } }),
    txBountyUpdate,
    txItemUpdate
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bnskip', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'skip1', block: 2172600, amount: 110000000000 } }
  }, res, models, mockMonero())
  expect(res.status).toHaveBeenCalledWith(200)
  expect(txBountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 23 },
    data: expect.objectContaining({ state: 'CONFIRMED', confirmations: 10 })
  }))
  expect(txItemUpdate).toHaveBeenCalled()
})

test('bounty credit (sub-conf receipt) rejects a daemon-level verdict through the allowProvisional gate: no receipt, no row write', async () => {
  const bounty = { id: 11, postId: 8, state: 'DETECTED', paymentId: 'bngate1', txHash: DAEMON_HASH, webhookEventId: 'evt-g1', recipientAccount: scannableAccount() }
  const bountyUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty), update: bountyUpdate }
  })
  // Force the daemon level at the verifier boundary: the gate is the only
  // thing between a daemon (amount-unverified) verdict and the receipt write.
  verifyReceiptAmount.mockResolvedValueOnce({ ok: true, level: 'daemon', tx: { hash: DAEMON_HASH, height: null } })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bngate1', event: 'tx-confirmation', confirmations: 3, tx_info: { tx_hash: DAEMON_HASH, block: 2172800, amount: 11000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.$transaction).not.toHaveBeenCalled()
  expect(bountyUpdate).not.toHaveBeenCalled()
})

test('bounty credit (N-conf funding) rejects a daemon-level verdict through the allowProvisional gate: no receipt, no FUNDED flip, no webhook delete', async () => {
  const bounty = { id: 7, postId: 5, state: 'DETECTED', paymentId: 'bngate2', txHash: DAEMON_HASH, webhookEventId: 'evt-g2', recipientAccount: scannableAccount() }
  const txBountyUpdate = jest.fn().mockResolvedValue({})
  const txItemUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    txReceiptAggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: 110_000_000_000n } }),
    txBountyUpdate,
    txItemUpdate
  })
  verifyReceiptAmount.mockResolvedValueOnce({ ok: true, level: 'daemon', tx: { hash: DAEMON_HASH, height: null } })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bngate2', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: DAEMON_HASH, block: 2172610, amount: 110000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.$transaction).not.toHaveBeenCalled()
  expect(txBountyUpdate).not.toHaveBeenCalled()
  expect(txItemUpdate).not.toHaveBeenCalled()
  expect(models.$queryRaw).not.toHaveBeenCalled()
})

test('metrics: every webhook verification verdict increments monero_detection_level_total by level', async () => {
  const levelValue = async (level) => {
    const { values } = await moneroDetectionLevelTotal.get()
    return values.find(v => v.labels.level === level)?.value ?? 0
  }
  const before = {
    lws: await levelValue('lws'),
    daemon: await levelValue('daemon'),
    rejected: await levelValue('rejected')
  }

  // lws verdict: a scannable tip whose callback binds to the chain.
  const tipLws = { id: 61, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'mlevel1', piconeros: 0n, webhookEventId: 'evt-l1', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const modelsLws = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tipLws) },
    execRaw: jest.fn().mockResolvedValue(1),
    queryRaw: jest.fn().mockResolvedValue([{ rank_delta: 1n }])
  })
  await handleWebhook({
    body: { payment_id: 'mlevel1', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000 } }
  }, mockRes(), modelsLws, verifiedMonero('mlevel1', 1000))
  expect(await levelValue('lws')).toBe(before.lws + 1)

  // daemon verdict: lws misses, the daemon matches pid + recipient ownership.
  const tipDaemon = { id: 62, postId: 10, tipperId: null, state: 'PENDING', paymentId: DAEMON_PID, piconeros: 0n, webhookEventId: 'evt-l2', post: { userId: 99 }, recipientAccount: daemonAccount() }
  const modelsDaemon = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tipDaemon) },
    execRaw: jest.fn().mockResolvedValue(1)
  })
  const daemon = { getTransactions: jest.fn().mockResolvedValue([{ hash: DAEMON_HASH, extra: daemonOwnedExtra(DAEMON_PID), vout: ownershipFixture.voutKeys }]) }
  await handleWebhook({
    body: { payment_id: DAEMON_PID, event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: DAEMON_HASH, amount: 1000 } }
  }, mockRes(), modelsDaemon, mockMonero({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 10 }) }), daemon)
  expect(await levelValue('daemon')).toBe(before.daemon + 1)

  // rejected verdict: the callback amount disagrees with the chain.
  const tipRej = { id: 63, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'mlevel3', piconeros: 0n, webhookEventId: 'evt-l3', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const modelsRej = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tipRej) } })
  const moneroRej = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: 'deadbeef', payment_id: 'mlevel3', piconeros: 999n, spent_outputs: [] }],
      blockchain_height: 100
    })
  })
  await handleWebhook({
    body: { payment_id: 'mlevel3', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000 } }
  }, mockRes(), modelsRej, moneroRej)
  expect(await levelValue('rejected')).toBe(before.rejected + 1)
})

test('bounty branch: a DETECTED bounty at REQUIRED_CONFIRMATIONS runs the funding side effects and deletes the webhook', async () => {
  const bounty = { id: 7, postId: 5, state: 'DETECTED', paymentId: 'bn123', txHash: 'deadbeef', webhookEventId: 'evt-b' }
  const txBountyUpdate = jest.fn().mockResolvedValue({})
  const txItemUpdate = jest.fn().mockResolvedValue({})
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    // A DETECTED bounty's pid map is already consumed (consumedAt set at
    // DETECTED), so the live-guarded lookup returns null. The pid map is NOT
    // consulted for DETECTED callbacks — driveBountyFunding must run regardless.
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue(null) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    // Receipts already sum to the callback amount (1.1e11) — the cumulative
    // total crosses the expected declared+fee (1e11 + 1e10), so the funding
    // gate opens.
    txReceiptAggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: 110_000_000_000n } }),
    txBountyUpdate,
    txItemUpdate,
    queryRaw
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'beefbeef', block: 2172610, amount: 110000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // ObservedBounty -> CONFIRMED with the callback's height/confirmations.
  expect(txBountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 7 },
    data: expect.objectContaining({ state: 'CONFIRMED', confirmations: 10, height: 2172610 })
  }))
  // Item -> FUNDED with the observed amount NET of the platform fee (1.1e11
  // observed − 1e10 floor fee = 1e11) and the fee terms FROZEN on the Item, so
  // dispositions can zero the escrow exactly.
  expect(txItemUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 5 },
    data: expect.objectContaining({ bountyStatus: 'FUNDED', bountyPiconeros: 100000000000n, bountyFeePiconeros: 10000000000n, bountyConfirmedAt: expect.any(Date) })
  }))
  // No hot-wallet cash row: the money is still in escrow, so no BOUNTY_FEE
  // receipt may be written inside the funding transaction.
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = queryRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes('BOUNTY_FEE'))).toBe(false)
  // The lws webhook is torn down after the transaction commits.
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-b')
})

test('bounty branch: the N-conf CONFIRMED callback still funds when the BountyPidMap is ALREADY CONSUMED (regression: pid-map gate must not block the DETECTED->CONFIRMED callback)', async () => {
  // Realistic post-0-conf state: the 0-conf callback already claimed PENDING
  // -> DETECTED and consumed the pid map (consumedAt set). Every later callback
  // (1-conf .. N-conf) finds a CONSUMED map, so the live-guarded findFirst
  // (consumedAt: null) returns null. The N-conf callback is the ONLY path that
  // runs driveBountyFunding, so it MUST still reach it — idempotency is handled
  // by the CONFIRMED state guard + ON CONFLICT, NOT by the pid-map gate.
  const bounty = { id: 9, postId: 6, state: 'DETECTED', paymentId: 'bn456', txHash: 'cafef00d', webhookEventId: 'evt-c' }
  const txBountyUpdate = jest.fn().mockResolvedValue({})
  const txItemUpdate = jest.fn().mockResolvedValue({})
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    // Consumed map -> the live-guarded lookup matches nothing.
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue(null) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    // Receipts sum to the callback amount — the cumulative total crosses the
    // expected declared+fee, so the gate opens despite the consumed map.
    txReceiptAggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: 110_000_000_000n } }),
    txBountyUpdate,
    txItemUpdate,
    queryRaw
  })
  const monero = mockMonero()
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn456', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'cafef00d', block: 2172700, amount: 110000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // driveBountyFunding ran: ObservedBounty -> CONFIRMED.
  expect(txBountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 9 },
    data: expect.objectContaining({ state: 'CONFIRMED', confirmations: 10, height: 2172700 })
  }))
  // Item -> FUNDED net of fee, with the fee terms frozen on the Item.
  expect(txItemUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 6 },
    data: expect.objectContaining({ bountyStatus: 'FUNDED', bountyPiconeros: 100000000000n, bountyFeePiconeros: 10000000000n })
  }))
  // Webhook torn down.
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-c')
})

test('bounty branch: a DETECTED sub-conf callback (pid map consumed) still records height/confirmations (height backfill reachable)', async () => {
  // The intermediate 1-conf .. (N-1)-conf callbacks must also reach the DETECTED
  // branch to backfill height (NULL at 0-conf) and confirmations — otherwise the
  // finalizer's height-not-null filter can never pick up a missed N-conf callback.
  const bounty = { id: 11, postId: 8, state: 'DETECTED', paymentId: 'bn789', txHash: 'f00d1234', webhookEventId: 'evt-d' }
  const bountyUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue(null) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty), update: bountyUpdate }
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn789', event: 'tx-confirmation', confirmations: 3, tx_info: { tx_hash: 'f00d1234', block: 2172800, amount: 11000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // The height/confirmations backfill ran on the DETECTED row.
  expect(bountyUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 11 },
    data: expect.objectContaining({ confirmations: 3, height: 2172800, txHash: 'f00d1234' })
  }))
})

test('bounty branch: does NOT consume the BountyPidMap when the conditional claim loses (race with another claimer)', async () => {
  const bounty = { id: 7, postId: 5, state: 'PENDING', paymentId: 'bn123', txHash: 'pending-bn123', webhookEventId: 'evt-b' }
  const execRaw = jest.fn().mockResolvedValue(0)
  const txPidMapUpdate = jest.fn().mockResolvedValue({})
  const txBountyUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue({ paymentId: 'bn123', postId: 5 }) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    execRaw,
    txPidMapUpdate,
    txBountyUpdate
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 15000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes('UPDATE "ObservedBounty"') && sql.includes("state = 'PENDING'"))).toBe(true)
  // A lost claim means the pid map is NOT consumed and no CONFIRMED side
  // effects run (the row stays PENDING; the winner owns the transitions).
  expect(txPidMapUpdate).not.toHaveBeenCalled()
  expect(txBountyUpdate).not.toHaveBeenCalled()
})

test('bounty branch: an EXPIRED BountyPidMap is unconsumable — a late callback is a 200 no-op', async () => {
  // A stale PENDING ObservedBounty still exists for this payment id (the
  // author re-minted a fresh address after the 24h pid-map expiry), but the
  // live-guarded pid-map lookup matches nothing, so the branch must bail
  // before it can claim/consume anything.
  const bounty = { id: 7, postId: 5, state: 'PENDING', paymentId: 'bn123', txHash: 'pending-bn123', webhookEventId: 'evt-b' }
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue(null) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    execRaw
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 15000000000 } }
  }, res, models)
  expect(res.status).toHaveBeenCalledWith(200)
  // The lookup carried the live-guard (consumedAt null + expiresAt in future).
  expect(models.bountyPidMap.findFirst).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ paymentId: 'bn123', consumedAt: null, expiresAt: expect.any(Object) })
  }))
  // No state change: no claim, no pid-map consumption, no transaction at all.
  expect(execRaw).not.toHaveBeenCalled()
  expect(models.$transaction).not.toHaveBeenCalled()
})

test('DETECTED->CONFIRMED does not credit the author when the conditional claim loses (race loser)', async () => {
  process.env.LWS_WEBHOOK_TOKEN = 't'
  const userUpdate = jest.fn().mockResolvedValue({})
  // claim lost: another claimer already flipped the row to CONFIRMED
  const execRaw = jest.fn().mockResolvedValue(0)
  const models = mockModels({ execRaw, userUpdate })
  models.observedTip.findFirst.mockResolvedValue({ id: 1, state: 'DETECTED', piconeros: 1000n, postId: 10, tipperId: 5, post: { userId: 7 }, recipientAccount: { label: 'author', ownerUserId: 7 } })
  const res = mockRes()
  await handleWebhook(
    {
      method: 'POST',
      headers: { 'x-lws-token': 't' },
      body: { payment_id: 'p1', confirmations: 15, tx_info: { tx_hash: 'h', block: 100, amount: '1000' } }
    },
    res, models, mockMonero()
  )
  expect(execRaw).toHaveBeenCalled()
  expect(userUpdate).not.toHaveBeenCalled() // race loser MUST NOT increment
  expect(res.status).toHaveBeenLastCalledWith(200)
})

// ---- self-send re-check at confirm time (post-mining evidence) ----
// The 0-conf PENDING scan cannot see spent_outputs for a mempool tx, so a
// wash tip paid from the author's own wallet (different tipper account) fails
// open at detection. These tests pin the re-check that closes that window.

function scannableAccount (over = {}) {
  return { id: 7, label: 'author', ownerUserId: 99, address: '53fake', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [], ...over }
}

// Daemon-level (0-conf) fixture wiring: the account keys and vout/txPubKeys are
// the REAL chain-derived ownership fixture (Task 8), and the encrypted pid
// extra is built with the shipping pid crypto (setup only), so these tests run
// the production daemon verification end-to-end.
const DAEMON_PID = 'a1b2c3d4e5f60718'
const DAEMON_HASH = 'bb'.repeat(32)
const DAEMON_R = Buffer.from(ownershipFixture.txPubKeys[0], 'hex')

function daemonAccount () {
  return scannableAccount({
    address: ownershipFixture.address,
    viewKey: encryptViewKey(ownershipFixture.viewKeyHex)
  })
}

function daemonOwnedExtra (paymentId) {
  const encPid = xorWithMask(Buffer.from(paymentId, 'hex'), maskFromTxPubKey(DAEMON_R, ownershipFixture.viewKeyHex))
  return Buffer.concat([Buffer.from([0x01]), DAEMON_R, Buffer.from([0x02, 0x09, 0x01]), encPid])
}

test('N-conf CONFIRMED callback re-runs the self-send check: a wash tip that failed open at 0-conf is EXCLUDED with its ranking delta reversed, never credited', async () => {
  const tip = { id: 21, postId: 10, tipperId: 77, state: 'DETECTED', paymentId: 'wash1', piconeros: 1000000000n, rankPiconeros: 700000000n, height: 2172600, confirmations: 9, txHash: 'deadbeef', webhookEventId: 'evt-w1', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const userUpdate = jest.fn().mockResolvedValue({})
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  // reverseTip's parentId read (tipperId != null) on the tx
  const queryRaw = jest.fn().mockResolvedValue([])
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    userUpdate,
    execRaw,
    queryRaw,
    txAbuseSignalCreate
  })
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 60, hash: 'deadbeef', height: 2172600, payment_id: 'wash1', piconeros: 1000000000n, fee: 0n, spent_outputs: [{ amount: '1000000000', sender: { maj_i: 0, min_i: 0 } }] }],
      blockchain_height: 2172609
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'wash1', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  // claimed EXCLUDED from DETECTED with reason SELF_SEND
  const claimCall = execRaw.mock.calls.find(call => sqlOf(call).includes("state = 'EXCLUDED'") && sqlOf(call).includes("state = 'DETECTED'"))
  expect(claimCall).toBeDefined()
  expect([...claimCall].slice(1).flat()).toContain('SELF_SEND')
  // never CONFIRMED, never credited
  expect(sqls.some(sql => sql.includes("state = 'CONFIRMED'"))).toBe(false)
  expect(userUpdate).not.toHaveBeenCalled()
  // the detection-applied ranking delta was reversed (exact inverse, stored rankPiconeros)
  expect(sqls.some(sql => sql.includes('"tipRankPiconeros" = "Item"."tipRankPiconeros" -'))).toBe(true)
  expect(txAbuseSignalCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ kind: 'SELF_SEND_EXCLUDED', subjectUserId: 99, actorUserId: 77, tipId: 21, piconeros: 1000000000n })
  }))
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-w1')
})

test('N-conf CONFIRMED callback on a clean mined tip confirms normally (re-check scans and excludes nothing)', async () => {
  // Bound row (amountVerifiedAt set) that matches the chain: the re-check's
  // clean path, not the correction path.
  const tip = { id: 22, postId: 10, tipperId: 77, state: 'DETECTED', paymentId: 'clean1', piconeros: 1000000000n, rankPiconeros: 700000000n, height: 2172600, confirmations: 9, txHash: 'deadbeef', webhookEventId: 'evt-w2', amountVerifiedAt: new Date('2026-09-01T00:00:00Z'), post: { userId: 99 }, recipientAccount: scannableAccount() }
  const userUpdate = jest.fn().mockResolvedValue({})
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    userUpdate,
    execRaw,
    txAbuseSignalCreate
  })
  // chain reports exactly the receipt the callback claims (hash + amount), so
  // C4 verification passes and the single lookup is threaded into the
  // self-send re-check (one getAddressTxs call — asserted below).
  const monero = verifiedMonero('clean1', 1000000000)
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'clean1', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(monero.getAddressTxs).toHaveBeenCalledTimes(1)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes("state = 'CONFIRMED'") && sql.includes("state = 'DETECTED'"))).toBe(true)
  expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 99 },
    data: { stackedPiconeros: { increment: 1000000000n } }
  }))
  expect(txAbuseSignalCreate).not.toHaveBeenCalled()
})

test('first mined callback (height arrives on a height-NULL DETECTED row) re-checks self-send and excludes before maturity', async () => {
  const tip = { id: 23, postId: 10, tipperId: 77, state: 'DETECTED', paymentId: 'wash2', piconeros: 1000000000n, rankPiconeros: 700000000n, height: null, confirmations: 0, txHash: 'deadbeef', webhookEventId: 'evt-w3', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txAbuseSignalCreate = jest.fn().mockResolvedValue({})
  const queryRaw = jest.fn().mockResolvedValue([])
  const observedTipUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip), update: observedTipUpdate },
    execRaw,
    queryRaw,
    txAbuseSignalCreate
  })
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 61, hash: 'deadbeef', height: 2172600, payment_id: 'wash2', piconeros: 1000000000n, fee: 0n, spent_outputs: [{ amount: '1000000000', sender: { maj_i: 0, min_i: 0 } }] }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'wash2', event: 'tx-confirmation', confirmations: 1, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const claimCall = execRaw.mock.calls.find(call => sqlOf(call).includes("state = 'EXCLUDED'") && sqlOf(call).includes("state = 'DETECTED'"))
  expect(claimCall).toBeDefined()
  expect([...claimCall].slice(1).flat()).toContain('SELF_SEND')
  // early return: the plain height/confirmations backfill never ran
  expect(observedTipUpdate).not.toHaveBeenCalled()
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-w3')
})

test('sub-maturity DETECTED callbacks on a scannable account verify the receipt once and write nothing', async () => {
  const tip = { id: 24, postId: 10, tipperId: 77, state: 'DETECTED', paymentId: 'clean2', piconeros: 1000000000n, height: 2172600, confirmations: 1, txHash: 'deadbeef', webhookEventId: 'evt-w4', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const observedTipUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip), update: observedTipUpdate }
  })
  // 6 confs from the chain view: verified, but below REQUIRED_CONFIRMATIONS.
  const monero = verifiedMonero('clean2', 1000000000, 'deadbeef', { height: 2172600, chainHeight: 2172605 })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'clean2', event: 'tx-confirmation', confirmations: 5, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // one lws lookup for the chain verification; no re-check (height already on
  // the row) and no callback tx_info/confirmations writes.
  expect(monero.getAddressTxs).toHaveBeenCalledTimes(1)
  expect(observedTipUpdate).not.toHaveBeenCalled()
})

test('N-conf self-send re-check fails closed on lws errors (non-200, lws retries the callback)', async () => {
  const tip = { id: 25, postId: 10, tipperId: 77, state: 'DETECTED', paymentId: 'wash3', piconeros: 1000000000n, rankPiconeros: 700000000n, height: 2172600, confirmations: 9, txHash: 'deadbeef', webhookEventId: 'evt-w5', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) } })
  const monero = mockMonero({ getAddressTxs: jest.fn().mockRejectedValue(new Error('lws down')) })
  const res = mockRes()
  // C4 verification runs before the exclusion re-check and converts the
  // transient lws failure into a structured 503 instead of an unhandled throw.
  await handleWebhook({
    body: { payment_id: 'wash3', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(503) // lws retries the callback
})

// ---- C4: verify tip receipts against the chain before crediting ----

test('tip branch: rejects a callback whose amount does not match the chain (no credit)', async () => {
  const tip = { id: 1, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'abc123', piconeros: 0n, webhookEventId: 'evt-1', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const txUpdate = jest.fn().mockResolvedValue({ ...tip, state: 'DETECTED' })
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }, txUpdate, execRaw })
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: 'deadbeef', payment_id: 'abc123', piconeros: 999n, spent_outputs: [] }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'abc123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(execRaw).not.toHaveBeenCalled() // no DETECTED claim, no ranking delta
  expect(alert).toHaveBeenCalledWith('warn', 'webhook receipt rejected', expect.stringContaining('amount_mismatch'), expect.anything())
})

test('0-conf (mempool) callback verifies against the chain and still detects', async () => {
  const tip = { id: 1, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'mempool1', piconeros: 0n, webhookEventId: 'evt-1', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const execRaw = jest.fn().mockResolvedValue(1)
  const queryRaw = jest.fn().mockResolvedValue([{ rank_delta: 700000000n }])
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }, execRaw, queryRaw })
  // mempool-shaped: hash present, no height, no spent_outputs. A tx_not_found
  // verdict here would be a 200 no-op (detection deferred to the next callback
  // / reconcilePendingTips backstop) — never a credit while unverified.
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: 'deadbeef', payment_id: 'mempool1', piconeros: 1000n }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'mempool1', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(execRaw).toHaveBeenCalled() // DETECTED claim still runs
})

test('v1.0.4 0-conf: a realistic pending lws receipt verifies the amount and detects with height NULL and amountVerifiedAt set', async () => {
  const tip = { id: 1, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'v104pid', piconeros: 0n, webhookEventId: 'evt-v104', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const execRaw = jest.fn().mockResolvedValue(1)
  const queryRaw = jest.fn().mockResolvedValue([{ rank_delta: 700000000n }])
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }, execRaw, queryRaw })
  // v1.0.4 REST CAN return the mempool row: hash, decrypted amount, matching
  // pid, height omitted, candidate spends present-but-unclosed (ordinary
  // incoming payment — NOT the closing self-send shape, which would exclude).
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      blockchain_height: 2172600,
      transactions: [{
        id: 3,
        hash: 'deadbeef',
        payment_id: 'v104pid',
        piconeros: 1000n,
        mempool: true,
        height: null,
        timestamp: null,
        fee: 10n,
        recipient: { maj_i: 0, min_i: 0 },
        spent_outputs: [{ amount: '999999', sender: { maj_i: 4, min_i: 2 } }] // foreign-only: unclosed
      }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'v104pid', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // Inspect the DETECTED claim's writes: verified hash bound, height NULL
  // (mempool), amountVerifiedAt stamped (lws verdict proves the amount).
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const claim = execRaw.mock.calls.find(call => sqlOf(call).includes("state = 'DETECTED'") && sqlOf(call).includes("state = 'PENDING'"))
  expect(claim).toBeDefined()
  const bound = [...claim].slice(1).flat()
  expect(bound).toContain('deadbeef')
  expect(bound).toContain(null) // height stays NULL for a pending receipt
  expect(bound).toContainEqual(expect.any(Date)) // amountVerifiedAt: lws-stamped
  // No CONFIRMED credit at detection time.
  expect(execRaw.mock.calls.map(sqlOf).some(sql => sql.includes("state = 'CONFIRMED'"))).toBe(false)
})

test('v1.0.4 0-conf: forged callback block/confirmations cannot mature a pending verified receipt', async () => {
  const tip = { id: 1, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'forgepid', piconeros: 0n, webhookEventId: 'evt-forge', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const execRaw = jest.fn().mockResolvedValue(1)
  const queryRaw = jest.fn().mockResolvedValue([{ rank_delta: 700000000n }])
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }, execRaw, queryRaw })
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      blockchain_height: 2172600,
      transactions: [{ id: 4, hash: 'cafe', payment_id: 'forgepid', piconeros: 1000n, mempool: true, height: null }]
    })
  })
  const res = mockRes()
  // The callback CLAIMS block 2172600 and 10 confirmations; the verified row is
  // still mempool (height null). Detection must not write the forged height and
  // must not flip CONFIRMED.
  await handleWebhook({
    body: { payment_id: 'forgepid', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'cafe', block: 2172600, amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  expect(execRaw.mock.calls.map(sqlOf).some(sql => sql.includes("state = 'CONFIRMED'"))).toBe(false)
  const claim = execRaw.mock.calls.find(call => sqlOf(call).includes("state = 'DETECTED'") && sqlOf(call).includes("state = 'PENDING'"))
  const bound = [...claim].slice(1).flat()
  expect(bound).toContain(null) // forged block never written as height
})

test('v1.0.4 replay: a lost detection claim applies the ranking effect once', async () => {
  const tip = { id: 1, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'replaypid', piconeros: 0n, webhookEventId: 'evt-replay', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const claimResults = [1, 0] // first callback wins; the concurrent replay loses
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const execRaw = jest.fn(async (...call) => {
    const sql = sqlOf(call)
    return sql.includes("state = 'DETECTED'") && sql.includes("state = 'PENDING'")
      ? claimResults.shift() ?? 0
      : 1
  })
  const queryRaw = jest.fn().mockResolvedValue([{ rank_delta: 700000000n }])
  // Both callbacks read the same PENDING snapshot; the second is the losing
  // concurrent claim (its guarded UPDATE returns 0 rows).
  const models = mockModels({ observedTip: { findFirst: jest.fn(async () => tip) }, execRaw, queryRaw })
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      blockchain_height: 2172600,
      transactions: [{ id: 5, hash: 'beef', payment_id: 'replaypid', piconeros: 1000n, mempool: true, height: null }]
    })
  })
  const body = { payment_id: 'replaypid', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'beef', amount: 1000 } }
  for (const res of [mockRes(), mockRes()]) {
    await handleWebhook({ body }, res, models, monero)
    expect(res.status).toHaveBeenCalledWith(200)
  }
  const sqls = execRaw.mock.calls.map(sqlOf)
  expect(sqls.filter(sql => sql.includes("state = 'DETECTED'") && sql.includes("state = 'PENDING'"))).toHaveLength(2)
  expect(sqls.filter(sql => sql.includes('SET "rankPiconeros"'))).toHaveLength(1)
  expect(queryRaw).toHaveBeenCalledTimes(1) // applyTipDetected ran once
  expect(sqls.some(sql => sql.includes("state = 'CONFIRMED'"))).toBe(false)
})

test('v1.0.4 mined: the N-conf callback on a now-mined lws row runs the existing finalization gates', async () => {
  const tip = { id: 1, postId: 10, tipperId: null, state: 'DETECTED', paymentId: 'minedpid', piconeros: 1000n, txHash: 'f00d', height: 2172600, webhookEventId: 'evt-mined', amountVerifiedAt: new Date(), post: { userId: 99 }, recipientAccount: scannableAccount() }
  const userUpdate = jest.fn().mockResolvedValue({})
  const execRaw = jest.fn().mockResolvedValue(1)
  const queryRaw = jest.fn().mockResolvedValue([{ rank_delta: 700000000n }])
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }, userUpdate, execRaw, queryRaw })
  // The receipt is now MINED: height present, maturity satisfied (chain 10 past).
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      blockchain_height: 2172609,
      transactions: [{ id: 5, hash: 'f00d', payment_id: 'minedpid', piconeros: 1000n, height: 2172600, mempool: false }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'minedpid', event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: 'f00d', block: 2172600, amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  expect(execRaw.mock.calls.map(sqlOf).some(sql => sql.includes("state = 'CONFIRMED'") && sql.includes("state = 'DETECTED'"))).toBe(true)
  expect(userUpdate).toHaveBeenCalled() // author credit only at maturity
})

test('0-conf tip with lws miss + daemon pid+ownership match is DETECTED (unbound, no miss check)', async () => {
  const tip = { id: 41, postId: 10, tipperId: null, state: 'PENDING', paymentId: DAEMON_PID, piconeros: 0n, webhookEventId: 'evt-d1', post: { userId: 99 }, recipientAccount: daemonAccount() }
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }, execRaw })
  // lws REST cannot see mempool txs, so only the daemon fallback can verify.
  const monero = mockMonero({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 10 }) })
  const daemon = { getTransactions: jest.fn().mockResolvedValue([{ hash: DAEMON_HASH, extra: daemonOwnedExtra(DAEMON_PID), vout: ownershipFixture.voutKeys }]) }
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: DAEMON_PID, event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: DAEMON_HASH, amount: 1000 } }
  }, res, models, monero, daemon)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(daemon.getTransactions).toHaveBeenCalledWith([DAEMON_HASH])
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  const sqls = execRaw.mock.calls.map(sqlOf)
  const claim = execRaw.mock.calls.find(call => sqlOf(call).includes("state = 'DETECTED'") && sqlOf(call).includes("state = 'PENDING'"))
  expect(claim).toBeDefined()
  // Written from the DAEMON verdict: the verified hash is bound, the height is
  // NULL (mempool), and the row is left UNSTAMPED — daemon proves tx + pid +
  // recipient-output ownership but never the RingCT amount, so the first lws
  // sight trust-corrects the provisional amount instead of trusting it.
  const bound = [...claim].slice(1).flat()
  expect(bound).toContain(DAEMON_HASH)
  expect(bound).toContain(null)
  expect(bound).not.toContainEqual(expect.any(Date))
  // a found receipt is not a miss: no delayed miss-check job and no alert
  expect(sqls.some(sql => sql.includes('webhookMissCheck'))).toBe(false)
  expect(alert).not.toHaveBeenCalled()
})

test('credit branch (N-conf) never spends a daemon RPC: lws miss is a 200 no-op, no credit', async () => {
  const tip = { id: 42, postId: 10, tipperId: 5, state: 'DETECTED', paymentId: DAEMON_PID, piconeros: 1000n, height: null, txHash: DAEMON_HASH, webhookEventId: 'evt-d2', amountVerifiedAt: null, post: { userId: 99 }, recipientAccount: daemonAccount() }
  const userUpdate = jest.fn().mockResolvedValue({})
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    userUpdate,
    execRaw
  })
  const monero = mockMonero({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 10 }) })
  // A daemon verdict would prove tx + pid + ownership but never the amount, so
  // a credit branch must reject it — and must not even buy the RPC.
  const daemon = { getTransactions: jest.fn().mockResolvedValue([{ hash: DAEMON_HASH, extra: daemonOwnedExtra(DAEMON_PID), vout: ownershipFixture.voutKeys }]) }
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: DAEMON_PID, event: 'tx-confirmation', confirmations: 10, tx_info: { tx_hash: DAEMON_HASH, block: 2172600, amount: 1000 } }
  }, res, models, monero, daemon)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(daemon.getTransactions).not.toHaveBeenCalled()
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  expect(execRaw.mock.calls.map(sqlOf).some(sql => sql.includes("state = 'CONFIRMED'"))).toBe(false)
  expect(userUpdate).not.toHaveBeenCalled()
})

// ---- C5: verify bounty receipts against the chain before bounty writes ----

test('bounty branch: rejects a callback whose amount does not match the chain (no receipt, pid map not consumed)', async () => {
  const bounty = { id: 7, postId: 5, state: 'PENDING', paymentId: 'bn123', webhookEventId: 'evt-b', recipientAccount: scannableAccount() }
  const execRaw = jest.fn().mockResolvedValue(1)
  const txPidMapUpdate = jest.fn().mockResolvedValue({})
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue({ paymentId: 'bn123', postId: 5, userId: 2 }) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    execRaw,
    txPidMapUpdate
  })
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: 'deadbeef', payment_id: 'bn123', piconeros: 1n, spent_outputs: [] }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 15000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(execRaw).not.toHaveBeenCalled()
  expect(txPidMapUpdate).not.toHaveBeenCalled()
})

test('bounty branch: returns 503 when the lws lookup fails (lws retries)', async () => {
  const bounty = { id: 7, postId: 5, state: 'PENDING', paymentId: 'bn123', webhookEventId: 'evt-b', recipientAccount: scannableAccount() }
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue({ paymentId: 'bn123', postId: 5, userId: 2 }) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) }
  })
  const monero = mockMonero({ getAddressTxs: jest.fn().mockRejectedValue(new Error('lws down')) })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn123', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 15000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(503)
})

test('bounty sub-conf branch: rejects a callback whose amount does not match the chain (no receipt recorded)', async () => {
  // A DETECTED bounty with confirmations < REQUIRED: these callbacks write
  // ObservedBountyReceipt rows and overwrite the row's txHash/height/
  // confirmations, feeding the cumulative sum that gates the FUNDED flip — a
  // fabricated-amount replay must be rejected before either write (C5.1).
  const bounty = { id: 11, postId: 8, state: 'DETECTED', paymentId: 'bn789', txHash: 'f00d1234', webhookEventId: 'evt-d', recipientAccount: scannableAccount() }
  const bountyUpdate = jest.fn().mockResolvedValue({})
  const txReceiptAggregate = jest.fn().mockResolvedValue({ _sum: { piconeros: null } })
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue(null) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty), update: bountyUpdate },
    txReceiptAggregate
  })
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: 'f00d1234', payment_id: 'bn789', piconeros: 1n, spent_outputs: [] }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bn789', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'f00d1234', block: 2172800, amount: 11000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // recordBountyReceipt never ran (no receipt-fold transaction at all)
  expect(models.$transaction).not.toHaveBeenCalled()
  expect(txReceiptAggregate).not.toHaveBeenCalled()
  // the bounty row's txHash/height/confirmations were not overwritten
  expect(bountyUpdate).not.toHaveBeenCalled()
})

// ---- downvote branch (dv: namespace via DownvotePidMap) ----

const dvMap = { paymentId: 'bb82f32561ab78d1', postId: 572, userId: 860, webhookEventId: 'evt-1', consumedAt: null, expiresAt: new Date(Date.now() + 3600e3) }

function dvBody (over = {}) {
  return {
    payment_id: 'bb82f32561ab78d1',
    confirmations: 0,
    tx_info: { tx_hash: 'd7553c1400000000000000000000000000000000000000000000000000000000', amount: '1000000000', ...over.txInfo },
    ...over.extra
  }
}

test('0-conf callback claims the live pid map, inserts the row PROVISIONAL (height NULL), transitions it to the lws-verified height and applies the penalty', async () => {
  const LWS_HEIGHT = 2172600
  const TX_HASH = 'd7553c1400000000000000000000000000000000000000000000000000000000'
  const rewards = { id: 9, label: 'platform_rewards', status: 'ACTIVE', address: 'R', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(dvMap) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(rewards) },
    item: { findUnique: jest.fn().mockResolvedValue({ id: 572, parentId: null }) }
  })
  models.$executeRaw = jest.fn().mockResolvedValue(1) // pid-map claim wins; penalty CTE succeeds
  models.$queryRaw = jest.fn()
    .mockResolvedValueOnce([{ id: 1n }]) // fresh ObservedDownvote insert (height NULL)
    .mockResolvedValueOnce([{ id: 1n }]) // the shared transition CAS wins
  const monero = verifiedMonero(dvMap.paymentId, 1000000000n, TX_HASH, { height: LWS_HEIGHT, chainHeight: LWS_HEIGHT + 5 })
  const res = mockRes()

  await handleWebhook({ body: dvBody(), headers: {} }, res, models, monero)

  // The claim is a tagged-template $executeRaw (strings + values args), so
  // assert on the recorded SQL via the harness's sqlOf pattern (the brief's
  // "assert via the mock below if the harness records SQL differently").
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join(' ') : call[0].text
  const sqls = models.$executeRaw.mock.calls.map(sqlOf)
  expect(sqls.some(sql => sql.includes('UPDATE "DownvotePidMap"') && sql.includes('"consumedAt" IS NULL') && sql.includes('"expiresAt" > NOW()'))).toBe(true) // atomic live-map claim UPDATE
  // The insert is PROVISIONAL: height NULL, never the callback tx_info.block.
  const insertSql = sqlOf(models.$queryRaw.mock.calls[0])
  expect(insertSql).toContain('INSERT INTO "ObservedDownvote"')
  expect(insertSql).toContain(", NULL, 'DETECTED'")
  // ...then the shared NULL->height transition binds the lws-verified height.
  const [casStrings, ...casVals] = models.$queryRaw.mock.calls[1]
  const casSql = Array.isArray(casStrings) ? casStrings.join(' ') : casStrings.text
  expect(casSql).toContain('UPDATE "ObservedDownvote"')
  expect(casSql).toContain('height IS NULL')
  expect(casVals).toEqual(expect.arrayContaining([LWS_HEIGHT, 1000000000n, 1n]))
  // The penalty CTE ran via the shared transition (in addition to the map claim).
  expect(sqls.some(sql => sql.includes('ItemUserAgg'))).toBe(true)
  expect(models.observedDownvote.update).not.toHaveBeenCalled()
  expect(monero.deleteWebhook).not.toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(200)
})

test('expired or consumed pid map is a 200 no-op (claim UPDATE matched 0 rows)', async () => {
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue({ ...dvMap, consumedAt: new Date() }) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() }
  })
  models.$executeRaw = jest.fn().mockResolvedValue(0) // claim loses
  const res = mockRes()

  await handleWebhook({ body: dvBody(), headers: {} }, res, models, mockMonero())

  expect(models.$queryRaw).not.toHaveBeenCalled() // no insert, no penalty
  expect(res.status).toHaveBeenCalledWith(200)
})

test('downvote 0-conf verification does NOT advance the observer cursor on the rewards account (starvation regression, audit finding 1)', async () => {
  // lws hands the verification lookup BOTH an unattributed fee tx (id 101)
  // and the downvote (id 102). Pre-fix, lookupTipTx advanced
  // MoneroAccount.lastTxId to 102 here and rewardsWalletObserver — the ONLY
  // attributor for fee-subaddress outputs — never saw tx 101 again.
  const rewards = {
    id: 9,
    label: 'platform_rewards',
    address: 'R',
    status: 'ACTIVE',
    viewKey: { ciphertext: Buffer.alloc(0) },
    lastTxId: 100n,
    subaddresses: []
  }
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue({ ...dvMap, paymentId: 'dvx', webhookEventId: null }) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    moneroAccount: { findFirst: jest.fn().mockResolvedValue(rewards), updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
  })
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [
        { id: 101, hash: 'feee', payment_id: null, piconeros: 1n },
        { id: 102, hash: 'd7553c14', payment_id: 'dvx', piconeros: 1000000000n }
      ]
    })
  })
  const res = mockRes()

  await handleWebhook({ body: { payment_id: 'dvx', confirmations: 0, tx_info: { tx_hash: 'd7553c14', amount: '1000000000' } } }, res, models, monero)

  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.moneroAccount.updateMany).not.toHaveBeenCalled() // the watermark stays observer-owned
})

test('sub-N DETECTED callback transitions using ONLY the lws-verified height — no callback tx_info writes (D9 residual)', async () => {
  const CALLBACK_BLOCK = 2999999
  const LWS_HEIGHT = 2172600
  const TX_HASH = 'd7553c1400000000000000000000000000000000000000000000000000000000'
  const rewards = { id: 9, label: 'platform_rewards', status: 'ACTIVE', address: 'R', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
  const consumedMap = { ...dvMap, consumedAt: new Date() } // map already consumed — must not gate
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(consumedMap) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue({ id: 1n, state: 'DETECTED', height: null, postId: 572, downvoterId: 860 }), update: jest.fn() },
    moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(rewards) }
  })
  const monero = verifiedMonero(dvMap.paymentId, 1000000000n, TX_HASH, { height: LWS_HEIGHT, chainHeight: LWS_HEIGHT + 5 })
  const res = mockRes()

  await handleWebhook({ body: dvBody({ txInfo: { block: CALLBACK_BLOCK }, extra: { confirmations: 3 } }) }, res, models, monero)

  expect(res.status).toHaveBeenCalledWith(200)
  // The unverified callback write is gone...
  expect(models.observedDownvote.update).not.toHaveBeenCalled()
  // ...replaced by the shared transition CAS bound to the lws-verified values.
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join(' ') : call[0].text
  const casCall = models.$queryRaw.mock.calls.find(c => sqlOf(c).includes('UPDATE "ObservedDownvote"'))
  expect(casCall).toBeTruthy()
  expect(sqlOf(casCall)).toContain('height IS NULL')
  expect(casCall.slice(1)).toEqual(expect.arrayContaining([LWS_HEIGHT, 1000000000n, 6, 1n]))
  // The attacker-controlled callback tx_info.block never reaches the row.
  expect(casCall.slice(1)).not.toContain(CALLBACK_BLOCK)
})

test('N>=REQUIRED callback flips DETECTED -> CONFIRMED and deletes the webhook', async () => {
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(dvMap) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue({ id: 1n, state: 'DETECTED', height: 2186635, postId: 572, downvoterId: 860 }), update: jest.fn() }
  })
  models.$executeRaw = jest.fn().mockResolvedValue(1) // CONFIRMED claim wins
  const monero = mockMonero()
  const res = mockRes()

  await handleWebhook({ body: dvBody({ extra: { confirmations: 10 } }) }, res, models, monero)

  // A height-set row has already had its penalty applied by the NULL->height
  // transition, so this flip is safe metadata: guarded UPDATE, then delete.
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join(' ') : call[0].text
  const flip = models.$executeRaw.mock.calls.map(sqlOf).find(sql => sql.includes('UPDATE "ObservedDownvote"'))
  expect(flip).toContain("SET state = 'CONFIRMED'")
  expect(flip).toContain("state = 'DETECTED'")
  expect(monero.deleteWebhook).toHaveBeenCalledWith('evt-1')
  expect(models.$queryRaw).not.toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(200)
})

test('N-conf callback for a height-NULL DETECTED downvote does NOT flip CONFIRMED (waits for the verified transition)', async () => {
  // Regression: the N-conf branch used to flip ANY DETECTED row on the
  // callback's confirmations alone. For a height-NULL row that pre-empted the
  // verified NULL->height transition, leaving the row CONFIRMED-but-height-NULL
  // with its penalty never applied (the finalizer only matures height-set rows).
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(dvMap) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue({ id: 1n, state: 'DETECTED', height: null, postId: 572, downvoterId: 860 }), update: jest.fn() }
  })
  models.$executeRaw = jest.fn().mockResolvedValue(1) // would be the CONFIRMED claim's rowCount pre-fix
  const monero = mockMonero() // no lws sight -> the transition stays a no-op this delivery
  const res = mockRes()

  await handleWebhook({ body: dvBody({ extra: { confirmations: 10 } }) }, res, models, monero)

  expect(res.status).toHaveBeenCalledWith(200)
  // No CONFIRMED flip: the callback must not pre-empt the shared transition.
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join(' ') : call[0].text
  expect(models.$executeRaw.mock.calls.map(sqlOf).some(sql => sql.includes("SET state = 'CONFIRMED'"))).toBe(false)
  expect(monero.deleteWebhook).not.toHaveBeenCalled()
  // No transition and no penalty: the row stays DETECTED for observer/webhook
  // DETECTED/backfill paths to transition once a verified height exists.
  expect(models.$queryRaw).not.toHaveBeenCalled()
})

test('0-conf race vs poll-insert: pid-map claim wins but the ObservedDownvote insert loses (conflict no-op)', async () => {
  // Spec-mandated race case: the webhook's pid-map claim UPDATE wins (rowCount 1)
  // while the observer poll already inserted the ObservedDownvote row, so the
  // ON CONFLICT ("txHash","paymentId") DO NOTHING insert returns no row. The tx
  // must return BEFORE the item fetch — no penalty side effects, no error, 200.
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(dvMap) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    item: { findUnique: jest.fn().mockResolvedValue({ id: 572, parentId: null }) }
  })
  models.$executeRaw = jest.fn().mockResolvedValue(1) // pid-map claim WINS
  models.$transaction = jest.fn(async (fn) => fn(models))
  models.$queryRaw = jest.fn().mockResolvedValue([]) // insert lost the race: no RETURNING row
  const monero = mockMonero()
  const res = mockRes()

  await handleWebhook({ body: dvBody(), headers: {} }, res, models, monero)

  // The tx bailed before the item fetch: no penalty path ran (the models object
  // doubles as the tx here, so tx.item.findUnique === models.item.findUnique).
  expect(models.item.findUnique).not.toHaveBeenCalled()
  expect(models.observedDownvote.update).not.toHaveBeenCalled()
  expect(monero.deleteWebhook).not.toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(200)
})

test('downvote branch: rejects a callback whose amount does not match the chain (pid map not consumed)', async () => {
  // C6: the verdict must be computed BEFORE the claimedMap UPDATE — a rejected
  // callback must not consume the DownvotePidMap, or the downvote is lost (the
  // poll backstop keys attribution on the map). Downvotes pay the rewards
  // PRIMARY address, so verification runs against the platform_rewards wallet.
  const REWARDS_ACCOUNT = { id: 2047, label: 'platform_rewards', status: 'ACTIVE', address: 'REWARDS', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
  const models = mockModels({
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(dvMap) },
    observedDownvote: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(REWARDS_ACCOUNT) }
  })
  models.$executeRaw = jest.fn().mockResolvedValue(1)
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: 'd7553c1400000000000000000000000000000000000000000000000000000000', payment_id: dvMap.paymentId, piconeros: 1n, spent_outputs: [] }]
    })
  })
  const res = mockRes()
  await handleWebhook({ body: dvBody(), headers: {} }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(models.$executeRaw).not.toHaveBeenCalled() // map not consumed, no insert
})

// ---- fee: branch (owner-routed turf fees via PayIn.moneroPaymentId) ----

describe('fee: branch (owner-routed turf fees)', () => {
  const pid = 'aabbccddeeff0011'
  // URI quotes 0.001 XMR = 1e9 piconeros — the cumulative gate's threshold.
  const basePayIn = { id: 101, payInType: 'ITEM_CREATE', moneroPaymentId: pid, moneroUri: 'monero:9?tx_amount=0.001', piconeros: 0n }

  // Stateful receipt mock over mockModels: the ObservedSubFee insert is fresh
  // iff no prior receipt carries the callback's txHash (ON CONFLICT
  // ("txHash","paymentId") DO NOTHING ... RETURNING id), and the aggregate
  // re-sums the receipts on every call so top-ups move the cumulative total
  // (mockResolvedValue would freeze the sum at setup time).
  function feeModels ({ payIn = basePayIn, mapRow = null, receipts = [] } = {}) {
    const inserted = []
    const models = mockModels({
      payIn: {
        findUnique: jest.fn().mockImplementation(async ({ where }) =>
          where.moneroPaymentId === pid ? payIn : null)
      },
      subFeePidMap: {
        findUnique: jest.fn().mockImplementation(async ({ where }) =>
          where.paymentId === pid ? mapRow : null)
      },
      observedSubFee: {
        aggregate: jest.fn().mockImplementation(async () => ({
          _sum: { piconeros: receipts.reduce((sum, r) => sum + (r.piconeros ?? 0n), 0n) }
        }))
      },
      // Tagged-template query mock. Bound params in insert order:
      // [txHash, paymentId, payInId, piconeros, height, confirmations].
      // jest.fn so the recorded SQL strings are assertable (sqlOf idiom) —
      // guards the physical snake_case column names against 42703 regressions
      // (the mock would otherwise happily run camelCase SQL). SQL-shape aware:
      // only INSERT INTO records a fresh receipt; the CAS UPDATE claims the
      // existing row (transitioned) and the prior-read SELECT returns none.
      queryRaw: jest.fn(async (strings, ...vals) => {
        const sql = Array.isArray(strings) ? strings.join('') : String(strings)
        if (!sql.includes('"ObservedSubFee"')) return []
        if (sql.includes('INSERT INTO')) {
          const txHash = vals[0]
          if (receipts.some(r => r.txHash === txHash)) return []
          const row = { id: receipts.length + 1, txHash, paymentId: pid, payInId: vals[2] ?? null, piconeros: vals[3] }
          receipts.push(row)
          inserted.push(row)
          return [row]
        }
        if (sql.includes('UPDATE')) return [{ id: 1 }]
        return []
      })
    })
    return { models, inserted }
  }

  test('records a DETECTED receipt and flips the item live once cumulative covers the URI amount', async () => {
    const { models, inserted } = feeModels()
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 0, tx_info: { tx_hash: 'tx1', amount: '500000000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].txHash).toBe('tx1')
    // Physical-column regression guard (42703): the tables are snake_case-mapped
    // (tx_hash/payment_id/pay_in_id/owner_user_id/detected_at), NOT camelCase
    // like ObservedTip — camelCase identifiers here would throw at runtime
    // while the mocked $queryRaw happily executed them.
    const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
    const insertSql = models.$queryRaw.mock.calls.map(sqlOf).find(sql => sql.includes('INSERT INTO "ObservedSubFee"'))
    expect(insertSql).toBeDefined()
    expect(insertSql).toContain('tx_hash')
    expect(insertSql).toContain('payment_id')
    expect(insertSql).not.toContain('"txHash"')
    // covered (5e11 observed >= 1e9 quoted): the cumulative gate opens
    expect(flipPendingToLive).toHaveBeenCalledWith(models, expect.objectContaining({ id: 101 }), 500000000000n)
    // the boost bump is BOOST-payins-only
    expect(applyBoostDetected).not.toHaveBeenCalled()
  })

  test('is a 200 no-op for an unknown payment id', async () => {
    const { models, inserted } = feeModels({ payIn: null })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: 'ffffffffffffffff', tx_info: { tx_hash: 'txX' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(0)
    expect(flipPendingToLive).not.toHaveBeenCalled()
  })

  // T2 (2026-09-19 review finding) end-to-end: a real fee tx for THIS leg can
  // no longer be re-attributed to a DIFFERENT pending pid on the same owner
  // account. The lws tx is found by hash, but its pid differs from the claim —
  // the verification seam rejects pid_mismatch and nothing is recorded.
  test('SECURITY: a real owner tx carrying a DIFFERENT pid is rejected for this leg (pid binding)', async () => {
    const OWNER_ACCOUNT = { id: 55, label: 'author', status: 'ACTIVE', address: 'OWNER', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
    const { models, inserted } = feeModels({ mapRow: { ownerUserId: 42, subName: 'test' } })
    models.moneroAccount.findFirst = jest.fn().mockResolvedValue(OWNER_ACCOUNT)
    const res = mockRes()
    const monero = mockMonero({
      getAddressTxs: jest.fn().mockResolvedValue({
        transactions: [{ id: 1, hash: 'tx-real', payment_id: 'otherlegpid', piconeros: 500000000000n, spent_outputs: [], height: 100 }],
        blockchain_height: 110
      })
    })
    await handleWebhook({ body: { payment_id: pid, confirmations: 0, tx_info: { tx_hash: 'tx-real', amount: '500000000000' } }, headers: {} }, res, models, monero, { getTransactions: jest.fn().mockResolvedValue([]) })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(0)
    expect(flipPendingToLive).not.toHaveBeenCalled()
  })

  // SELF-PAYMENT BAN (2026-09-19 incident) end-to-end. A zero-change self-send
  // (payer == owner account) makes lws's total_received equal the real payment,
  // so verification passes — the isSelfSend refusal is what stops the credit,
  // excludes any height-NULL provisional row, and alerts (deduped).
  test('self-paid leg: a zero-change self-send passes verification but is refused (no receipt, no flip)', async () => {
    const OWNER_ACCOUNT = { id: 55, label: 'author', status: 'ACTIVE', address: 'OWNER', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
    const { models, inserted } = feeModels({ mapRow: { ownerUserId: 42, subName: 'test' } })
    models.moneroAccount.findFirst = jest.fn().mockResolvedValue(OWNER_ACCOUNT)
    const res = mockRes()
    const monero = mockMonero({
      getAddressTxs: jest.fn().mockResolvedValue({
        transactions: [{
          id: 1,
          hash: 'tx-self',
          payment_id: pid,
          piconeros: 1000000000n, // zero change: lws total == the real payment
          fee: 0n,
          spent_outputs: [{ amount: '1000000000', out_index: 1, sender: { maj_i: 0, min_i: 0 } }],
          height: 100
        }],
        blockchain_height: 110
      })
    })
    await handleWebhook({ body: { payment_id: pid, confirmations: 12, tx_info: { tx_hash: 'tx-self', amount: '1000000000' } }, headers: {} }, res, models, monero)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(0)
    expect(flipPendingToLive).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('warn', 'owner-fee self-payment refused',
      expect.stringContaining(pid),
      expect.objectContaining({ dedupeKey: `subfee-selfpay-${pid}-tx-self` }))
    // the provisional-row cleanup ran (EXCLUDED the height-NULL receipt)
    const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
    const excludeSql = models.$executeRaw.mock.calls.map(sqlOf).find(sql => sql.includes("'EXCLUDED'"))
    expect(excludeSql).toBeDefined()
    expect(excludeSql).toContain('"tx_hash"')
    expect(excludeSql).toContain('height IS NULL')
  })

  // The 356120 shape: lws fires one event PER OUTPUT, so the change-output
  // callback claims the change while lws's per-tx total folds in change +
  // payment — verification rejects the amount mismatch before anything is
  // recorded. The ban holds through the reject seam alone.
  test('self-paid leg: a change-inflated per-output claim is rejected as an amount mismatch (nothing recorded)', async () => {
    const OWNER_ACCOUNT = { id: 55, label: 'author', status: 'ACTIVE', address: 'OWNER', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
    const { models, inserted } = feeModels({ mapRow: { ownerUserId: 42, subName: 'test' } })
    models.moneroAccount.findFirst = jest.fn().mockResolvedValue(OWNER_ACCOUNT)
    const res = mockRes()
    const monero = mockMonero({
      getAddressTxs: jest.fn().mockResolvedValue({
        transactions: [{
          id: 1,
          hash: 'tx-self',
          payment_id: pid,
          piconeros: 1256080000n, // change (1056080000) + real payment (200000000)
          spent_outputs: [{ amount: '8211616401492', out_index: 1, sender: { maj_i: 0, min_i: 0 } }],
          height: 100
        }],
        blockchain_height: 110
      })
    })
    await handleWebhook({ body: { payment_id: pid, confirmations: 12, tx_info: { tx_hash: 'tx-self', amount: '1056080000' } }, headers: {} }, res, models, monero)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(0)
    expect(flipPendingToLive).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('warn', 'webhook receipt rejected',
      expect.stringContaining('amount_mismatch'),
      expect.objectContaining({ dedupeKey: `webhook-reject-${pid}-amount_mismatch` }))
  })

  // DAEMON OVER-CLAIM BOUND: lws cannot see a mempool tx, so the daemon level
  // verifies the tx but not the RingCT amount (and carries no spent_outputs for
  // the self-send check). A claim above the quoted fee is never a legitimate
  // top-up — refuse it instead of seeding a display-only provisional row.
  test('daemon-verdict claim above the quoted fee is refused (no provisional row)', async () => {
    const { models } = feeModels({ mapRow: { ownerUserId: 42, subName: 'test' } })
    models.payIn.findUnique = jest.fn().mockImplementation(async ({ where }) =>
      where.moneroPaymentId === DAEMON_PID
        ? { ...basePayIn, id: 202, moneroPaymentId: DAEMON_PID }
        : null)
    models.subFeePidMap.findUnique = jest.fn().mockResolvedValue({ paymentId: DAEMON_PID, subName: 'test', ownerUserId: 42 })
    models.moneroAccount.findFirst = jest.fn().mockResolvedValue(daemonAccount())
    const monero = mockMonero({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 10 }) }) // lws cannot see it
    const daemon = { getTransactions: jest.fn().mockResolvedValue([{ hash: DAEMON_HASH, extra: daemonOwnedExtra(DAEMON_PID), vout: ownershipFixture.voutKeys }]) }
    const res = mockRes()
    await handleWebhook({
      body: { payment_id: DAEMON_PID, confirmations: 0, tx_info: { tx_hash: DAEMON_HASH, block: 2172600, amount: '9000000000' } },
      headers: {}
    }, res, models, monero, daemon)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(alert).toHaveBeenCalledWith('warn', 'owner-fee over-claim refused',
      expect.stringContaining(DAEMON_PID),
      expect.objectContaining({ dedupeKey: `subfee-overclaim-${DAEMON_PID}` }))
    const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
    const sqls = models.$queryRaw.mock.calls.map(sqlOf)
    expect(sqls.some(sql => sql.includes('INSERT INTO "ObservedSubFee"'))).toBe(false)
    expect(flipPendingToLive).not.toHaveBeenCalled()
  })

  test('top-up receipts accumulate toward the gate (second tx inserts a second row)', async () => {
    const receipts = [{ id: 1, txHash: 'tx1', paymentId: pid, piconeros: 500000000000n }]
    const { models, inserted } = feeModels({ receipts })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 0, tx_info: { tx_hash: 'tx2', amount: '500000000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].txHash).toBe('tx2')
    // cumulative 1e12 after the top-up: the flip carries the summed total
    expect(flipPendingToLive).toHaveBeenCalledWith(models, expect.objectContaining({ id: 101 }), 1000000000000n)
  })

  test('an under-paid fee does NOT flip (gate closed until cumulative covers the URI amount)', async () => {
    const { models, inserted } = feeModels()
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 0, tx_info: { tx_hash: 'tx1', amount: '500000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    // the receipt is still recorded (top-up-able) ...
    expect(inserted).toHaveLength(1)
    // ... but 5e8 observed < 1e9 quoted keeps the gated item PENDING_FEE
    expect(flipPendingToLive).not.toHaveBeenCalled()
  })

  test('N-conf callback matures THIS receipt DETECTED -> CONFIRMED; a replayed txHash at N-conf inserts nothing and never double-flips', async () => {
    const { models, inserted } = feeModels()
    const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text

    // fresh txHash at N confs (>= REQUIRED_CONFIRMATIONS): the receipt is
    // recorded AND matured by the atomic conditional UPDATE in one callback.
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 12, tx_info: { tx_hash: 'txN', amount: '500000000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].txHash).toBe('txN')
    // the maturity UPDATE ran, with the same shape as the tip/downvote
    // CONFIRMED flips AND the physical snake_case columns in its WHERE/SET
    const sqls = models.$executeRaw.mock.calls.map(sqlOf)
    expect(sqls.some(sql => sql.includes("state = 'CONFIRMED'") && sql.includes("state = 'DETECTED'"))).toBe(true)
    expect(sqls.some(sql => sql.includes('UPDATE "ObservedSubFee"') && sql.includes('"tx_hash"') && sql.includes('"confirmed_at"'))).toBe(true)

    // replay of the SAME txHash at N confs (lws retry / duplicate delivery):
    // the ON CONFLICT no-op means no second receipt row ...
    const res2 = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 12, tx_info: { tx_hash: 'txN', amount: '500000000000' } }, headers: {} }, res2, models, mockMonero())
    expect(res2.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(1)
    // ... and the cumulative gate re-runs only as the idempotent self-heal:
    // once per callback, with the SAME cumulative total (never a doubled
    // amount from re-counting the replayed receipt).
    const flips = flipPendingToLive.mock.calls.filter(c => c[1]?.id === 101)
    expect(flips).toHaveLength(2)
    expect(flips[0][2]).toBe(500000000000n)
    expect(flips[1][2]).toBe(500000000000n)
  })

  test('a scannable owner with FORGED confirmations does not mature the receipt — maturity is chain-derived', async () => {
    // The callback claims 12 confirmations; the chain says the lws-verified tx
    // is 3 blocks deep. A forged count must not reach the applier's maturity
    // gate: the webhook derives tip - height + 1 and passes THAT.
    const OWNER_ACCOUNT = { id: 55, label: 'author', status: 'ACTIVE', address: 'OWNER', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
    const { models } = feeModels({ mapRow: { ownerUserId: 42, subName: 'test' } })
    models.moneroAccount.findFirst = jest.fn().mockResolvedValue(OWNER_ACCOUNT)
    const casVals = []
    models.$queryRaw = jest.fn(async (strings, ...vals) => {
      const sql = Array.isArray(strings) ? strings.join('') : String(strings)
      if (sql.includes('UPDATE "ObservedSubFee"')) { casVals.push(vals); return [{ id: 1 }] }
      return []
    })
    const monero = verifiedMonero(pid, 500000000000n, 'txF1', { height: 2172600, chainHeight: 2172602 })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 12, tx_info: { tx_hash: 'txF1', amount: '500000000000' } }, headers: {} }, res, models, monero)
    expect(res.status).toHaveBeenCalledWith(200)
    // no maturity flip: derived 3 < REQUIRED_CONFIRMATIONS
    expect(models.$executeRaw).not.toHaveBeenCalled()
    // the receipt's height-claim CAS recorded the DERIVED count
    expect(casVals).toHaveLength(1)
    expect(casVals[0]).toContain(3)
    expect(casVals[0]).not.toContain(12)
  })

  test('the abandoned-fee-leg applier call site also derives maturity from the chain, not the callback', async () => {
    const OWNER_ACCOUNT = { id: 56, label: 'author', status: 'ACTIVE', address: 'OWNER2', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
    const { models } = feeModels({ payIn: null, mapRow: { ownerUserId: 43, subName: 'turf', expiresAt: new Date(Date.now() - 3600e3) } })
    models.moneroAccount.findFirst = jest.fn().mockResolvedValue(OWNER_ACCOUNT)
    const casVals = []
    models.$queryRaw = jest.fn(async (strings, ...vals) => {
      const sql = Array.isArray(strings) ? strings.join('') : String(strings)
      if (sql.includes('UPDATE "ObservedSubFee"')) { casVals.push(vals); return [{ id: 1 }] }
      return []
    })
    const monero = verifiedMonero(pid, 1000000000000n, 'txL2', { height: 2172600, chainHeight: 2172602 })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 12, tx_info: { tx_hash: 'txL2', amount: '1000000000000' } }, headers: {} }, res, models, monero)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(models.$executeRaw).not.toHaveBeenCalled()
    expect(casVals).toHaveLength(1)
    expect(casVals[0]).toContain(3)
    expect(casVals[0]).not.toContain(12)
  })

  test('a replayed txHash inserts nothing (idempotent)', async () => {
    const receipts = [{ id: 1, txHash: 'tx1', paymentId: pid, piconeros: 1000000000000n }]
    const { models, inserted } = feeModels({ receipts })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 3, tx_info: { tx_hash: 'tx1', amount: '1000000000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(0)
    // the cumulative gate still runs on the conflict path (observer self-heal
    // semantics — a stranded PENDING_FEE item re-flips idempotently)
    expect(flipPendingToLive).toHaveBeenCalledWith(models, expect.objectContaining({ id: 101 }), 1000000000000n)
  })

  test('rejects a callback whose amount does not match the chain (no receipt recorded)', async () => {
    // C6: a token-holding replay with a fabricated amount must never seed a
    // receipt nor open the cumulative gate. The owner account comes from the
    // pid map (ownerFeeLeg creates a map row for every owner-routed leg).
    const OWNER_ACCOUNT = { id: 55, label: 'author', status: 'ACTIVE', address: 'OWNER', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
    const { models, inserted } = feeModels({ mapRow: { ownerUserId: 42, subName: 'test' } })
    models.moneroAccount.findFirst = jest.fn().mockResolvedValue(OWNER_ACCOUNT)
    const monero = mockMonero({
      getAddressTxs: jest.fn().mockResolvedValue({
        transactions: [{ id: 1, hash: 'tx1', payment_id: pid, piconeros: 1n, spent_outputs: [] }]
      })
    })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 0, tx_info: { tx_hash: 'tx1', amount: '500000000000' } }, headers: {} }, res, models, monero)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(0)
    expect(flipPendingToLive).not.toHaveBeenCalled()
  })

  test('a daemon-verified 0-conf owner fee records a PROVISIONAL (height-null) receipt — neither the callback block nor its confirmation count can mature an unverified amount', async () => {
    // Same 0-conf admission as the bounty detection branch: a daemon verdict
    // proves tx + pid + recipient output but NOT the RingCT amount, so the
    // callback's attacker-supplied tx_info.block must never claim a receipt
    // height. The applier's atomic NULL->height CAS is the only height source.
    // The N-conf count is attacker-supplied too: a forged confirmations: 12
    // must not mature a receipt whose height is still unverified (fee
    // maturities are lws credit paths).
    const { models } = feeModels({ mapRow: { ownerUserId: 42, subName: 'test' } })
    models.payIn.findUnique = jest.fn().mockImplementation(async ({ where }) =>
      where.moneroPaymentId === DAEMON_PID
        ? { ...basePayIn, id: 202, moneroPaymentId: DAEMON_PID }
        : null)
    models.subFeePidMap.findUnique = jest.fn().mockResolvedValue({ paymentId: DAEMON_PID, subName: 'test', ownerUserId: 42 })
    models.moneroAccount.findFirst = jest.fn().mockResolvedValue(daemonAccount())
    // The shared feeModels aggregate ignores the query's height filter; the
    // real gate sums count-eligible receipts only, and this receipt is
    // provisional (height NULL, no CAS above) -> counted 0.
    models.observedSubFee.aggregate = jest.fn().mockResolvedValue({ _sum: { piconeros: 0n } })
    const monero = mockMonero({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 10 }) })
    const daemon = { getTransactions: jest.fn().mockResolvedValue([{ hash: DAEMON_HASH, extra: daemonOwnedExtra(DAEMON_PID), vout: ownershipFixture.voutKeys }]) }
    const res = mockRes()
    await handleWebhook({
      body: { payment_id: DAEMON_PID, confirmations: 12, tx_info: { tx_hash: DAEMON_HASH, block: 2172600, amount: '500000000' } },
      headers: {}
    }, res, models, monero, daemon)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(daemon.getTransactions).toHaveBeenCalledWith([DAEMON_HASH])
    const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
    const sqls = models.$queryRaw.mock.calls.map(sqlOf)
    expect(sqls.some(sql => sql.includes('INSERT INTO "ObservedSubFee"'))).toBe(true)
    // No CAS: the receipt stays height-NULL (display-only) until an lws sight.
    expect(sqls.some(sql => sql.includes('UPDATE "ObservedSubFee"'))).toBe(false)
    // The gate query stays count-eligible...
    expect(models.observedSubFee.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ height: { not: null } })
    }))
    // ...so no maturity flip and no live flip: the provisional receipt cannot
    // reach a credit/maturity write on the callback's confirmation count.
    expect(models.$executeRaw).not.toHaveBeenCalled()
    expect(flipPendingToLive).not.toHaveBeenCalled()
  })

  test('payment on an abandoned fee leg (payIn deleted, map row remains) records a null-payInId receipt and pages operators', async () => {
    // abandonFeeItems deleted the PayIn (underpaid past the window) but the
    // SubFeePidMap row persists for attribution: the receipt is still recorded
    // for ledger visibility (no payInId linkage — there is no PayIn to link)
    // and operators are paged — bounty-branch parity.
    const mapRow = { paymentId: pid, subName: 'turf', ownerUserId: 7, expiresAt: new Date(Date.now() - 3600e3) }
    const { models, inserted } = feeModels({ payIn: null, mapRow })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, confirmations: 0, tx_info: { tx_hash: 'txL', amount: '1000000000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].txHash).toBe('txL')
    expect(inserted[0].payInId).toBeNull()
    // no PayIn -> no gate/flip to run
    expect(flipPendingToLive).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('critical', 'payment arrived after fee abandonment',
      expect.stringContaining('turf'), { dedupeKey: `subfee-late-payment-${pid}` })
  })

  test('money on a fee pid with NO PayIn and NO map row falls through to the downvote dispatch (unknown pid stays a silent no-op)', async () => {
    const { models, inserted } = feeModels({ payIn: null, mapRow: null })
    const res = mockRes()
    await handleWebhook({ body: { payment_id: pid, tx_info: { tx_hash: 'txU', amount: '1000000000000' } }, headers: {} }, res, models, mockMonero())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(inserted).toHaveLength(0)
    expect(alert).not.toHaveBeenCalled()
    // the abandoned-fee check must NOT swallow the downvote fall-through
    expect(models.downvotePidMap.findUnique).toHaveBeenCalled()
  })
})

// --- auth-denial tests (Task 3 / C4) ---
const _origNodeEnv = process.env.NODE_ENV
const _origToken = process.env.LWS_WEBHOOK_TOKEN
afterEach(() => {
  process.env.NODE_ENV = _origNodeEnv
  if (_origToken === undefined) delete process.env.LWS_WEBHOOK_TOKEN
  else process.env.LWS_WEBHOOK_TOKEN = _origToken
})

test('rejects with 401 in production when LWS_WEBHOOK_TOKEN is not configured', async () => {
  process.env.NODE_ENV = 'production'
  delete process.env.LWS_WEBHOOK_TOKEN
  const res = mockRes()
  await handleWebhook({ method: 'POST', headers: {}, body: {} }, res, mockModels(), mockMonero())
  expect(res.status).toHaveBeenLastCalledWith(401)
})

test('rejects with 401 when the x-lws-token header does not match', async () => {
  process.env.NODE_ENV = 'production'
  process.env.LWS_WEBHOOK_TOKEN = 'real-token'
  const res = mockRes()
  await handleWebhook(
    { method: 'POST', headers: { 'x-lws-token': 'wrong' }, body: {} },
    res, mockModels(), mockMonero())
  expect(res.status).toHaveBeenLastCalledWith(401)
})

// ---- tx_not_found: only when BOTH lws and the daemon miss ----

test('0-conf lws miss + daemon miss stays PENDING: logs (no page), schedules the delayed miss check, and detects on the next mined callback', async () => {
  const tip = { id: 31, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'race1', piconeros: 0n, webhookEventId: 'evt-r', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const execRaw = jest.fn().mockResolvedValue(1)
  const queryRaw = jest.fn().mockResolvedValue([{ rank_delta: 700000000n }])
  const models = mockModels({
    observedTip: { findFirst: jest.fn().mockResolvedValue(tip) },
    execRaw,
    queryRaw
  })
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text

  // Delivery 1 — NEITHER source has the tx: lws REST omits mempool txs and the
  // daemon fallback returns nothing for the hash -> tx_not_found (a 200 no-op),
  // not the old "benign race": detection is deferred until a mined callback.
  const monero = mockMonero({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: [] }) })
  const daemon = { getTransactions: jest.fn().mockResolvedValue([]) }
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'race1', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', amount: 1000 } }
  }, res, models, monero, daemon)

  expect(res.status).toHaveBeenCalledWith(200)
  expect(daemon.getTransactions).toHaveBeenCalledWith(['deadbeef'])
  expect(alert).not.toHaveBeenCalled() // silent: no page at receipt time
  expect(logInfoSpy).toHaveBeenCalledWith(
    expect.objectContaining({ paymentId: 'race1', piconeros: '1000', context: 'tip 31 detection' }),
    expect.stringContaining('not visible')
  )
  const scheduleCall = execRaw.mock.calls.find(call => sqlOf(call).includes('webhookMissCheck'))
  expect(scheduleCall).toBeDefined()
  expect(sqlOf(scheduleCall)).toContain('ON CONFLICT DO NOTHING')
  const scheduleVals = [...scheduleCall].slice(1)
  expect(scheduleVals).toEqual(expect.arrayContaining(['race1', '1000', 'tip 31 detection', WEBHOOK_MISS_CHECK_DELAY_SECONDS]))
  // Pin the plan's fixed values literally (not just self-consistency with the
  // imported constant): 30 min startafter and the per-paymentId singleton key.
  expect(WEBHOOK_MISS_CHECK_DELAY_SECONDS).toBe(1800)
  expect(sqlOf(scheduleCall)).toContain("interval '1 second'")
  expect(sqlOf(scheduleCall)).toContain("'webhookMissCheck:' ||")
  // no PENDING -> DETECTED claim on the both-miss delivery
  expect(execRaw.mock.calls.some(call => sqlOf(call).includes("state = 'DETECTED'"))).toBe(false)

  // Delivery 2 — lws's next callback (1 conf) finds the tx: detection proceeds
  // exactly as before (money path unchanged).
  const res2 = mockRes()
  await handleWebhook({
    body: { payment_id: 'race1', event: 'tx-confirmation', confirmations: 1, tx_info: { tx_hash: 'deadbeef', block: 2172600, amount: 1000 } }
  }, res2, models, verifiedMonero('race1', 1000))
  expect(res2.status).toHaveBeenCalledWith(200)
  expect(execRaw.mock.calls.some(call => sqlOf(call).includes("state = 'DETECTED'"))).toBe(true)
})

test('tip branch: a foreign callback hash rejects tx_not_found (hash-first) — collision WARN, miss check scheduled', async () => {
  const tip = { id: 32, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'hash1', piconeros: 0n, webhookEventId: 'evt-h', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const execRaw = jest.fn().mockResolvedValue(0)
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }, execRaw })
  const monero = mockMonero({
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: 'realhash', payment_id: 'hash1', piconeros: 1000n, spent_outputs: [] }]
    })
  })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'hash1', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'fakehash', amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  // hash-first: the same-pid tx is NOT evidence for the named hash — the
  // collision surfaces as the deduped pid-collision WARN from
  // verifyReceiptAmount, and the rejection takes the tx_not_found path (both
  // sources miss the named hash)
  expect(alert).toHaveBeenCalledWith('warn', 'payment-id collision on receipt verification',
    expect.stringContaining('hash1'),
    expect.objectContaining({ dedupeKey: 'pid-collision-hash1' }))
  expect(alert).not.toHaveBeenCalledWith('warn', 'webhook receipt rejected', expect.anything(), expect.anything())
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  expect(execRaw.mock.calls.some(call => sqlOf(call).includes('webhookMissCheck'))).toBe(true)
})

test('bounty branch: tx_not_found logs but does not schedule the tip miss check (tips-only scope)', async () => {
  const bounty = { id: 7, postId: 5, state: 'PENDING', paymentId: 'bnrace', webhookEventId: 'evt-b2', recipientAccount: scannableAccount() }
  const execRaw = jest.fn().mockResolvedValue(1)
  const models = mockModels({
    bountyPidMap: { findFirst: jest.fn().mockResolvedValue({ paymentId: 'bnrace', postId: 5, userId: 2 }) },
    observedBounty: { findFirst: jest.fn().mockResolvedValue(bounty) },
    execRaw
  })
  const monero = mockMonero({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: [] }) })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'bnrace', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', amount: 15000000000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(alert).not.toHaveBeenCalled()
  expect(logInfoSpy).toHaveBeenCalledWith(
    expect.objectContaining({ paymentId: 'bnrace', context: 'bounty 7' }),
    expect.stringContaining('not visible')
  )
  const sqlOf = call => Array.isArray(call[0]) ? call[0].join('') : call[0].text
  expect(execRaw.mock.calls.some(call => sqlOf(call).includes('webhookMissCheck'))).toBe(false)
})

test('a miss-check scheduling failure is logged best-effort and never fails the delivery', async () => {
  const tip = { id: 33, postId: 10, tipperId: null, state: 'PENDING', paymentId: 'race2', piconeros: 0n, webhookEventId: 'evt-r2', post: { userId: 99 }, recipientAccount: scannableAccount() }
  const execRaw = jest.fn().mockRejectedValue(new Error('pgboss insert failed'))
  const models = mockModels({ observedTip: { findFirst: jest.fn().mockResolvedValue(tip) }, execRaw })
  const monero = mockMonero({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: [] }) })
  const res = mockRes()
  await handleWebhook({
    body: { payment_id: 'race2', event: 'tx-confirmation', confirmations: 0, tx_info: { tx_hash: 'deadbeef', amount: 1000 } }
  }, res, models, monero)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(logErrorSpy).toHaveBeenCalledWith(
    expect.objectContaining({ err: expect.any(Error) }),
    expect.stringContaining('miss-check schedule failed')
  )
})
