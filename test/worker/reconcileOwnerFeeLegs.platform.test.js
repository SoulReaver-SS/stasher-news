/* eslint-env jest */
// reconcileOwnerFeeLegs for INTEGRATED PLATFORM fee legs (the job keeps its
// legacy name). The owner-leg and raw-PID cryptography cases live in
// reconcileOwnerFeeLegs.test.js; this suite pins what platform legs add:
// grouping by the FROZEN recipient account, eligibility without a PayIn,
// primary-address-only scanning, fail-loud deferral, and routing every
// receipt through the shared applier with the intent itself.
import { runReconcileOwnerFeeLegsOnce } from '@/worker/reconcileOwnerFeeLegs'
import { applyFeeReceipt } from '../../api/monero/feeObservation'
import { alert } from '../../lib/alert'

jest.mock('../../api/monero/feeObservation', () => ({
  __esModule: true,
  applyFeeReceipt: jest.fn().mockResolvedValue({ transitioned: false, cumulative: 0n }),
  excludeProvisionalFeeReceipt: jest.fn().mockResolvedValue(0)
}))
jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))

const FUTURE = new Date(Date.now() + 3_600_000)
const REWARDS = { id: 91, label: 'platform_rewards', status: 'ACTIVE', address: 'PLATFORM', viewKey: { ciphertext: Buffer.alloc(0) }, subaddresses: [] }
const platformMap = (paymentId, extra = {}) => ({
  id: paymentId.charCodeAt(0),
  paymentId,
  feeType: 'POSTING',
  ownerUserId: null,
  subName: null,
  postId: 5,
  amountPiconeros: 1_000_000_000n,
  recipientAccountId: 91,
  recipientAddress: 'PLATFORM',
  webhookEventId: null,
  expiresAt: FUTURE,
  ...extra
})
const row = (hash, paymentId, { maj = 0, min = 0, height = 100 } = {}) => ({
  hash, payment_id: paymentId, piconeros: 1_000_000_000n, height, recipient: { maj_i: maj, min_i: min }, spent_outputs: []
})

function makeModels ({ maps, payIns = [], account = REWARDS }) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(0),
    subFeePidMap: { findMany: jest.fn(async () => maps) },
    payIn: { findMany: async ({ where }) => payIns.filter(p => where.moneroPaymentId.in.includes(p.moneroPaymentId)) },
    moneroAccount: {
      findUnique: jest.fn(async ({ where }) => where.id === 91 ? account : null),
      findFirst: jest.fn(async () => null)
    }
  }
}

beforeEach(() => jest.clearAllMocks())

test('platform legs share ONE scan of their frozen recipient and replay through the applier with the intent', async () => {
  const live = platformMap('aaaaaaaaaaaaaaa1')
  const abandoned = platformMap('aaaaaaaaaaaaaaa2', { webhookEventId: null })
  const payIn = { id: 7, payInType: 'ITEM_CREATE', moneroPaymentId: live.paymentId, moneroUri: 'monero:x?tx_amount=0.001' }
  const models = makeModels({ maps: [live, abandoned], payIns: [payIn] })
  const monero = { getAddressTxs: jest.fn(async () => ({ transactions: [row('h1', live.paymentId), row('h2', abandoned.paymentId)] })) }
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero })
  expect(out.legs).toBe(2) // a PayIn-less platform intent is still eligible
  expect(monero.getAddressTxs).toHaveBeenCalledTimes(1)
  expect(monero.getAddressTxs).toHaveBeenCalledWith(REWARDS, 0, null)
  // the window is retention-only: no webhook-id requirement
  expect(models.subFeePidMap.findMany).toHaveBeenCalledWith({ where: { expiresAt: { gt: expect.any(Date) } } })
  expect(applyFeeReceipt).toHaveBeenCalledWith(models, { feeMap: live, feePayIn: payIn, txHash: 'h1', piconeros: 1_000_000_000n, height: 100, confirmations: 0 })
  expect(applyFeeReceipt).toHaveBeenCalledWith(models, expect.objectContaining({ feeMap: abandoned, feePayIn: null, txHash: 'h2' }))
  expect(models.moneroAccount.findFirst).not.toHaveBeenCalled()
})

test('only primary-address rows are candidates: subaddress-pool rows never reach the raw pass', async () => {
  const leg = platformMap('aaaaaaaaaaaaaaa3')
  const models = makeModels({ maps: [leg] })
  const monero = {
    getAddressTxs: jest.fn(async () => ({
      transactions: [
        row('primary-unmatched', 'ffffffffffffffff'),
        row('pool-fee', null, { maj: 1, min: 4 }),
        // a served pid on a subaddress row is not an integrated receipt either
        row('pool-with-pid', leg.paymentId, { maj: 2, min: 9 })
      ]
    }))
  }
  const rawReader = { read: jest.fn(async hashes => ({ raws: [], missingHashes: hashes, stats: { requested: hashes.length } })) }
  await runReconcileOwnerFeeLegsOnce({ models, monero, rawReader })
  expect(rawReader.read).toHaveBeenCalledWith(['primary-unmatched'])
  expect(applyFeeReceipt).not.toHaveBeenCalled()
})

test('an unscannable or snapshot-mismatched platform recipient defers loudly — no scan, no receipt', async () => {
  for (const account of [null, { ...REWARDS, viewKey: null }, { ...REWARDS, status: 'INACTIVE' }, { ...REWARDS, address: 'SWAPPED' }]) {
    jest.clearAllMocks()
    const models = makeModels({ maps: [platformMap('aaaaaaaaaaaaaaa4')], account })
    const monero = { getAddressTxs: jest.fn() }
    await runReconcileOwnerFeeLegsOnce({ models, monero })
    expect(monero.getAddressTxs).not.toHaveBeenCalled()
    expect(applyFeeReceipt).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('critical', 'platform fee reconciliation unavailable', expect.any(String), expect.anything())
  }
})

test('owner legs keep their legacy PayIn requirement next to platform legs', async () => {
  const ownerOrphan = { id: 1, paymentId: 'bbbbbbbbbbbbbbb1', feeType: null, ownerUserId: 42, subName: 't', recipientAccountId: null, recipientAddress: null, expiresAt: FUTURE }
  const models = makeModels({ maps: [ownerOrphan] })
  const out = await runReconcileOwnerFeeLegsOnce({ models, monero: { getAddressTxs: jest.fn() } })
  expect(out.legs).toBe(0)
})
