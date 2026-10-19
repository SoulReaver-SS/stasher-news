/* eslint-env jest */

// Unit tests for the shared completion enqueue (2026-09-14 A′ + Task 10):
// the delayed opsSweep follow-up and the no-QUEUED accounting readiness gate.
// Pure — fake boss/models, no DB, no wallet.

import {
  enqueueOpsSweep,
  runDistributionOnce,
  completeAndEnqueue,
  reconcileCompletionAccounting,
  OPS_SWEEP_DELAY_SECONDS
} from '@/worker/rewardsDistributor'
import { alert } from '@/lib/alert'

jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))

// The incomplete-summary cases below intentionally exercise the CRITICAL
// resumable-FAILED path. Mock the logger so expected error output stays out of
// the pure suite; assertions here remain on database writes and alerts.
jest.mock(`${process.cwd()}/lib/logger`, () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

// reconcileCompletionAccounting reads the configured wallet scope; these pure
// tests provide a placeholder identity (no wallet is ever opened here) and
// restore the environment afterwards so the shared worker process stays clean.
let priorRewardsAddress
let priorNetworkEnv
beforeAll(() => {
  priorRewardsAddress = process.env.PLATFORM_REWARDS_ADDRESS
  priorNetworkEnv = process.env.MONERO_NETWORK
  process.env.PLATFORM_REWARDS_ADDRESS = '5' + '9'.repeat(94)
  process.env.MONERO_NETWORK = 'stagenet'
})
afterAll(() => {
  if (priorRewardsAddress === undefined) delete process.env.PLATFORM_REWARDS_ADDRESS
  else process.env.PLATFORM_REWARDS_ADDRESS = priorRewardsAddress
  if (priorNetworkEnv === undefined) delete process.env.MONERO_NETWORK
  else process.env.MONERO_NETWORK = priorNetworkEnv
})

beforeEach(() => alert.mockClear())

// --- enqueueOpsSweep ---------------------------------------------------------

test('enqueues a one-shot opsSweep follow-up 1h after a COMPLETE distribution', async () => {
  const send = jest.fn()
  await enqueueOpsSweep({ send }, { id: 42, status: 'COMPLETE' })
  expect(OPS_SWEEP_DELAY_SECONDS).toBe(3600)
  expect(send).toHaveBeenCalledWith(
    'opsSweep',
    { distributionId: 42 },
    { startAfter: 3600, singletonKey: 'opsSweep-42' }
  )
})

test('does not enqueue when the distribution is not COMPLETE', async () => {
  const send = jest.fn()
  await enqueueOpsSweep({ send }, { id: 42, status: 'FAILED' })
  await enqueueOpsSweep({ send }, { id: 43, status: 'SENDING' })
  expect(send).not.toHaveBeenCalled()
})

test('eligible completion cannot silently omit scheduling when boss is absent', async () => {
  await expect(enqueueOpsSweep(undefined, { id: 42, status: 'COMPLETE' }))
    .rejects.toThrow(/boss|scheduler/i)
})

test('runDistributionOnce requires a boss before any DB work when scheduling is enabled', async () => {
  await expect(runDistributionOnce({ models: {}, sendPayouts: jest.fn() }))
    .rejects.toThrow(/boss|scheduler/i)
})

// --- completeAndEnqueue ------------------------------------------------------

function freshDistribution (overrides = {}) {
  return {
    id: 7,
    status: 'COMPLETE',
    opsSweepState: 'NOT_SWEEPED',
    opsSweptPiconeros: 0n,
    payouts: [{ id: 1, state: 'SENT' }],
    ...overrides
  }
}

function fakeModels ({ distribution, fresh, latest } = {}) {
  return {
    // The ledger now reads the complete audit snapshot. Empty groups are
    // explicit; a missing model or unregistered wallet must still fail closed.
    moneroAccount: {
      findFirst: jest.fn(async ({ where }) => where.label === 'platform_rewards'
        ? { id: 1, label: where.label, network: 'STAGENET', address: process.env.PLATFORM_REWARDS_ADDRESS }
        : null)
    },
    subaddressIndex: { findMany: jest.fn().mockResolvedValue([]) },
    feeObservation: { findMany: jest.fn().mockResolvedValue([]) },
    observedDownvote: { findMany: jest.fn().mockResolvedValue([]) },
    escrowWalletTransaction: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
    bountyPayment: { findMany: jest.fn().mockResolvedValue([]) },
    observedBounty: { findMany: jest.fn().mockResolvedValue([]) },
    observedBountyReceipt: { findMany: jest.fn().mockResolvedValue([]) },
    item: { findMany: jest.fn().mockResolvedValue([]) },
    earn: { findMany: jest.fn().mockResolvedValue([]) },
    paymentTransactionProof: { findUnique: jest.fn().mockResolvedValue(null) },
    platformFeeConfig: {
      findUnique: jest.fn().mockResolvedValue({
        downvoteRewardsPct: 100,
        postingFeeRewardsPct: 70,
        territoryFeeRewardsPct: 30,
        boostRewardsPct: 30,
        walletlessTipRewardsPct: 70
      })
    },
    rewardsWalletTransaction: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
    rewardsWalletReconciliation: { findMany: jest.fn().mockResolvedValue([]) },
    rewardPayout: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    rewardDistribution: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(fresh ?? distribution),
      findFirst: jest.fn().mockResolvedValue(latest ?? fresh ?? distribution)
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: distribution?.id ?? 7 }])
  }
}

test('completes an all-SENT distribution and enqueues the delayed sweep with the existing delay and key', async () => {
  const distribution = { id: 7, status: 'FAILED', payouts: [{ id: 1, state: 'SENT' }] }
  const fresh = freshDistribution()
  const models = fakeModels({ distribution, fresh })
  const send = jest.fn().mockResolvedValue('job-id')
  const result = await completeAndEnqueue(models, distribution, jest.fn(), { boss: { send } })
  expect(result).toBe(fresh)
  expect(models.$queryRaw).toHaveBeenCalledTimes(1) // the COMPLETE CAS
  expect(send).toHaveBeenCalledWith('opsSweep', { distributionId: 7 },
    { startAfter: OPS_SWEEP_DELAY_SECONDS, singletonKey: 'opsSweep-7' })
})

test('throws for a schedule-enabled completion without a boss before touching the database', async () => {
  const distribution = { id: 7, status: 'FAILED', payouts: [] }
  const models = fakeModels({ distribution })
  await expect(completeAndEnqueue(models, distribution, jest.fn(), {})).rejects.toThrow(/boss|scheduler/i)
  expect(models.rewardDistribution.findUnique).not.toHaveBeenCalled()
  expect(models.$queryRaw).not.toHaveBeenCalled()
})

test('a SENDING distribution is returned untouched (another sender owns it)', async () => {
  const distribution = { id: 8, status: 'SENDING', payouts: [] }
  const models = fakeModels({ distribution })
  const send = jest.fn()
  const result = await completeAndEnqueue(models, distribution, jest.fn(), { boss: { send } })
  expect(result).toBe(distribution)
  expect(models.rewardDistribution.findUnique).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

test('scheduleOpsSweep:false completes without a boss and never sends', async () => {
  const distribution = { id: 9, status: 'PENDING', payouts: [] }
  const fresh = freshDistribution({ id: 9, payouts: [] })
  const models = fakeModels({ distribution, fresh })
  const result = await completeAndEnqueue(models, distribution, jest.fn(), { scheduleOpsSweep: false })
  expect(result).toBe(fresh)
  expect(models.$queryRaw).toHaveBeenCalledTimes(1)
})

test.each([
  { sent: 15, failed: 0, skipped: 3, unpersisted: 0, accountingUnpersisted: 0 },
  { sent: 0, failed: 0, skipped: 18, unpersisted: 0, accountingUnpersisted: 1 },
  { sent: 18, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 1 }
])('an incomplete chunked run never enqueues an ops sweep (%j)', async summary => {
  const distribution = { id: 7, status: 'FAILED', payouts: [{ id: 1, state: 'QUEUED' }] }
  const fresh = freshDistribution({ status: 'FAILED', payouts: distribution.payouts })
  const models = fakeModels({ distribution, fresh })
  const send = jest.fn()
  const signer = jest.fn().mockResolvedValue(summary)
  await completeAndEnqueue(models, distribution, signer, { boss: { send } })
  expect(signer).toHaveBeenCalledTimes(1)
  expect(send).not.toHaveBeenCalled()
  expect(models.$queryRaw.mock.calls.some(([sql]) =>
    sql.join('').includes("SET status = 'FAILED'"))).toBe(true)
})

test('a successful chunked run enqueues one delayed sweep for payouts under two hashes', async () => {
  const distribution = {
    id: 7,
    status: 'FAILED',
    payouts: [{ id: 1, state: 'QUEUED' }, { id: 2, state: 'QUEUED' }]
  }
  const fresh = freshDistribution({
    status: 'COMPLETE',
    payouts: [
      { id: 1, state: 'SENT', txHash: 'a'.repeat(64) },
      { id: 2, state: 'SENT', txHash: 'b'.repeat(64) }
    ]
  })
  const models = fakeModels({ distribution, fresh })
  const send = jest.fn().mockResolvedValue('job-id')
  const signer = jest.fn().mockResolvedValue({
    sent: 18, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0
  })
  await completeAndEnqueue(models, distribution, signer, { boss: { send } })
  expect(signer).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledTimes(1) // one distribution completion, not one per payout tx
  expect(send).toHaveBeenCalledWith('opsSweep', { distributionId: 7 },
    { startAfter: OPS_SWEEP_DELAY_SECONDS, singletonKey: 'opsSweep-7' })
})

test.each([
  ['not the latest distribution', { latest: { id: 99 } }],
  ['a stranded FAILED recipient', { fresh: freshDistribution({ payouts: [{ id: 1, state: 'SENT' }, { id: 2, state: 'FAILED' }] }) }],
  ['an already-SWEPT distribution', { fresh: freshDistribution({ opsSweepState: 'SWEPT' }) }],
  ['a partially swept distribution', { fresh: freshDistribution({ opsSweptPiconeros: 5n }) }]
])('does not enqueue for %s', async (_label, overrides) => {
  const distribution = { id: 7, status: 'FAILED', payouts: [] }
  const models = fakeModels({ distribution, ...overrides })
  const send = jest.fn()
  await completeAndEnqueue(models, distribution, jest.fn(), { boss: { send } })
  expect(send).not.toHaveBeenCalled()
  expect(models.$queryRaw).toHaveBeenCalledTimes(1) // completion itself stays committed
})

test('a rejected enqueue keeps the COMPLETE write and alerts critical (never reverts payouts)', async () => {
  const distribution = { id: 7, status: 'FAILED', payouts: [{ id: 1, state: 'SENT' }] }
  const fresh = freshDistribution()
  const models = fakeModels({ distribution, fresh })
  const send = jest.fn().mockRejectedValue(new Error('queue unavailable'))
  const result = await completeAndEnqueue(models, distribution, jest.fn(), { boss: { send } })
  expect(result).toBe(fresh)
  expect(models.$queryRaw).toHaveBeenCalledTimes(1)
  expect(models.rewardPayout.update).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('critical', 'ops sweep follow-up enqueue failed',
    expect.stringContaining('distribution 7'), expect.objectContaining({ dedupeKey: 'dist-7-enqueue-failed' }))
})

test('a null singleton send (duplicate suppressed) resolves cleanly', async () => {
  const distribution = { id: 7, status: 'FAILED', payouts: [{ id: 1, state: 'SENT' }] }
  const models = fakeModels({ distribution, fresh: freshDistribution() })
  const send = jest.fn().mockResolvedValue(null)
  await expect(completeAndEnqueue(models, distribution, jest.fn(), { boss: { send } })).resolves.toBeTruthy()
  expect(send).toHaveBeenCalledTimes(1)
  expect(alert).not.toHaveBeenCalledWith('critical', 'ops sweep follow-up enqueue failed', expect.anything(), expect.anything())
})

// --- reconcileCompletionAccounting -------------------------------------------

test('a journal with no unresolved attempt needs no wallet open but still validates the ledger', async () => {
  const models = fakeModels({ distribution: { id: 12 } })
  const getWallet = jest.fn()
  await expect(reconcileCompletionAccounting(models, { id: 12 }, { getWallet })).resolves.toBe(true)
  expect(getWallet).not.toHaveBeenCalled()
  expect(models.rewardsWalletReconciliation.findMany).toHaveBeenCalledTimes(1) // ledger was read
  expect(models.rewardPayout.findMany).toHaveBeenCalledTimes(1)
})

test('a ledger query failure blocks completion readiness even without unresolved attempts', async () => {
  const models = fakeModels({ distribution: { id: 14 } })
  models.rewardsWalletReconciliation.findMany.mockRejectedValue(new Error('ledger unavailable'))
  const getWallet = jest.fn()
  await expect(reconcileCompletionAccounting(models, { id: 14 }, { getWallet })).resolves.toBe(false)
  expect(getWallet).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('critical', 'rewards distribution completion blocked by unresolved wallet accounting',
    expect.stringContaining('distribution 14'), expect.objectContaining({ dedupeKey: 'dist-14-accounting-blocked' }))
})

test('an attempted journal row whose reconciliation cannot run blocks completion', async () => {
  const models = fakeModels({ distribution: { id: 13 } })
  models.rewardsWalletTransaction.findMany.mockResolvedValue([{ id: 1, kind: 'PAYOUT', distributionId: 13 }])
  const getWallet = jest.fn().mockRejectedValue(new Error('wallet unavailable'))
  await expect(reconcileCompletionAccounting(models, { id: 13 }, { getWallet })).resolves.toBe(false)
  expect(alert).toHaveBeenCalledWith('critical', 'rewards distribution completion blocked by unresolved wallet accounting',
    expect.stringContaining('distribution 13'), expect.objectContaining({ dedupeKey: 'dist-13-accounting-blocked' }))
})

test('a failed journal query blocks completion readiness (never bypasses it)', async () => {
  const distribution = { id: 11, status: 'FAILED', payouts: [] }
  const models = fakeModels({ distribution })
  models.rewardsWalletTransaction.findMany.mockRejectedValue(new Error('journal read failed'))
  const result = await completeAndEnqueue(models, distribution, jest.fn(), { boss: { send: jest.fn() } })
  expect(result).toBe(distribution)
  expect(models.$queryRaw).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('critical', 'rewards distribution completion blocked by unresolved wallet accounting',
    expect.stringContaining('distribution 11'), expect.objectContaining({ dedupeKey: 'dist-11-accounting-blocked' }))
})
