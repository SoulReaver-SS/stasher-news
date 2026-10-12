/* eslint-env jest */

// Unit tests for the reconcileOwnerFeeLegs cron backstop (I2c) — the safety
// net for owner-routed fee legs whose lws tx-confirmation webhook callback was
// missed (deploy restart across the confirmation window, lws hiccup). The
// chain re-observes receipts via lws get_address_txs and replays them through
// the shared applier applySubFeeReceipt, re-running the cumulative gate so
// PENDING_FEE items flip before abandonFeeItems strikes at 1 day.
//
// WRONG-PID FALLBACK (owner-fee parity with reconcilePendingTips): monero-lws
// decrypts an encrypted payment id ONCE per scan pass — with the derivation of
// the FIRST matching registered account — and stores those bytes on every
// matching account's row. When the payer is also lws-registered and scans
// first, the owner's row carries the SENDER-side pid: the registered webhook
// never fires and the served-pid match finds nothing. The fallback fetches the
// raw txs from monerod and decrypts the encrypted pid with the OWNER's view
// key (api/monero/pidDecrypt.js), then replays through the same self-send
// refusal + shared applier. Fee legs may take MULTIPLE top-up txs, so discovery
// must inspect every remaining row — not just the first match per pid.
//
// Mirrors test/worker/reconcilePendingTips.test.js: injected lws `monero`
// client, in-memory models factory. applySubFeeReceipt is jest-mocked with a
// relative path (next/jest gives jest.mock no `@/` alias — see
// test/worker/opsSweep.test.js) so the receipt replay args are assertable.
//
// Run via the app container:
//   docker exec -u apprunner app npx jest test/worker/reconcileOwnerFeeLegs.test.js

import { ed25519 } from '@noble/curves/ed25519'
import { runReconcileOwnerFeeLegsOnce, reconcileOwnerFeeLegs } from '@/worker/reconcileOwnerFeeLegs'
import { encryptViewKey } from '@/api/monero/viewkey'
import { maskFromTxPubKey, paymentIdCandidates, xorWithMask } from '@/api/monero/pidDecrypt'
import { createDaemonClient, daemonClient } from '@/api/monero/daemonClient'
import { createReconciliationRawReader } from '@/worker/reconciliationRawTransactions'
import { lwsClient } from '@/api/monero/lwsClient'
import { applySubFeeReceipt } from '../../api/monero/subFeeObservation'
import { alert } from '../../lib/alert'

jest.mock('../../api/monero/subFeeObservation', () => ({
  __esModule: true,
  applySubFeeReceipt: jest.fn()
}))

jest.mock('../../lib/alert', () => ({
  __esModule: true,
  alert: jest.fn()
}))

// The raw-decrypt fixtures encrypt an owner view key, which requires
// VIEWKEY_MASTER_KEY. CI doesn't set one — provide a dummy (32 bytes, base64)
// so ensureLoaded() succeeds; these tests assert the recovery flow, not key
// material (reconcilePendingTips.test.js pattern).
process.env.VIEWKEY_MASTER_KEY = Buffer.alloc(32, 97).toString('base64')

const FUTURE = new Date(Date.now() + 60 * 60 * 1000)
const ISSUED_PID = '8a05774bc66a6479'
const SERVED_PID = '006b21173b04781b'
const TEST_VIEW_KEY = '01' + '00'.repeat(31)

// Stateful models factory: records every model call so tests can assert both
// effects (receipt replay) and non-effects (no lws scan, no payIn query).
function makeModels ({ maps = [], payIns = [], accounts = [] } = {}) {
  const calls = { payInFindMany: 0, accountFindFirst: [] }
  return {
    calls,
    // The self-payment ban's provisional-row cleanup (EXCLUDED) runs through
    // $executeRaw; jest.fn so tests can assert both the call and the SQL shape.
    $executeRaw: jest.fn().mockResolvedValue(1),
    subFeePidMap: {
      findMany: async () => maps
    },
    payIn: {
      findMany: async (args) => {
        calls.payInFindMany += 1
        calls.payInWhere = args?.where
        // Fee payIns are created PAID by design — no state filter any more.
        return payIns.filter(p => (args?.where?.moneroPaymentId?.in ?? []).includes(p.moneroPaymentId))
      }
    },
    moneroAccount: {
      findFirst: async ({ where }) => {
        calls.accountFindFirst.push(where)
        return accounts.find(a => a.ownerUserId === where.ownerUserId) || null
      }
    }
  }
}

function leg (overrides = {}) {
  return {
    id: 1,
    paymentId: 'a1b2c3d4e5f6a7b8',
    subName: 'stasher',
    ownerUserId: 7,
    amountPiconeros: 1500000000000n,
    webhookEventId: 'evt_1',
    expiresAt: FUTURE,
    ...overrides
  }
}

function payIn (overrides = {}) {
  return {
    id: 101,
    moneroPaymentId: 'a1b2c3d4e5f6a7b8',
    payInState: 'PENDING_PAYMENT',
    payInType: 'ITEM_CREATE',
    moneroUri: 'monero:ADDR?tx_amount=0.0015&tx_payment_id=a1b2c3d4e5f6a7b8',
    ...overrides
  }
}

function account (overrides = {}) {
  return {
    id: 7,
    ownerUserId: 7,
    address: 'ADDR',
    status: 'ACTIVE',
    viewKey: { ciphertext: Buffer.alloc(0) },
    ...overrides
  }
}

// Build a raw tx extra that decrypts (under TEST_VIEW_KEY) to `pid`, plus the
// lws row lws would serve for that tx (default: the scrambled served pid).
function feeEvidence (overrides = {}) {
  const hash = overrides.hash ?? 'ab'.repeat(32)
  const pid = overrides.pid ?? ISSUED_PID
  const pub = Buffer.from(ed25519.ExtendedPoint.BASE.multiply(2n).toRawBytes())
  const stored = xorWithMask(Buffer.from(pid, 'hex'), maskFromTxPubKey(pub, TEST_VIEW_KEY))
  const extra = Buffer.concat([Buffer.from([1]), pub, Buffer.from([2, 9, 1]), stored])
  return {
    raw: { hash, extra },
    row: { hash, payment_id: SERVED_PID, height: 500, piconeros: 1_000_000_000n, spent_outputs: [], ...overrides.row }
  }
}

function feeCase (evidence) {
  const pi = payIn({ moneroPaymentId: ISSUED_PID, payInState: 'PAID', moneroUri: 'monero:ADDR?tx_amount=0.001' })
  const acc = account({ viewKey: encryptViewKey(TEST_VIEW_KEY), subaddresses: [] })
  return {
    pi,
    acc,
    models: makeModels({ maps: [leg({ paymentId: ISSUED_PID })], payIns: [pi], accounts: [acc] }),
    monero: { getAddressTxs: jest.fn(async () => ({ transactions: evidence.map(e => e.row) })) },
    // monerod answers each requested hash at most once — never duplicate the
    // same record when an lws scan repeats a row (the reader refuses
    // duplicate/foreign records by design).
    daemon: {
      getTransactions: jest.fn(async hashes => {
        const out = []
        const seen = new Set()
        for (const e of evidence) {
          if (!hashes.includes(e.raw.hash) || seen.has(e.raw.hash)) continue
          seen.add(e.raw.hash)
          out.push(e.raw)
        }
        return out
      })
    }
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  applySubFeeReceipt.mockReset().mockResolvedValue({ transitioned: false, cumulative: 0n })
})

test('replays an lws-observed receipt for an active owner leg (missed webhook) with confirmations 0', async () => {
  const l = leg()
  const pi = payIn()
  const acc = account()
  const models = makeModels({ maps: [l], payIns: [pi], accounts: [acc] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        { hash: 'deadbeef', height: 500, payment_id: 'a1b2c3d4e5f6a7b8', piconeros: 1500000000000n }
      ],
      blockchain_height: 510
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  // Replay args bind the correction set: tx.hash (parseTx field name), exact
  // PayIn row, and confirmations ALWAYS 0 — maturity is confirmFinalizer's
  // pass, never fabricated here.
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(applySubFeeReceipt).toHaveBeenCalledWith(models, {
    feePayIn: pi,
    paymentId: 'a1b2c3d4e5f6a7b8',
    txHash: 'deadbeef',
    piconeros: 1500000000000n,
    height: 500,
    confirmations: 0
  })
  expect(monero.getAddressTxs).toHaveBeenCalledWith(acc, 0, null)
  expect(out).toEqual({ legs: 1, replayed: 1, flipped: 1, pidFallback: 0 })
})

test('replays a still-mempool receipt (missed 0-conf callback) with height null', async () => {
  const models = makeModels({ maps: [leg()], payIns: [payIn()], accounts: [account()] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        { hash: 'cafebabe', height: null, payment_id: 'a1b2c3d4e5f6a7b8', piconeros: 1500000000000n }
      ]
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(applySubFeeReceipt).toHaveBeenCalledWith(models, expect.objectContaining({
    txHash: 'cafebabe', height: null, confirmations: 0
  }))
  expect(out.replayed).toBe(1)
})

test('scans a PAID fee payIn leg (the pre-fix PENDING_PAYMENT filter never matched — backstop was dead)', async () => {
  // Fee payIns are created PAID by design (piconeros=0; the fee gate lives on
  // Item.feeStatus). The old filter could never match, so this backstop never
  // ran; the selection must no longer filter on payInState at all.
  const pi = payIn({ payInState: 'PAID' })
  const models = makeModels({ maps: [leg()], payIns: [pi], accounts: [account()] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        { hash: 'deadbeef', height: 500, payment_id: 'a1b2c3d4e5f6a7b8', piconeros: 1500000000000n, spent_outputs: [] }
      ],
      blockchain_height: 510
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(monero.getAddressTxs).toHaveBeenCalledTimes(1)
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(out).toEqual({ legs: 1, replayed: 1, flipped: 1, pidFallback: 0 })
})

test('SELF-PAYMENT BAN: a self-spend tx is never replayed (no receipt write, no flip)', async () => {
  // Payer == owner account: lws total_received = inputs - fee (the sender's
  // change), which is never the leg amount — no amount from a self-send is
  // credible, so the backstop skips the tx entirely.
  const pi = payIn({ payInState: 'PAID' })
  const models = makeModels({ maps: [leg()], payIns: [pi], accounts: [account()] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        {
          hash: 'deadbeef',
          height: 500,
          payment_id: 'a1b2c3d4e5f6a7b8',
          piconeros: 8211672641492n,
          spent_outputs: [{ amount: '8211616401492', out_index: 1, sender: { maj_i: 0, min_i: 0 } }]
        }
      ],
      blockchain_height: 510
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(out).toEqual({ legs: 1, replayed: 0, flipped: 0, pidFallback: 0 })
})

test('SELF-PAYMENT BAN: a self-spend tx EXCLUDES its height-NULL provisional row and alerts (deduped)', async () => {
  // A 0-conf callback may have seeded a provisional receipt before the
  // self-send was identified — the backstop's cleanup must EXCLUDE it so the
  // display never shows the change as received (the applier's CAS is
  // state-gated to DETECTED, so an EXCLUDED row can never be claimed).
  const pi = payIn({ payInState: 'PAID' })
  const models = makeModels({ maps: [leg()], payIns: [pi], accounts: [account()] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        {
          hash: 'deadbeef',
          height: 500,
          payment_id: 'a1b2c3d4e5f6a7b8',
          piconeros: 8211672641492n,
          spent_outputs: [{ amount: '8211616401492', out_index: 1, sender: { maj_i: 0, min_i: 0 } }]
        }
      ],
      blockchain_height: 510
    }))
  }
  await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(models.$executeRaw).toHaveBeenCalledTimes(1)
  const sql = Array.isArray(models.$executeRaw.mock.calls[0][0]) ? models.$executeRaw.mock.calls[0][0].join('') : models.$executeRaw.mock.calls[0][0]
  expect(sql).toContain("'EXCLUDED'")
  expect(sql).toContain('"tx_hash"')
  expect(sql).toContain('height IS NULL')
  expect(alert).toHaveBeenCalledWith('warn', 'owner-fee self-payment refused',
    expect.stringContaining('a1b2c3d4e5f6a7b8'),
    expect.objectContaining({ dedupeKey: 'subfee-selfpay-a1b2c3d4e5f6a7b8-deadbeef' }))
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
})

test('misattributed foreign spent_outputs (lws scan-pass bug) do NOT trip the ban — tx replays normally', async () => {
  // Review follow-up: lws attributes FOREIGN wallets' spends to a scanned
  // account (observed 2026-08-10). The ban uses the same EXACT (maj,min)
  // sender match as the webhook, so a foreign-index sender is NOT a
  // self-send: the genuine fee receipt replays instead of being stranded
  // behind an unreclaimable EXCLUDED row (which abandonFeeItems would turn
  // into a 24h deletion).
  const pi = payIn({ payInState: 'PAID' })
  const models = makeModels({ maps: [leg()], payIns: [pi], accounts: [account()] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        {
          hash: 'deadbeef',
          height: 500,
          payment_id: 'a1b2c3d4e5f6a7b8',
          piconeros: 1500000000000n,
          spent_outputs: [{ amount: '1500000000000', out_index: 0, sender: { maj_i: 4, min_i: 2 } }] // foreign indices
        }
      ],
      blockchain_height: 510
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(models.$executeRaw).not.toHaveBeenCalled() // no EXCLUDED write
  expect(out).toEqual({ legs: 1, replayed: 1, flipped: 1, pidFallback: 0 })
})

test('skips owners without an ACTIVE scanable account (viewKey missing)', async () => {
  // Unregistered/soft-deleted owner account: lws scan impossible — the
  // webhook remains the primary observer for this leg.
  const models = makeModels({
    maps: [leg()],
    payIns: [payIn()],
    accounts: [account({ status: 'INACTIVE', viewKey: null })]
  })
  const monero = { getAddressTxs: jest.fn() }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(monero.getAddressTxs).not.toHaveBeenCalled()
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(out).toEqual({ legs: 1, replayed: 0, flipped: 0, pidFallback: 0 })
})

test('warns and continues other owners when one owner lws scan fails', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const l1 = leg({ id: 1, paymentId: 'a1b2c3d4e5f6a7b8', ownerUserId: 7 })
    const l2 = leg({ id: 2, paymentId: 'b2c3d4e5f6a7b8c9', ownerUserId: 9 })
    const p1 = payIn({ id: 101, moneroPaymentId: 'a1b2c3d4e5f6a7b8' })
    const p2 = payIn({ id: 102, moneroPaymentId: 'b2c3d4e5f6a7b8c9' })
    const a1 = account({ id: 7, ownerUserId: 7 })
    const a2 = account({ id: 9, ownerUserId: 9, address: 'ADDR2' })
    const models = makeModels({ maps: [l1, l2], payIns: [p1, p2], accounts: [a1, a2] })
    const monero = {
      getAddressTxs: jest.fn(async (acct) => {
        if (acct.id === 7) throw new Error('lws down')
        return {
          transactions: [
            { hash: 'baadf00d', height: 600, payment_id: 'b2c3d4e5f6a7b8c9', piconeros: 1500000000000n }
          ]
        }
      })
    }
    const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('owner 7'))
    expect(monero.getAddressTxs).toHaveBeenCalledTimes(2)
    expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
    expect(applySubFeeReceipt).toHaveBeenCalledWith(models, expect.objectContaining({
      feePayIn: p2, paymentId: 'b2c3d4e5f6a7b8c9', txHash: 'baadf00d'
    }))
    expect(out).toEqual({ legs: 2, replayed: 1, flipped: 1, pidFallback: 0 })
  } finally {
    warn.mockRestore()
  }
})

test('nothing to do: zero active legs → zero payIn queries, zero lws calls', async () => {
  const models = makeModels({ maps: [] })
  const monero = { getAddressTxs: jest.fn() }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(models.calls.payInFindMany).toBe(0)
  expect(monero.getAddressTxs).not.toHaveBeenCalled()
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(out).toEqual({ legs: 0, replayed: 0, flipped: 0, pidFallback: 0 })
})

// ---------------------------------------------------------------------------
// Wrong-pid raw-decrypt fallback (owner-fee parity with reconcilePendingTips;
// internal incident notes). When both payer and owner are lws-registered and
// the payer scans first, lws serves the payer-side pid on the owner's row:
// the webhook never fires and the served-pid match above finds nothing. The
// fallback fetches the raw tx from monerod and decrypts the encrypted pid
// with the OWNER's view key (pidDecrypt.js). Fee legs allow MULTIPLE top-up
// txs, so every remaining row is inspected — a served-pid hit for one receipt
// must not stop discovery for the others.
// ---------------------------------------------------------------------------

test('recovers a mined owner fee under the issued PID, not the served PID', async () => {
  const evidence = feeEvidence()
  const fx = feeCase([evidence])
  applySubFeeReceipt.mockResolvedValue({ transitioned: true, cumulative: 1_000_000_000n })
  const out = await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(fx.daemon.getTransactions).toHaveBeenCalledWith([evidence.row.hash])
  expect(applySubFeeReceipt).toHaveBeenCalledWith(fx.models, {
    feePayIn: fx.pi,
    paymentId: ISSUED_PID,
    txHash: evidence.row.hash,
    piconeros: 1_000_000_000n,
    height: 500,
    confirmations: 0
  })
  expect(out.pidFallback).toBe(1)
})

test.each([false, true])('keeps every top-up when the first served PID is correct: %s', async correctFirst => {
  const first = feeEvidence({ hash: 'ab'.repeat(32), row: { piconeros: 400_000_000n, payment_id: correctFirst ? ISSUED_PID : SERVED_PID } })
  const second = feeEvidence({ hash: 'cd'.repeat(32), row: { piconeros: 600_000_000n } })
  const fx = feeCase([first, second])
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(2)
  const receipts = applySubFeeReceipt.mock.calls.map(([, receipt]) => receipt)
  expect(receipts.map(r => r.txHash).sort()).toEqual([first.row.hash, second.row.hash].sort())
  expect(receipts.every(r => r.paymentId === ISSUED_PID && r.feePayIn === fx.pi)).toBe(true)
  expect(receipts.reduce((sum, r) => sum + r.piconeros, 0n)).toBe(1_000_000_000n)
})

test.each([ISSUED_PID.toUpperCase(), null])('handles normalized or absent served PID: %s', async served => {
  const fx = feeCase([feeEvidence({ row: { payment_id: served } })])
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(applySubFeeReceipt).toHaveBeenCalledWith(fx.models, expect.objectContaining({ paymentId: ISSUED_PID, feePayIn: fx.pi }))
  if (served) expect(fx.daemon.getTransactions).not.toHaveBeenCalled()
})

test('self-send cleanup uses the issued PID after raw discovery', async () => {
  const fx = feeCase([feeEvidence({ row: { spent_outputs: [{ sender: { maj_i: 0, min_i: 0 } }] } })])
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(fx.models.$executeRaw).toHaveBeenCalledTimes(1)
  const [sql, ...params] = fx.models.$executeRaw.mock.calls[0]
  expect(sql.join('')).toContain('height IS NULL')
  expect(params).toContain(ISSUED_PID)
  expect(params).not.toContain(SERVED_PID)
})

test('foreign-index spends are not an owner self-send on the raw path', async () => {
  const fx = feeCase([feeEvidence({ row: { spent_outputs: [{ sender: { maj_i: 4, min_i: 2 } }] } })])
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(fx.models.$executeRaw).not.toHaveBeenCalled()
})

test('an unrequested raw hash cannot stand in for the lws transaction', async () => {
  const fx = feeCase([feeEvidence()])
  fx.daemon.getTransactions.mockResolvedValue([feeEvidence({ hash: 'ef'.repeat(32) }).raw])
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
})

test('deduplicates a repeated lws hash and never manufactures mined height', async () => {
  const evidence = feeEvidence({ row: { height: null } })
  const fx = feeCase([evidence, evidence])
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(fx.daemon.getTransactions).toHaveBeenCalledWith([evidence.row.hash])
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(applySubFeeReceipt).toHaveBeenCalledWith(fx.models, expect.objectContaining({ height: null, confirmations: 0 }))
})

test('unmatched decryption and hashless rows never produce receipts', async () => {
  const unrelated = feeEvidence({ pid: 'ffffffffffffffff' })
  const hashless = feeEvidence({ row: { hash: null } })
  const fx = feeCase([unrelated, hashless])
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(fx.daemon.getTransactions).toHaveBeenCalledWith([unrelated.row.hash])
})

// ---------------------------------------------------------------------------
// Failure isolation, retry, and batching contracts. A raw lookup/decryption
// failure is a DEFER (the leg stays unobserved; the next hourly run retries) —
// never a silent drop and never a fake receipt. An applier/DB write failure is
// NOT a defer: it must fail the cron run so pg-boss retries it (a swallowed
// write would look like "nothing to observe" and strand the leg to
// abandonment). Production wiring must explicitly enable the daemon fallback.
// ---------------------------------------------------------------------------

test('raw failure is visible and a later cron invocation retries the receipt', async () => {
  const evidence = feeEvidence()
  const fx = feeCase([evidence])
  fx.daemon.getTransactions.mockRejectedValueOnce(new Error('unavailable'))
  const first = await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(first.pidFallback).toBe(0)
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('warn', 'owner-fee raw-decrypt fallback failed', expect.any(String), { dedupeKey: 'subfee-pid-fallback-error-7' })
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
})

test('raw fallback logs a fixed failure category without echoing exception text', async () => {
  // Plan §1: the raw-fallback catch must log account id, candidate count, and
  // a fixed category only — transport/crypto error text can embed sensitive
  // input (view-key material, raw tx payloads), so it must never reach the
  // logs OR the alert body.
  const sentinel = 'sensitive-transport-payload-do-not-log'
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const fx = feeCase([feeEvidence()])
    fx.daemon.getTransactions.mockRejectedValueOnce(new Error(sentinel))
    await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
    const logged = warn.mock.calls.map(args => args.join(' ')).join('\n')
    expect(logged).not.toContain(sentinel)
    expect(logged).toContain('raw-decrypt fallback failed')
    const alerted = alert.mock.calls.map(args => JSON.stringify(args)).join('\n')
    expect(alerted).not.toContain(sentinel)
  } finally {
    warn.mockRestore()
  }
})

test.each([{ raws: [] }, { raws: [feeEvidence({ hash: 'ab'.repeat(32) }).raw] }])('empty/partial raw evidence warns but cannot fabricate missing receipts: %#', async ({ raws }) => {
  const fx = feeCase([feeEvidence(), feeEvidence({ hash: 'cd'.repeat(32) })])
  fx.daemon.getTransactions.mockResolvedValue(raws)
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(raws.length)
  expect(alert).toHaveBeenCalledWith('warn', 'owner-fee raw transaction evidence incomplete', expect.any(String), { dedupeKey: 'subfee-pid-fallback-incomplete-7' })
})

test('an unreadable view-key envelope never credits a raw match', async () => {
  const fx = feeCase([feeEvidence()])
  fx.acc.viewKey.tag = Buffer.alloc(16)
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('warn', 'owner-fee raw-decrypt fallback failed', expect.any(String), { dedupeKey: 'subfee-pid-fallback-error-7' })
})

test('only a new raw height transition counts or emits recovery', async () => {
  const fx = feeCase([feeEvidence()])
  applySubFeeReceipt.mockResolvedValueOnce({ transitioned: true, cumulative: 1_000_000_000n })
  const first = await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(first.pidFallback).toBe(1)
  expect(alert).toHaveBeenCalledWith('warn', 'owner-fee payment-id misattribution recovered', expect.any(String), { dedupeKey: 'subfee-pid-misattribution-7' })
  alert.mockClear()
  const replay = await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(replay.pidFallback).toBe(0)
  expect(alert).not.toHaveBeenCalledWith('warn', 'owner-fee payment-id misattribution recovered', expect.anything(), expect.anything())
})

test('an applier write failure remains a job failure, not a swallowed raw lookup error', async () => {
  const fx = feeCase([feeEvidence()])
  applySubFeeReceipt.mockRejectedValueOnce(new Error('database unavailable'))
  await expect(runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })).rejects.toThrow('database unavailable')
  expect(alert).not.toHaveBeenCalledWith('warn', 'owner-fee raw-decrypt fallback failed', expect.anything(), expect.anything())
})

test('legacy core callers do not invoke raw recovery without an injected daemon', async () => {
  const fx = feeCase([feeEvidence()])
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero })
  expect(fx.daemon.getTransactions).not.toHaveBeenCalled()
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
})

test('owner history over 100 hashes uses the existing batched daemon transport', async () => {
  const target = feeEvidence()
  const history = Array.from({ length: 150 }, (_, i) => {
    const hash = i.toString(16).padStart(64, '0')
    return { raw: { hash, extra: Buffer.alloc(0) }, row: { hash, payment_id: null, height: 100, piconeros: 1n, spent_outputs: [] } }
  })
  const evidence = [...history, target]
  const fx = feeCase(evidence)
  const batches = []
  const transport = async (url, { body }) => {
    const { txs_hashes: hashes } = JSON.parse(body)
    batches.push(hashes.length)
    const txs = evidence.filter(e => hashes.includes(e.raw.hash)).map(e => ({
      tx_hash: e.raw.hash, as_json: JSON.stringify({ extra: Array.from(e.raw.extra) })
    }))
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'OK', txs }) }
  }
  const daemon = createDaemonClient({ daemonUrl: 'http://test.invalid', transport })
  // Fresh reader: module-level singleton cache state must not hide requests.
  const rawReader = createReconciliationRawReader({ daemon })
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, rawReader })
  expect(batches).toEqual([50, 50, 50, 1])
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(applySubFeeReceipt).toHaveBeenCalledWith(fx.models, expect.objectContaining({ txHash: target.row.hash }))
})

test('production wrapper enables raw recovery', async () => {
  const evidence = feeEvidence()
  const fx = feeCase([evidence])
  const lwsSpy = jest.spyOn(lwsClient, 'getAddressTxs').mockImplementation(fx.monero.getAddressTxs)
  const daemonSpy = jest.spyOn(daemonClient, 'getTransactions').mockImplementation(fx.daemon.getTransactions)
  try {
    await reconcileOwnerFeeLegs({ models: fx.models })
    expect(daemonSpy).toHaveBeenCalledWith([evidence.row.hash])
    expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  } finally {
    lwsSpy.mockRestore()
    daemonSpy.mockRestore()
  }
})

// ---------------------------------------------------------------------------
// Owner isolation + ambiguity: one owner's raw failure must not strand the
// next owner's legs (per-account catch), and a raw hash that decrypts to MORE
// THAN ONE active pid is refused outright — ambiguous attribution is not
// evidence for either leg, and silently picking one could mis-flip money.
// ---------------------------------------------------------------------------

test('one owner raw failure does not strand a later owner', async () => {
  const first = feeEvidence()
  const secondPid = '1122334455667788'
  const second = feeEvidence({ pid: secondPid, hash: 'cd'.repeat(32) })
  const acc1 = account({ viewKey: encryptViewKey(TEST_VIEW_KEY) })
  const acc2 = account({ id: 9, ownerUserId: 9, viewKey: encryptViewKey(TEST_VIEW_KEY) })
  const models = makeModels({
    maps: [leg({ paymentId: ISSUED_PID }), leg({ paymentId: secondPid, ownerUserId: 9 })],
    payIns: [payIn({ moneroPaymentId: ISSUED_PID }), payIn({ id: 102, moneroPaymentId: secondPid })],
    accounts: [acc1, acc2]
  })
  const monero = { getAddressTxs: async acc => ({ transactions: [acc.id === 7 ? first.row : second.row] }) }
  const daemon = { getTransactions: jest.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([second.raw]) }
  await runReconcileOwnerFeeLegsOnce({ models, monero, daemonClient: daemon })
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(applySubFeeReceipt).toHaveBeenCalledWith(models, expect.objectContaining({ paymentId: secondPid, txHash: second.row.hash }))
})

test('multiple candidate active PIDs for one raw hash are refused', async () => {
  const evidence = feeEvidence()
  const additional = Buffer.from(ed25519.ExtendedPoint.BASE.multiply(3n).toRawBytes())
  evidence.raw.extra = Buffer.concat([evidence.raw.extra, Buffer.from([4, 1]), additional])
  const candidates = [...new Set(paymentIdCandidates(evidence.raw.extra, TEST_VIEW_KEY))]
  expect(candidates).toHaveLength(2)
  const models = makeModels({
    maps: candidates.map(paymentId => leg({ paymentId })),
    payIns: candidates.map((moneroPaymentId, i) => payIn({ id: 101 + i, moneroPaymentId })),
    accounts: [account({ viewKey: encryptViewKey(TEST_VIEW_KEY) })]
  })
  const monero = { getAddressTxs: async () => ({ transactions: [evidence.row] }) }
  const daemon = { getTransactions: async () => [evidence.raw] }
  await runReconcileOwnerFeeLegsOnce({ models, monero, daemonClient: daemon })
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('warn', 'owner-fee ambiguous raw payment id refused', expect.any(String), { dedupeKey: `subfee-pid-ambiguous-7-${evidence.row.hash}` })
})

test('one raw hash decrypts independently under each owner view key', async () => {
  // A tx's encrypted pid is masked by a per-view-key derivation: the SAME raw
  // extra must be re-decrypted account-locally, never frozen to whichever
  // owner's key happened to touch the shared cache first.
  const keyA = TEST_VIEW_KEY
  const keyB = '02' + '00'.repeat(31)
  const pub = Buffer.from(ed25519.ExtendedPoint.BASE.multiply(2n).toRawBytes())
  const stored = xorWithMask(Buffer.from(ISSUED_PID, 'hex'), maskFromTxPubKey(pub, keyA))
  const extra = Buffer.concat([Buffer.from([1]), pub, Buffer.from([2, 9, 1]), stored])
  const pidB = paymentIdCandidates(extra, keyB)[0]
  expect(pidB).toBeDefined()
  expect(pidB).not.toBe(ISSUED_PID)

  const hash = 'ab'.repeat(32)
  const accA = account({ viewKey: encryptViewKey(keyA) })
  const accB = account({ id: 9, ownerUserId: 9, address: 'ADDR2', viewKey: encryptViewKey(keyB) })
  const models = makeModels({
    maps: [leg({ paymentId: ISSUED_PID }), leg({ id: 2, paymentId: pidB, ownerUserId: 9 })],
    payIns: [payIn({ moneroPaymentId: ISSUED_PID }), payIn({ id: 102, moneroPaymentId: pidB })],
    accounts: [accA, accB]
  })
  const daemon = { getTransactions: jest.fn(async () => [{ hash, extra }]) }
  const rawReader = createReconciliationRawReader({ daemon })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [{ hash, payment_id: SERVED_PID, height: 500, piconeros: 1_000_000_000n, spent_outputs: [] }]
    }))
  }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero, rawReader })
  expect(out).toEqual({ legs: 2, replayed: 2, flipped: 2, pidFallback: 0 })
  const receipts = applySubFeeReceipt.mock.calls.map(([, receipt]) => receipt)
  expect(receipts.map(r => r.paymentId).sort()).toEqual([ISSUED_PID, pidB].sort())
  expect(receipts.reduce((sum, r) => sum + r.piconeros, 0n)).toBe(2_000_000_000n)
  // ONE shared cache entry, fetched once; each owner decrypted it locally.
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
})

test('served-pid discovery finds receipt A and raw discovery finds receipt B for the same issued PID', async () => {
  // Multi-top-up parity: a served-pid hit must not stop raw discovery — and
  // vice versa. Both receipts reach the shared applier, and the hourly re-run
  // routes them again (the applier's insert is idempotent in production).
  const served = feeEvidence({ hash: 'ab'.repeat(32), row: { piconeros: 400_000_000n, payment_id: ISSUED_PID } })
  const scrambled = feeEvidence({ hash: 'cd'.repeat(32), row: { piconeros: 600_000_000n } })
  const fx = feeCase([served, scrambled])
  const first = await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(first).toEqual({ legs: 1, replayed: 2, flipped: 2, pidFallback: 0 })
  expect(applySubFeeReceipt.mock.calls.map(([, r]) => r.txHash)).toEqual([served.row.hash, scrambled.row.hash])
  for (const [, receipt] of applySubFeeReceipt.mock.calls) {
    expect(receipt.paymentId).toBe(ISSUED_PID)
    expect(receipt.feePayIn).toBe(fx.pi)
  }

  applySubFeeReceipt.mockClear()
  const replay = await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(replay).toEqual({ legs: 1, replayed: 2, flipped: 2, pidFallback: 0 })
  expect(applySubFeeReceipt.mock.calls.map(([, r]) => r.txHash)).toEqual([served.row.hash, scrambled.row.hash])
  expect(alert).not.toHaveBeenCalledWith('warn', 'owner-fee payment-id misattribution recovered', expect.anything(), expect.anything())
})

test('a warm reader re-joins cached raw bytes to the CURRENT lws row; a restart only refetches', async () => {
  // The reader caches only public `extra` bytes. Amount/height must keep
  // coming from the fresh lws scan row or a stale receipt could be replayed.
  const evidence = feeEvidence()
  const fx = feeCase([evidence])
  const rawReader = createReconciliationRawReader({ daemon: fx.daemon })
  const row = over => ({ ...evidence.row, ...over })

  const first = await runReconcileOwnerFeeLegsOnce({
    models: fx.models,
    monero: { getAddressTxs: async () => ({ transactions: [row()] }) },
    rawReader
  })
  expect(first).toEqual({ legs: 1, replayed: 1, flipped: 1, pidFallback: 0 })
  expect(applySubFeeReceipt).toHaveBeenLastCalledWith(fx.models, expect.objectContaining({ height: 500, piconeros: 1_000_000_000n }))
  expect(fx.daemon.getTransactions).toHaveBeenCalledTimes(1)

  // Warm run: CHANGED height/amount for the same hash — the applier must see
  // the fresh row, and the cache means no second RPC.
  applySubFeeReceipt.mockClear()
  const second = await runReconcileOwnerFeeLegsOnce({
    models: fx.models,
    monero: { getAddressTxs: async () => ({ transactions: [row({ height: 900, piconeros: 2_000_000_000n })] }) },
    rawReader
  })
  expect(second).toEqual({ legs: 1, replayed: 1, flipped: 1, pidFallback: 0 })
  expect(applySubFeeReceipt).toHaveBeenCalledWith(fx.models, expect.objectContaining({ height: 900, piconeros: 2_000_000_000n }))
  expect(fx.daemon.getTransactions).toHaveBeenCalledTimes(1)

  // Simulated restart: a factory-new reader starts cold, so the same evidence
  // is fetched again — the receipt outcome is unchanged.
  applySubFeeReceipt.mockClear()
  const restarted = createReconciliationRawReader({ daemon: fx.daemon })
  const third = await runReconcileOwnerFeeLegsOnce({
    models: fx.models,
    monero: { getAddressTxs: async () => ({ transactions: [row({ height: 900, piconeros: 2_000_000_000n })] }) },
    rawReader: restarted
  })
  expect(third).toEqual({ legs: 1, replayed: 1, flipped: 1, pidFallback: 0 })
  expect(applySubFeeReceipt).toHaveBeenCalledTimes(1)
  expect(fx.daemon.getTransactions).toHaveBeenCalledTimes(2)
})

test('malformed raw extra cannot manufacture a PID match', async () => {
  const evidence = feeEvidence()
  evidence.raw.extra = Buffer.from([1, 2])
  const fx = feeCase([evidence])
  await runReconcileOwnerFeeLegsOnce({ models: fx.models, monero: fx.monero, daemonClient: fx.daemon })
  expect(applySubFeeReceipt).not.toHaveBeenCalled()
})
