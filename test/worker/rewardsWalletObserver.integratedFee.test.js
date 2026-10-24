/* eslint-env jest */
// rewardsWalletObserver's integrated platform fee branch: a primary-address
// output whose payment_id names a SubFeePidMap intent is booked through the
// shared applier (no time window — late payments still land), refused when
// it surfaces on a non-recipient account or is self-sent change, and NEVER
// falls through to the downvote/tip pid branches. Any other pid keeps its
// existing classification.
import { runRewardsWalletObserverOnce } from '@/worker/rewardsWalletObserver'
import { applyFeeReceipt, excludeProvisionalFeeReceipt } from '../../api/monero/feeObservation'
import { alert } from '../../lib/alert'

jest.mock('../../api/monero/feeObservation', () => ({
  __esModule: true,
  applyFeeReceipt: jest.fn().mockResolvedValue({ transitioned: true, cumulative: 0n }),
  excludeProvisionalFeeReceipt: jest.fn().mockResolvedValue(1)
}))
jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))

const ACCOUNT = { id: 91, label: 'platform_rewards', address: 'PLATFORM', viewKey: {} }
const PID = 'c0ffee00c0ffee00'
const FEE_MAP = { id: 3, paymentId: PID, feeType: 'TERRITORY_BILLING', recipientAccountId: 91, recipientAddress: 'PLATFORM', expiresAt: new Date(0) }
const PAYIN = { id: 12, payInType: 'TERRITORY_BILLING', moneroPaymentId: PID }

function makeModels ({ feeMap = FEE_MAP, payIn = PAYIN } = {}) {
  return {
    payIn: {
      findFirst: jest.fn().mockResolvedValue(null), // not a legacy fee subaddress
      findUnique: jest.fn(async ({ where }) => where.moneroPaymentId === PID ? payIn : null)
    },
    subFeePidMap: { findUnique: jest.fn(async ({ where }) => where.paymentId === PID ? feeMap : null) },
    subaddressIndex: { findMany: jest.fn().mockResolvedValue([]) },
    downvotePidMap: { findUnique: jest.fn().mockResolvedValue(null) },
    observedTip: { findFirst: jest.fn().mockResolvedValue(null) },
    // bounty receipt branch: no known settlement hash
    bountyPayment: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0)
  }
}
const tx = (extra = {}) => ({ hash: 'h1', payment_id: PID, piconeros: 2_000_000_000n, height: 500, recipient: { maj_i: 0, min_i: 0 }, spent_outputs: [], ...extra })

beforeEach(() => jest.clearAllMocks())

test('a fee-pid primary output is booked through the applier — even after the intent expired', async () => {
  const models = makeModels()
  await runRewardsWalletObserverOnce({ models, account: ACCOUNT, txs: [tx()] })
  expect(applyFeeReceipt).toHaveBeenCalledWith(models, {
    feeMap: FEE_MAP, feePayIn: PAYIN, txHash: 'h1', piconeros: 2_000_000_000n, height: 500, confirmations: 0
  })
  expect(models.downvotePidMap.findUnique).not.toHaveBeenCalled()
  expect(models.observedTip.findFirst).not.toHaveBeenCalled()
})

test('a fee pid seen on a non-recipient account is refused and alerted, not reinterpreted', async () => {
  const models = makeModels({ feeMap: { ...FEE_MAP, recipientAccountId: 92, recipientAddress: 'OTHER' } })
  await runRewardsWalletObserverOnce({ models, account: ACCOUNT, txs: [tx()] })
  expect(applyFeeReceipt).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('critical', 'integrated fee pid seen on a non-recipient account', expect.any(String), expect.anything())
  expect(models.downvotePidMap.findUnique).not.toHaveBeenCalled()
})

test('self-sent rewards-wallet change carrying a fee pid is excluded, never credited', async () => {
  const models = makeModels()
  const change = tx({ piconeros: 1_000_000_000n, fee: 400_000_000n, spent_outputs: [{ amount: 1_400_000_000n, sender: { maj_i: 0, min_i: 0 } }] })
  await runRewardsWalletObserverOnce({ models, account: ACCOUNT, txs: [change] })
  expect(excludeProvisionalFeeReceipt).toHaveBeenCalledWith(models, FEE_MAP, 'h1')
  expect(applyFeeReceipt).not.toHaveBeenCalled()
})

test('an owner intent pid never books platform cash and never falls through', async () => {
  const models = makeModels({ feeMap: { ...FEE_MAP, feeType: null, ownerUserId: 42 } })
  await runRewardsWalletObserverOnce({ models, account: ACCOUNT, txs: [tx()] })
  expect(applyFeeReceipt).not.toHaveBeenCalled()
  expect(models.downvotePidMap.findUnique).not.toHaveBeenCalled()
})

test('a pid that names no fee intent keeps its existing (downvote/tip) classification', async () => {
  const models = makeModels()
  await runRewardsWalletObserverOnce({ models, account: ACCOUNT, txs: [tx({ payment_id: 'deadbeefdeadbeef' })] })
  expect(applyFeeReceipt).not.toHaveBeenCalled()
  expect(models.downvotePidMap.findUnique).toHaveBeenCalledWith({ where: { paymentId: 'deadbeefdeadbeef' } })
  expect(models.observedTip.findFirst).toHaveBeenCalled()
})
