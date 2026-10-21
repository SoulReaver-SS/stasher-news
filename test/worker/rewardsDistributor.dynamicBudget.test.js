/* eslint-env jest */

import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { runDistributionOnce, isSerializationFailure } from '@/worker/rewardsDistributor'
import { incomeFromInflow, readCuratorBudgetHistory, readCuratorBudgetIncomeHistory } from '@/worker/curatorBudget'
import { computeCuratorBudget, resolveCuratorBudgetConfig } from '@/lib/curatorBudget'
import { approveCuratorMakeup } from '../../scripts/approve-curator-makeup'
import { computeEligibleTipVolume } from '@/worker/eligibleTipVolume'
import { CURATOR_FALLBACK_CAP_PICONEROS } from '@/lib/rewardsAccounting'
import { alert } from '@/lib/alert'
import { logError } from '../../lib/logger'

// Real allocation/SQL/ledger integration with the dynamic curator budget.
// Fake signer only; never run these multiweek fixtures against a shared dev
// pool or a real rewards wallet. Run against a migrated, dedicated
// stasher_rewards_dynamic_test (or another isolated *_test) database:
//   DATABASE_URL=<isolated-db-url> npm test -- --runTestsByPath test/worker/rewardsDistributor.dynamicBudget.test.js
const ISOLATED_DB = (() => {
  try {
    return [
      '/stasher_rewards_dynamic_test',
      '/stasher_rewards_cap_test',
      '/stasher_rewards_repair_test'
    ].includes(new URL(process.env.DATABASE_URL).pathname)
  } catch { return false }
})()

jest.mock('../../lib/alert', () => ({ alert: jest.fn() }))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn() },
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))
// Delegate to the real SQL by default; individual tests replace it with a
// thrown error to exercise the savepoint/fallback and serialization paths.
jest.mock('../../worker/eligibleTipVolume', () => ({
  computeEligibleTipVolume: jest.fn((...args) =>
    jest.requireActual('../../worker/eligibleTipVolume').computeEligibleTipVolume(...args))
}))

const XMR = 1_000_000_000_000n
const CAP = CURATOR_FALLBACK_CAP_PICONEROS
const DAY = 24 * 60 * 60 * 1000
const START = new Date('2026-10-19T00:00:00Z') // Monday 00:00 UTC
const TIP = 250_000_000_000n // 0.25 XMR; four equal tippers give T = 1 XMR

// Pure income definition (spec §3.1): the donation rewards share is exactly
// inflow.raw.donate, so a donation raises the pool but never F.
describe('incomeFromInflow', () => {
  test('subtracts the donation rewards share and floors at zero', () => {
    expect(incomeFromInflow({ rewardsPiconeros: 5n * XMR, raw: { donate: 2n * XMR } })).toBe(3n * XMR)
    expect(incomeFromInflow({ rewardsPiconeros: 2n * XMR, raw: { donate: 2n * XMR } })).toBe(0n)
    expect(incomeFromInflow({ rewardsPiconeros: 1n * XMR, raw: { donate: 2n * XMR } })).toBe(0n)
    expect(incomeFromInflow({})).toBe(0n)
  })
})

// Actual shapes captured from forced conflicts on PostgreSQL 16 / Prisma
// 5.20.0: a write conflict is P2034; raw SERIALIZABLE/deadlock failures are
// P2010 with meta.code 40001 / 40P01. All three must escape the savepoint.
describe('isSerializationFailure', () => {
  test.each([
    ['Prisma write conflict', { code: 'P2034', meta: { modelName: 'PlatformFeeConfig' } }],
    ['raw serialization failure', { code: 'P2010', meta: { code: '40001' } }],
    ['raw deadlock', { code: 'P2010', meta: { code: '40P01' } }],
    ['bare serialization code', { code: '40001' }]
  ])('%s escapes', (_label, error) => {
    expect(isSerializationFailure(error)).toBe(true)
  })

  test.each([
    ['plain error', new Error('planning failed')],
    ['raw SQL error', { code: 'P2010', meta: { code: '22012' } }]
  ])('%s is recoverable', (_label, error) => {
    expect(isSerializationFailure(error)).toBe(false)
  })
})

;(ISOLATED_DB ? describe : describe.skip)('dynamic curator budget (isolated DB, fake signer)', () => {
  const db = new PrismaClient()
  const created = { users: [], accounts: [], items: [], distributions: [] }
  const savedEnv = {}
  let savedConfig
  let savedHealth
  let authorId
  let curators
  let recipient

  beforeAll(async () => {
    for (const key of ['MONERO_NETWORK', 'PLATFORM_REWARDS_ADDRESS']) savedEnv[key] = process.env[key]
    process.env.MONERO_NETWORK = 'stagenet'
    process.env.PLATFORM_REWARDS_ADDRESS = '5' + '7'.repeat(94)
    // A fresh migrated DB has no config row yet (cap/backfill suites upsert it
    // the same way); afterAll restores whatever was here before this run.
    await db.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
    savedConfig = await db.platformFeeConfig.findUnique({ where: { id: 1 } })
    savedHealth = await db.healthSnapshot.findUnique({ where: { id: 1 } })
  })

  beforeEach(async () => {
    // Freeze only the clock, not Prisma's IO or transaction timeout timers.
    jest.useFakeTimers({
      now: START,
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']
    })
    expect(await db.rewardDistribution.count()).toBe(0)
    await setConfig()
    alert.mockReset()
    logError.mockClear()
    computeEligibleTipVolume.mockClear()
    curators = []
    await seedBase()
  })

  afterEach(async () => {
    await cleanupFixtures()
    if (savedHealth) {
      await db.healthSnapshot.upsert({
        where: { id: 1 },
        update: { trustCompletedAt: savedHealth.trustCompletedAt },
        create: { id: 1, trustCompletedAt: savedHealth.trustCompletedAt }
      })
    } else {
      await db.healthSnapshot.deleteMany({ where: { id: 1 } })
    }
    jest.useRealTimers()
  })

  afterAll(async () => {
    if (savedConfig) {
      await db.platformFeeConfig.update({
        where: { id: 1 },
        data: {
          curatorTrustWeightFloor: savedConfig.curatorTrustWeightFloor,
          distributionTopN: savedConfig.distributionTopN,
          distributionMinPayoutPiconeros: savedConfig.distributionMinPayoutPiconeros,
          postingFeeRewardsPct: savedConfig.postingFeeRewardsPct,
          curatorBudgetMode: savedConfig.curatorBudgetMode,
          curatorBudgetMultBps: savedConfig.curatorBudgetMultBps,
          curatorBudgetDrawdownWeeks: savedConfig.curatorBudgetDrawdownWeeks,
          curatorBudgetAvgPeriods: savedConfig.curatorBudgetAvgPeriods,
          curatorTipCapShareBps: savedConfig.curatorTipCapShareBps,
          curatorBreakerRatioBps: savedConfig.curatorBreakerRatioBps,
          curatorBreakerFloorMedianPeriods: savedConfig.curatorBreakerFloorMedianPeriods,
          curatorBreakerArmPeriods: savedConfig.curatorBreakerArmPeriods
        }
      })
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await db.$disconnect()
  })

  async function setConfig (overrides = {}) {
    await db.platformFeeConfig.update({
      where: { id: 1 },
      data: {
        curatorTrustWeightFloor: 1.0,
        distributionTopN: 10,
        distributionMinPayoutPiconeros: 1_000_000_000n,
        postingFeeRewardsPct: 100,
        curatorBudgetMode: 'LEGACY',
        curatorBudgetMultBps: 15000,
        curatorBudgetDrawdownWeeks: 13,
        curatorBudgetAvgPeriods: 4,
        curatorTipCapShareBps: 2500,
        curatorBreakerRatioBps: 25000,
        curatorBreakerFloorMedianPeriods: 12,
        curatorBreakerArmPeriods: 4,
        ...overrides
      }
    })
  }

  async function cleanupFixtures () {
    await db.earn.deleteMany({ where: { distributionId: { in: created.distributions } } })
    await db.rewardPayout.deleteMany({ where: { distributionId: { in: created.distributions } } })
    await db.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
    await db.observedTip.deleteMany({ where: { postId: { in: created.items } } })
    await db.feeObservation.deleteMany({ where: { txHash: { startsWith: 'dcb-fee-' } } })
    await db.item.deleteMany({ where: { id: { in: created.items } } })
    await db.userSubTrust.deleteMany({ where: { userId: { in: created.users } } })
    await db.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
    await db.user.updateMany({ where: { id: { in: created.users } }, data: { referrerId: null } })
    await db.user.deleteMany({ where: { id: { in: created.users } } })
    for (const ids of Object.values(created)) ids.length = 0
  }

  async function createUser () {
    const user = await db.user.create({ data: {} })
    created.users.push(user.id)
    return user.id
  }

  async function createAccount (ownerUserId, label, address = '5' + randomBytes(47).toString('hex')) {
    const account = await db.moneroAccount.create({
      data: { ownerUserId, label, address, network: 'STAGENET', status: 'ACTIVE' }
    })
    created.accounts.push(account.id)
    return account
  }

  async function seedBase () {
    authorId = await createUser()
    recipient = await createAccount(null, 'author')
    await createAccount(null, 'platform_rewards', process.env.PLATFORM_REWARDS_ADDRESS)
    for (let i = 0; i < 4; i++) {
      const id = await createUser()
      await createAccount(id, `curator-${i}`)
      curators.push(id)
    }
  }

  async function createItem (userId, createdAt) {
    const [item] = await db.$queryRaw`
      INSERT INTO "Item" ("userId", title, "weightedVotes", created_at)
      VALUES (${userId}::int, 'dynamic budget test post', 10, ${createdAt}) RETURNING id::int`
    created.items.push(item.id)
    await db.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
    return item
  }

  async function seedTip (tipperId, postId, piconeros, confirmedAt) {
    await db.observedTip.create({
      data: {
        postId,
        tipperId,
        recipientAccountId: recipient.id,
        paymentId: randomBytes(8).toString('hex'),
        txHash: randomBytes(32).toString('hex'),
        piconeros,
        state: 'CONFIRMED',
        confirmedAt
      }
    })
  }

  async function seedItemsAndTips (piconerosEach = TIP) {
    const createdAt = new Date(Date.now() - DAY)
    for (let i = 0; i < curators.length; i++) {
      const item = await createItem(authorId, createdAt)
      await seedTip(curators[i], item.id, piconerosEach, createdAt)
    }
  }

  async function seedInflow (piconeros) {
    await db.feeObservation.create({
      data: {
        feeType: 'POSTING',
        txHash: 'dcb-fee-' + randomBytes(16).toString('hex'),
        recipientMajor: 3,
        recipientMinor: 1,
        piconeros,
        state: 'CONFIRMED',
        walletReceipt: true,
        confirmedAt: new Date(Date.now() - 60 * 60 * 1000)
      }
    })
  }

  async function seedDonation (piconeros, donationRewardsPct = 100) {
    await db.feeObservation.create({
      data: {
        feeType: 'DONATE',
        txHash: 'dcb-fee-' + randomBytes(16).toString('hex'),
        recipientMajor: 3,
        recipientMinor: 1,
        piconeros,
        donationRewardsPct,
        state: 'CONFIRMED',
        walletReceipt: true,
        confirmedAt: new Date(Date.now() - 60 * 60 * 1000)
      }
    })
  }

  async function seedHistory ({
    count = 4,
    t = XMR,
    income = XMR,
    lastRollover = 99n * XMR,
    tripped = false,
    rawT = null,
    cappedT = null,
    multBps = 15000,
    approved = false
  } = {}) {
    let last
    for (let i = 0; i < count; i++) {
      const daysToEnd = (count - i) * 7
      const periodEnd = new Date(START.getTime() - daysToEnd * DAY)
      const periodStart = new Date(periodEnd.getTime() - 7 * DAY)
      const isLast = i === count - 1
      const trustedTipPiconeros = isLast && tripped && cappedT != null ? cappedT : t
      last = await db.rewardDistribution.create({
        data: {
          periodStart,
          periodEnd,
          poolPiconeros: 0n,
          distributedPiconeros: 0n,
          rolledOverPiconeros: isLast ? lastRollover : 0n,
          payoutCount: 0,
          status: 'COMPLETE',
          rawTipPiconeros: isLast && tripped && rawT != null ? rawT : t,
          trustedTipPiconeros,
          incomePiconeros: income,
          multBps,
          // Plausible recorded budget fields: the planner only feeds on these
          // rows' T/F/breaker/make-up columns, never their recorded budget.
          reservePiconeros: 5n * XMR,
          spendLimitPiconeros: XMR,
          // A NULL multBps row (T4 = 0) records a 0 dynamic budget in fixtures.
          dynamicBudgetPiconeros: trustedTipPiconeros * BigInt(multBps ?? 0) / 10000n,
          dynamicBudgetMode: 'FULL',
          curatorBudgetMode: 'LEGACY',
          breakerTripped: isLast && tripped,
          breakerRawTPiconeros: isLast && tripped ? rawT : null,
          breakerMakeupApproved: isLast && approved
        }
      })
      created.distributions.push(last.id)
    }
    return last
  }

  async function seedTrustHeartbeat (at) {
    await db.userSubTrust.create({
      data: { subName: 'stasher', userId: curators[0], zapPostTrust: 0.5 }
    })
    await db.healthSnapshot.upsert({
      where: { id: 1 },
      update: { trustCompletedAt: at },
      create: { id: 1, trustCompletedAt: at }
    })
  }

  async function fakeSigner (payouts) {
    await db.rewardPayout.updateMany({
      where: { id: { in: payouts.map(p => p.id) }, state: 'QUEUED' },
      data: { state: 'SENT', txHash: 'ab'.repeat(32) }
    })
    return { sent: payouts.length, skipped: 0, failed: 0 }
  }

  async function run (sendPayouts = fakeSigner) {
    const distribution = await runDistributionOnce({
      models: db,
      sendPayouts,
      scheduleOpsSweep: false
    })
    if (!created.distributions.includes(distribution.id)) created.distributions.push(distribution.id)
    return distribution
  }

  // Manual history rows are intentional fixtures; these assertions care about
  // rows created by the run under test (this UTC week or later).
  async function runWeekCount () {
    return await db.rewardDistribution.count({ where: { periodEnd: { gte: START } } })
  }

  async function expectConserved (distribution) {
    const earns = await db.earn.aggregate({
      where: { distributionId: distribution.id },
      _sum: { piconeros: true }
    })
    expect(earns._sum.piconeros ?? 0n).toBe(distribution.distributedPiconeros)
    expect(distribution.payouts.reduce((sum, p) => sum + p.piconeros, 0n)).toBe(distribution.distributedPiconeros)
    expect(distribution.distributedPiconeros + distribution.rolledOverPiconeros).toBe(distribution.poolPiconeros)
  }

  async function deleteDistribution (distribution) {
    await db.earn.deleteMany({ where: { distributionId: distribution.id } })
    await db.rewardPayout.deleteMany({ where: { distributionId: distribution.id } })
    await db.rewardDistribution.delete({ where: { id: distribution.id } })
    created.distributions = created.distributions.filter(id => id !== distribution.id)
  }

  test('LEGACY records T, F, T4, F4, the dynamic budget and pays the fallback cap', async () => {
    await seedHistory()
    await seedItemsAndTips()
    await seedInflow(XMR)

    const distribution = await run()

    expect(distribution.poolPiconeros).toBe(100n * XMR)
    expect(distribution.curatorBudgetMode).toBe('LEGACY')
    expect(distribution.rawTipPiconeros).toBe(XMR)
    expect(distribution.trustedTipPiconeros).toBe(XMR)
    expect(distribution.tipperCount).toBe(4)
    expect(distribution.incomePiconeros).toBe(XMR)
    expect(distribution.tipT4Piconeros).toBe(XMR)
    expect(distribution.incomeF4Piconeros).toBe(XMR)
    // reserve = 100 − 1 = 99 XMR; limit = (1 + 99/13) × 10/11.
    expect(distribution.reservePiconeros).toBe(99n * XMR)
    expect(distribution.spendLimitPiconeros).toBe(7_832_167_832_167n)
    expect(distribution.multBps).toBe(15000)
    expect(distribution.dynamicBudgetPiconeros).toBe(15n * XMR / 10n)
    expect(distribution.dynamicBudgetMode).toBe('FULL')
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(CAP)
    expect(distribution.distributedPiconeros).toBe(CAP)
    expect(distribution.payouts).toHaveLength(4)
    expect(distribution.eligibleTipStages).toMatchObject({
      raw: XMR.toString(),
      eligible: XMR.toString(),
      afterExclusions: XMR.toString(),
      ranked: XMR.toString(),
      handicapped: XMR.toString(),
      trusted: XMR.toString(),
      capped: XMR.toString(),
      final: XMR.toString(),
      staleTrustFallback: false,
      breakerArmed: true,
      breakerThreshold: (25n * XMR / 10n).toString()
    })
    expect(distribution.breakerTripped).toBe(false)
    expect(distribution.makeupPiconeros).toBe(0n)
    expect(alert).not.toHaveBeenCalled()
    await expectConserved(distribution)
  })

  test('T and F history are filtered independently, newest first', async () => {
    const makeRow = async ({ days, trustedTipPiconeros, incomePiconeros }) => {
      const periodEnd = new Date(START.getTime() - days * DAY)
      const row = await db.rewardDistribution.create({
        data: {
          periodStart: new Date(periodEnd.getTime() - 7 * DAY),
          periodEnd,
          poolPiconeros: 0n,
          distributedPiconeros: 0n,
          rolledOverPiconeros: 0n,
          payoutCount: 0,
          status: 'COMPLETE',
          trustedTipPiconeros,
          incomePiconeros
        }
      })
      created.distributions.push(row.id)
      return row
    }
    const tAndF = await makeRow({ days: 21, trustedTipPiconeros: 3n * XMR, incomePiconeros: 4n * XMR })
    const fOnly = await makeRow({ days: 14, trustedTipPiconeros: null, incomePiconeros: 2n * XMR })
    const tOnly = await makeRow({ days: 7, trustedTipPiconeros: XMR, incomePiconeros: null })

    const tHistory = await readCuratorBudgetHistory(db, { limit: 2 })
    const fHistory = await readCuratorBudgetIncomeHistory(db, { limit: 2 })

    expect(tHistory.map(row => row.id)).toEqual([tOnly.id, tAndF.id])
    expect(fHistory.map(row => row.id)).toEqual([fOnly.id, tAndF.id])
    expect(await readCuratorBudgetIncomeHistory(db, { limit: 0 })).toEqual([])
  })

  test('SHADOW pays exactly the LEGACY contract and records the mode', async () => {
    await seedHistory()
    await seedItemsAndTips()
    await seedInflow(XMR)

    const legacy = await run()
    const legacyPayouts = legacy.payouts
      .map(p => ({ curatorId: p.curatorId, piconeros: p.piconeros }))
      .sort((a, b) => a.curatorId - b.curatorId)
    const legacyDistributed = legacy.distributedPiconeros
    const legacyRolledOver = legacy.rolledOverPiconeros
    await deleteDistribution(legacy)

    await setConfig({ curatorBudgetMode: 'SHADOW' })
    const shadow = await run()

    expect(shadow.curatorBudgetMode).toBe('SHADOW')
    expect(shadow.appliedCuratorBudgetPiconeros).toBe(CAP)
    expect(shadow.dynamicBudgetPiconeros).toBe(15n * XMR / 10n)
    expect(shadow.payouts.map(p => ({ curatorId: p.curatorId, piconeros: p.piconeros }))
      .sort((a, b) => a.curatorId - b.curatorId)).toEqual(legacyPayouts)
    expect(shadow.distributedPiconeros).toBe(legacyDistributed)
    expect(shadow.rolledOverPiconeros).toBe(legacyRolledOver)
    await expectConserved(shadow)
  })

  test('ACTIVE pays k × T4 and referrals from the remainder', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedHistory()
    await seedItemsAndTips()
    await seedInflow(XMR)
    const referrerId = await createUser()
    await createAccount(referrerId, 'referrer-payout')
    await db.user.update({ where: { id: curators[0] }, data: { referrerId } })

    const distribution = await run()

    expect(distribution.curatorBudgetMode).toBe('ACTIVE')
    expect(distribution.dynamicBudgetMode).toBe('FULL')
    expect(distribution.dynamicBudgetPiconeros).toBe(15n * XMR / 10n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(15n * XMR / 10n)
    const curatorPayouts = distribution.payouts.filter(p => p.curatorId !== referrerId)
    const referral = distribution.payouts.find(p => p.curatorId === referrerId)
    expect(curatorPayouts.reduce((sum, p) => sum + p.piconeros, 0n)).toBe(15n * XMR / 10n)
    const referredShare = curatorPayouts.find(p => p.curatorId === curators[0]).piconeros
    expect(referral.piconeros).toBe(referredShare / 10n)
    expect(distribution.distributedPiconeros).toBe(15n * XMR / 10n + referral.piconeros)
    await expectConserved(distribution)
  })

  test('ACTIVE pays the drawdown limit when it binds, with referrals from the remainder', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    // I4 = T4 = 1 XMR; pool 7.5 = rollover 6.5 + income 1, so reserve = 6.5
    // and the limit (1 + 6.5/13) × 10/11 ≈ 1.36 XMR binds below the 1.5
    // XMR target (spec §3.2).
    await seedHistory({ lastRollover: 13n * XMR / 2n })
    await seedItemsAndTips()
    await seedInflow(XMR)
    const referrerId = await createUser()
    await createAccount(referrerId, 'referrer-payout')
    await db.user.update({ where: { id: curators[0] }, data: { referrerId } })

    const distribution = await run()

    const limit = 1_363_636_363_636n
    expect(distribution.poolPiconeros).toBe(15n * XMR / 2n)
    expect(distribution.dynamicBudgetMode).toBe('DRAWDOWN')
    expect(distribution.dynamicBudgetPiconeros).toBe(limit)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(limit)
    expect(distribution.multBps).toBe(13636) // floor(limit × 10000 / T4)
    // The recorded inputs replay through the pure function to the same plan.
    const { params } = resolveCuratorBudgetConfig(
      await db.platformFeeConfig.findUnique({ where: { id: 1 } }))
    const pure = computeCuratorBudget({
      poolPiconeros: distribution.poolPiconeros,
      tipVolumes: [distribution.trustedTipPiconeros, XMR, XMR, XMR, XMR],
      incomeVolumes: [distribution.incomePiconeros, XMR, XMR, XMR],
      params
    })
    expect(distribution.reservePiconeros).toBe(13n * XMR / 2n)
    expect(distribution.reservePiconeros).toBe(pure.reservePiconeros)
    expect(distribution.spendLimitPiconeros).toBe(limit)
    expect(distribution.spendLimitPiconeros).toBe(pure.limitPiconeros)
    expect(distribution.dynamicBudgetPiconeros).toBe(pure.budgetPiconeros)
    expect(distribution.curatorBudgetParams.drawdownWeeks).toBe(13)
    // Four equal shares floor exactly to the limit — no allocator dust.
    const curatorPayouts = distribution.payouts.filter(p => p.curatorId !== referrerId)
    const referral = distribution.payouts.find(p => p.curatorId === referrerId)
    expect(curatorPayouts.reduce((sum, p) => sum + p.piconeros, 0n)).toBe(limit)
    expect(referral.piconeros).toBe(limit / 4n / 10n)
    expect(distribution.distributedPiconeros).toBe(limit + referral.piconeros)
    await expectConserved(distribution)
  })

  test('ACTIVE records POOL_SHORT when the pool cannot cover the budget', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    // No current F: I4 = median(0, 1, 1, 1) = 1; reserve = max(0.5 − 1, 0) =
    // 0; the limit 1 × 10/11 and the pool 0.5 both bind below the 1.5 target —
    // the pool names the outcome.
    await seedHistory({ lastRollover: XMR / 2n })
    await seedItemsAndTips()

    const distribution = await run()

    expect(distribution.poolPiconeros).toBe(XMR / 2n)
    expect(distribution.incomePiconeros).toBe(0n)
    // I4 = median(0, 1, 1, 1) = 1 XMR; reserve = 0; limit = 1 × 10/11.
    expect(distribution.incomeF4Piconeros).toBe(XMR)
    expect(distribution.reservePiconeros).toBe(0n)
    expect(distribution.spendLimitPiconeros).toBe(909_090_909_090n)
    expect(distribution.multBps).toBe(5000)
    expect(distribution.dynamicBudgetMode).toBe('POOL_SHORT')
    expect(distribution.dynamicBudgetPiconeros).toBe(XMR / 2n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(XMR / 2n)
    await expectConserved(distribution)
  })

  test('a donation raises the pool but not incomePiconeros', async () => {
    await seedItemsAndTips()
    await seedDonation(2n * XMR)

    const distribution = await run()

    expect(distribution.poolPiconeros).toBe(2n * XMR)
    expect(distribution.incomePiconeros).toBe(0n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(CAP)
    await expectConserved(distribution)
  })

  test('LEGACY breaker: a 3× spike is capped and raises a post-commit warn alert', async () => {
    await seedHistory()
    await seedItemsAndTips(3n * XMR / 4n) // current T = 3 XMR
    await seedInflow(XMR)
    const committedAtAlert = []
    alert.mockImplementation((level, title, body, opts = {}) => {
      if (opts.dedupeKey?.startsWith('curator-breaker-')) {
        committedAtAlert.push(db.rewardDistribution.count({
          where: { id: Number(opts.dedupeKey.replace('curator-breaker-', '')) }
        }))
      }
    })

    const distribution = await run()

    expect(distribution.trustedTipPiconeros).toBe(25n * XMR / 10n)
    expect(distribution.breakerTripped).toBe(true)
    expect(distribution.breakerRawTPiconeros).toBe(3n * XMR)
    expect(distribution.eligibleTipStages).toMatchObject({
      breakerArmed: true,
      breakerThreshold: (25n * XMR / 10n).toString(),
      final: (25n * XMR / 10n).toString()
    })
    expect(distribution.dynamicBudgetPiconeros).toBe(20625n * XMR / 10000n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(CAP)

    const breakerCalls = alert.mock.calls.filter(([, , , opts = {}]) =>
      opts.dedupeKey === `curator-breaker-${distribution.id}`)
    expect(breakerCalls).toHaveLength(1)
    expect(breakerCalls[0][0]).toBe('warn')
    expect(breakerCalls[0][2]).toContain('3000000000000')
    expect(breakerCalls[0][2]).toContain('2500000000000')
    expect(breakerCalls[0][2]).toContain(`sndev monero makeup ${distribution.id} --confirm`)
    expect(breakerCalls[0][2]).toContain('scripts/approve-curator-makeup.js')
    expect(breakerCalls[0][2]).toContain('2026-10-26')
    expect(breakerCalls[0][2]).not.toContain('zero-history')
    expect(await Promise.all(committedAtAlert)).toEqual([1])
    await expectConserved(distribution)
  })

  test('ACTIVE breaker raises a critical alert and pays the capped T4 budget', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedHistory()
    await seedItemsAndTips(3n * XMR / 4n)
    await seedInflow(XMR)

    const distribution = await run()

    expect(distribution.breakerTripped).toBe(true)
    expect(distribution.trustedTipPiconeros).toBe(25n * XMR / 10n)
    expect(distribution.dynamicBudgetPiconeros).toBe(20625n * XMR / 10000n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(20625n * XMR / 10000n)
    const breakerCalls = alert.mock.calls.filter(([, , , opts = {}]) =>
      opts.dedupeKey === `curator-breaker-${distribution.id}`)
    expect(breakerCalls).toHaveLength(1)
    expect(breakerCalls[0][0]).toBe('critical')
    await expectConserved(distribution)
  })

  test('zero-history recovery caps positive T to 0 and explains the accepted dead-week edge', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedHistory({ count: 12, t: 0n })
    await seedItemsAndTips()
    await seedInflow(XMR)

    const distribution = await run()

    expect(distribution.rawTipPiconeros).toBe(XMR)
    expect(distribution.trustedTipPiconeros).toBe(0n)
    expect(distribution.dynamicBudgetPiconeros).toBe(0n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(0n)
    expect(distribution.distributedPiconeros).toBe(0n)
    expect(distribution.rolledOverPiconeros).toBe(distribution.poolPiconeros)
    expect(distribution.eligibleTipStages).toMatchObject({
      raw: XMR.toString(),
      breakerArmed: true,
      breakerThreshold: '0',
      final: '0'
    })

    const breakerCalls = alert.mock.calls.filter(([, , , opts = {}]) =>
      opts.dedupeKey === `curator-breaker-${distribution.id}`)
    expect(breakerCalls).toHaveLength(1)
    expect(breakerCalls[0][0]).toBe('critical')
    const body = breakerCalls[0][2]
    expect(body).toContain('accepted zero-history/recovery edge')
    expect(body).toContain('configured 12-period median window has a zero median')
    expect(body).toContain('does not prove every period was inactive')
    expect(body).toContain('a capped run records T 0')
    expect(body).toContain('can re-trip the breaker every week while that recorded baseline stays zero')
    expect(body).toContain('cannot clear on its own')
    expect(body).toContain(`sndev monero makeup ${distribution.id} --confirm`)
    expect(body).toContain('2026-10-26')
    await expectConserved(distribution)
  })

  test('the breaker is not armed with fewer than four recorded periods', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedHistory({ count: 3 })
    await seedItemsAndTips(3n * XMR / 4n)
    await seedInflow(XMR)

    const distribution = await run()

    expect(distribution.breakerTripped).toBe(false)
    expect(distribution.trustedTipPiconeros).toBe(3n * XMR)
    expect(distribution.eligibleTipStages).toMatchObject({
      breakerArmed: false,
      breakerThreshold: (25n * XMR / 10n).toString(),
      final: (3n * XMR).toString()
    })
    expect(alert.mock.calls.some(([, , , opts = {}]) =>
      opts.dedupeKey?.startsWith('curator-breaker-'))).toBe(false)
    await expectConserved(distribution)
  })

  test('a valid arming window above both windows still arms and caps the spike', async () => {
    // Whole-branch review I1: avg=4 and median=12 are both below arm=20. With
    // 30 recorded periods the planner must retain at least 20, not truncate to
    // 12 and silently disable the breaker forever.
    await setConfig({
      curatorBudgetMode: 'ACTIVE',
      curatorBudgetAvgPeriods: 4,
      curatorBreakerFloorMedianPeriods: 12,
      curatorBreakerArmPeriods: 20
    })
    await seedHistory({ count: 30, t: 100n })
    // Four equal 2500-pico tips: T = 10_000 pico, each exactly the 25% cap.
    await seedItemsAndTips(2_500n)
    await seedInflow(XMR)

    const distribution = await run()

    expect(distribution.trustedTipPiconeros).toBe(250n)
    expect(distribution.breakerTripped).toBe(true)
    expect(distribution.makeupPiconeros).toBe(0n)
    // T4 = floor((250 + 100 + 100 + 100) / 4) = 137; full multiplier.
    expect(distribution.tipT4Piconeros).toBe(137n)
    expect(distribution.dynamicBudgetPiconeros).toBe(205n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(205n)
    expect(distribution.eligibleTipStages).toMatchObject({
      capped: '10000',
      final: '250',
      breakerArmed: true,
      breakerThreshold: '250'
    })
    // The retained history covers the arming requirement, not just the two
    // calculation windows.
    expect(distribution.curatorBudgetParams.historyIds).toHaveLength(20)
    await expectConserved(distribution)
  })

  test('an approved make-up is paid once on the immediately following run', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    const tripped = await seedHistory({
      tripped: true,
      rawT: 3n * XMR,
      cappedT: 25n * XMR / 10n
    })
    await seedItemsAndTips()
    await seedInflow(XMR)

    const dry = await approveCuratorMakeup(db, tripped.id, { confirm: false })
    expect(dry.approved).toBe(false)
    expect(dry.makeupPiconeros).toBe(187_500_000_000n)
    expect((await db.rewardDistribution.findUnique({ where: { id: tripped.id } })).breakerMakeupApproved).toBe(false)

    const approval = await approveCuratorMakeup(db, tripped.id, { confirm: true })
    expect(approval.approved).toBe(true)
    expect((await db.rewardDistribution.findUnique({ where: { id: tripped.id } })).breakerMakeupApproved).toBe(true)

    const first = await run()
    expect(first.makeupPiconeros).toBe(187_500_000_000n)
    expect(first.dynamicBudgetPiconeros).toBe(225n * XMR / 100n)
    expect(first.appliedCuratorBudgetPiconeros).toBe(225n * XMR / 100n)
    await expectConserved(first)

    jest.setSystemTime(new Date(START.getTime() + 7 * DAY))
    await seedItemsAndTips()
    await seedInflow(XMR)
    const second = await run()
    expect(second.makeupPiconeros).toBe(0n)
    expect(second.dynamicBudgetPiconeros).toBe(20625n * XMR / 10000n)
    await expectConserved(second)
  })

  test('an approved make-up raises the target but pays only the drawdown limit', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    // T4 = (1 + 2.5 + 1 + 1) / 4 = 1.375 XMR; the approved make-up adds
    // (3 − 2.5) × 1.5 ÷ 4 = 0.1875 XMR to the 2.0625 XMR target, but the
    // limit on the small pool still binds (spec §3.2/§5).
    await seedHistory({
      lastRollover: 13n * XMR / 2n,
      tripped: true,
      rawT: 3n * XMR,
      cappedT: 25n * XMR / 10n,
      approved: true
    })
    await seedItemsAndTips()
    await seedInflow(XMR)

    const distribution = await run()

    expect(distribution.makeupPiconeros).toBe(187_500_000_000n)
    expect(distribution.dynamicBudgetMode).toBe('DRAWDOWN')
    expect(distribution.dynamicBudgetPiconeros).toBe(1_363_636_363_636n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(1_363_636_363_636n)
    expect(distribution.multBps).toBe(9917) // floor(limit × 10000 / T4)
    await expectConserved(distribution)
  })

  test('a make-up is recorded but not paid outside ACTIVE', async () => {
    await seedHistory({
      tripped: true,
      rawT: 3n * XMR,
      cappedT: 25n * XMR / 10n,
      approved: true
    })
    await seedItemsAndTips()
    await seedInflow(XMR)

    const distribution = await run()

    expect(distribution.makeupPiconeros).toBe(187_500_000_000n)
    expect(distribution.dynamicBudgetPiconeros).toBe(225n * XMR / 100n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(CAP)
    expect(distribution.distributedPiconeros).toBe(CAP)
    await expectConserved(distribution)
  })

  test('an unrecordable effective multiple fails safe inside planning: fallback cap, one CRITICAL alert', async () => {
    // Whole-branch review I1: a tiny positive T4 plus an approved make-up is
    // not bounded by the configured k. Prior recorded T [10, 4, 4, 4] pico;
    // the current raw T 149e9 trips the breaker again (threshold
    // floor(mean([10,4,4,4]) x 2.5) = 12) and is capped to 12, so
    // T4 = floor((12 + 10 + 4 + 4) / 4) = 7 and the approved make-up
    // (149e9 - 10) x 15000 / 40000 = 55874999996 pico puts the target at
    // 55875000006 < limit 474125874125 (FULL). The effective multiple
    // floor(55875000006 x 10000 / 7) = 79821428580000 exceeds int4 and
    // GraphQL Int: planning must reject it inside the protected savepoint so
    // the run pays the 0.2 XMR fallback instead of aborting the ledger write.
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedHistory({
      t: 4n,
      income: 65_000_000_000n,
      tripped: true,
      rawT: 149_000_000_000n,
      cappedT: 10n,
      approved: true,
      lastRollover: 5_935_000_000_000n
    })
    // Four equal 37250000000-pico tips: raw = capped = 149000000000.
    await seedItemsAndTips(37_250_000_000n)
    await seedInflow(65_000_000_000n)

    const distribution = await run()

    // The run completes: the documented fallback contract, exactly like any
    // other planning failure — nothing clamped, nothing fabricated.
    expect(distribution.curatorBudgetMode).toBe('LEGACY')
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(CAP)
    expect(distribution.distributedPiconeros).toBe(CAP)
    expect(distribution.trustedTipPiconeros).toBeNull()
    expect(distribution.dynamicBudgetPiconeros).toBeNull()
    expect(distribution.dynamicBudgetMode).toBeNull()
    expect(distribution.multBps).toBeNull()
    expect(distribution.curatorBudgetParams.errors).toEqual(['planning_failed'])
    // The typed planning error reached the sanitized worker diagnostic.
    const planningLog = logError.mock.calls.find(([, message]) =>
      message === 'rewardsDistributor: dynamic curator budget planning failed; paying the fallback cap')
    expect(planningLog).toBeDefined()
    expect(planningLog[0].phase).toBe('curator-budget')
    expect(planningLog[0].err.name).toBe('CuratorBudgetOverflowError')
    expect(planningLog[0].err.message).toContain('79821428580000')
    // Exactly one post-commit CRITICAL alert, and its body stays sanitized:
    // fixed text only, never the oversized value or the error message.
    const fallbackAlerts = alert.mock.calls.filter(([, , , opts = {}]) =>
      opts.dedupeKey === `curator-budget-fallback-${distribution.id}`)
    expect(fallbackAlerts).toHaveLength(1)
    expect(fallbackAlerts[0][0]).toBe('critical')
    expect(fallbackAlerts[0][2]).not.toContain('79821428580000')
    expect(fallbackAlerts[0][2]).toContain('Diagnostic withheld')
    // The tripped breaker state died with the rolled-back plan: no breaker alert.
    expect(alert.mock.calls.filter(([, , , opts = {}]) =>
      opts.dedupeKey?.startsWith('curator-breaker-'))).toHaveLength(0)
    await expectConserved(distribution)
  })

  test('an effective multiple exactly at the int4 boundary is recorded normally', async () => {
    // Guard-scope pin (review I1): the boundary itself must still record.
    // Prior T [4000, 4000, 4000, 4000] pico with the latest row tripped
    // (raw 3149624684, capped 4000) and approved; the current raw T 12000
    // trips again (threshold 4000 x 2.5 = 10000) and is capped to 10000, so
    // T4 = (10000 + 4000 + 4000 + 4000) / 4 = 5500 and the make-up
    // (3149624684 - 4000) x 15000 / 40000 = 1181107756 lifts the target to
    // 8250 + 1181107756 = 1181116006 < limit (FULL). The effective multiple
    // floor(1181116006 x 10000 / 5500) = 2147483647 is exactly int4 max and
    // must be recorded verbatim, not rejected.
    await setConfig({ curatorBudgetMode: 'ACTIVE', distributionMinPayoutPiconeros: 1n })
    await seedHistory({
      t: 4000n,
      income: 65_000_000_000n,
      tripped: true,
      rawT: 3_149_624_684n,
      cappedT: 4000n,
      approved: true,
      lastRollover: 99_000_000_000_000n
    })
    // Four equal 3000-pico tips: raw = capped = 12000 > threshold 10000.
    await seedItemsAndTips(3000n)
    await seedInflow(65_000_000_000n)

    const distribution = await run()

    expect(distribution.curatorBudgetMode).toBe('ACTIVE')
    expect(distribution.breakerTripped).toBe(true)
    expect(distribution.trustedTipPiconeros).toBe(10_000n)
    expect(distribution.makeupPiconeros).toBe(1_181_107_756n)
    expect(distribution.tipT4Piconeros).toBe(5500n)
    expect(distribution.dynamicBudgetMode).toBe('FULL')
    expect(distribution.dynamicBudgetPiconeros).toBe(1_181_116_006n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(1_181_116_006n)
    expect(distribution.multBps).toBe(2_147_483_647)
    // A normal ACTIVE plan, not the fallback: the guard is not over-broad.
    expect(distribution.curatorBudgetParams.errors).toBeUndefined()
    expect(alert.mock.calls.some(([, , , opts = {}]) =>
      opts.dedupeKey?.startsWith('curator-budget-fallback-'))).toBe(false)
    await expectConserved(distribution)
  })

  test('a valid zero-history trip with a NULL effective multiple is approved at the configured k', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    // All-zero tip history makes the trip week's effective multBps NULL
    // (T4 = 0). The make-up is sized at the CONFIGURED k, so the NULL
    // effective multiple must neither refuse approval nor zero the estimate.
    const tripped = await seedHistory({
      t: 0n,
      tripped: true,
      rawT: 447n * XMR / 1000n,
      cappedT: 3725n * XMR / 10000n,
      multBps: null
    })

    const dry = await approveCuratorMakeup(db, tripped.id, { confirm: false })
    expect(dry.refused).toBeUndefined()
    expect(dry.multBps).toBeNull()
    expect(dry.configuredMultBps).toBe(15000)
    // (0.447 − 0.3725) × 15000 ÷ 40000 = 0.0279375 XMR, not 0.
    expect(dry.makeupPiconeros).toBe(27_937_500_000n)
    expect((await db.rewardDistribution.findUnique({ where: { id: tripped.id } })).breakerMakeupApproved).toBe(false)

    const approval = await approveCuratorMakeup(db, tripped.id, { confirm: true })
    expect(approval.approved).toBe(true)
    expect((await db.rewardDistribution.findUnique({ where: { id: tripped.id } })).breakerMakeupApproved).toBe(true)
  })

  test('the estimate follows the current configured k, not the row\'s effective multiple', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', curatorBudgetMultBps: 20000 })
    // The tripped row was limit-bound: its recorded EFFECTIVE multiple (9917)
    // differs from the current configured k (20000). The dry-run estimate
    // must use k — the paying run re-reads its own config.
    const tripped = await seedHistory({
      tripped: true,
      rawT: 3n * XMR,
      cappedT: 25n * XMR / 10n,
      multBps: 9917
    })

    const dry = await approveCuratorMakeup(db, tripped.id, { confirm: false })
    expect(dry.multBps).toBe(9917)
    expect(dry.configuredMultBps).toBe(20000)
    // (3 − 2.5) × 20000 ÷ 40000 = 0.25 XMR (9917 would give 0.1239625).
    expect(dry.makeupPiconeros).toBe(250_000_000_000n)
    expect((await db.rewardDistribution.findUnique({ where: { id: tripped.id } })).breakerMakeupApproved).toBe(false)
  })

  test('the make-up tool refuses on an invalid configured k without writing', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', curatorBudgetMultBps: 9999 })
    const tripped = await seedHistory({ tripped: true, rawT: 3n * XMR, cappedT: 25n * XMR / 10n })

    const refusal = await approveCuratorMakeup(db, tripped.id, { confirm: true })

    expect(refusal.refused).toBe('invalid_curator_budget_config')
    expect(refusal.configErrors).toContain('multBps_below_minimum')
    expect(refusal.makeupPiconeros).toBeUndefined()
    expect((await db.rewardDistribution.findUnique({ where: { id: tripped.id } })).breakerMakeupApproved).toBe(false)
  })

  test('the make-up tool refuses a row that is no longer the latest distribution', async () => {
    const tripped = await seedHistory({ count: 2, tripped: true, rawT: 3n * XMR, cappedT: 25n * XMR / 10n })
    const later = await db.rewardDistribution.create({
      data: {
        periodStart: tripped.periodEnd,
        periodEnd: new Date(tripped.periodEnd.getTime() + 7 * DAY),
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        status: 'COMPLETE',
        trustedTipPiconeros: XMR,
        incomePiconeros: XMR
      }
    })
    created.distributions.push(later.id)

    const refusal = await approveCuratorMakeup(db, tripped.id, { confirm: true })

    expect(refusal.refused).toBe('not_latest')
    expect((await db.rewardDistribution.findUnique({ where: { id: tripped.id } })).breakerMakeupApproved).toBe(false)
  })

  test('the make-up tool refuses an approved row and a non-tripped row', async () => {
    const approved = await seedHistory({
      count: 1,
      tripped: true,
      rawT: 3n * XMR,
      cappedT: 25n * XMR / 10n,
      approved: true
    })
    expect((await approveCuratorMakeup(db, approved.id, { confirm: true })).refused).toBe('already_approved')

    const normal = await seedHistory({ count: 1 })
    expect((await approveCuratorMakeup(db, normal.id, { confirm: true })).refused).toBe('not_tripped')

    const malformed = await db.rewardDistribution.create({
      data: {
        periodStart: normal.periodEnd,
        periodEnd: START,
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        status: 'COMPLETE',
        breakerTripped: true,
        breakerRawTPiconeros: 3n * XMR,
        multBps: 15000
      }
    })
    created.distributions.push(malformed.id)
    expect((await approveCuratorMakeup(db, malformed.id, { confirm: true })).refused).toBe('missing_breaker_data')
  })

  test('stale trust reuses the previous recorded T while still recording computed stages', async () => {
    await setConfig({ curatorTrustWeightFloor: 0.5 })
    await seedHistory({ t: 1_234_000_000_000n })
    await seedItemsAndTips()
    await seedInflow(XMR)
    await seedTrustHeartbeat(new Date(START.getTime() - 30 * 60 * 60 * 1000))

    const distribution = await run()

    expect(distribution.trustedTipPiconeros).toBe(1_234_000_000_000n)
    expect(distribution.eligibleTipStages).toMatchObject({
      capped: XMR.toString(),
      final: '1234000000000',
      staleTrustFallback: true
    })
    expect(distribution.rawTipPiconeros).toBe(XMR)
    await expectConserved(distribution)
  })

  test('at floor 1.0 a stale heartbeat computes T normally', async () => {
    await setConfig({ curatorTrustWeightFloor: 1.0 })
    await seedHistory({ t: 1_234_000_000_000n })
    await seedItemsAndTips()
    await seedInflow(XMR)
    await seedTrustHeartbeat(new Date(START.getTime() - 30 * 60 * 60 * 1000))

    const distribution = await run()

    expect(distribution.trustedTipPiconeros).toBe(XMR)
    expect(distribution.eligibleTipStages.staleTrustFallback).toBe(false)
    await expectConserved(distribution)
  })

  test('invalid config fails closed to LEGACY, pays the cap and raises a critical alert', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE', curatorBudgetDrawdownWeeks: 3 })
    await seedHistory()
    await seedItemsAndTips()
    await seedInflow(XMR)

    const distribution = await run()

    expect(distribution.curatorBudgetMode).toBe('LEGACY')
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(CAP)
    expect(distribution.distributedPiconeros).toBe(CAP)
    expect(distribution.trustedTipPiconeros).toBeNull()
    expect(distribution.dynamicBudgetPiconeros).toBeNull()
    expect(distribution.curatorBudgetParams.errors).toContain('drawdownWeeks_out_of_range')
    expect(distribution.curatorBudgetParams.configured.drawdownWeeks).toBe(3)
    expect(alert).toHaveBeenCalledWith(
      'critical',
      expect.stringContaining('config'),
      expect.any(String),
      expect.objectContaining({ dedupeKey: 'curator-budget-config-invalid' })
    )
    await expectConserved(distribution)
  })

  test.each([
    ['a plain planning error', async () => { throw new Error('injected planning failure') }],
    ['a real SQL error inside the planner savepoint', async tx => { await tx.$executeRaw`SELECT 1/0` }]
  ])('%s falls back and still commits', async (_label, failure) => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedHistory()
    await seedItemsAndTips()
    await seedInflow(XMR)
    computeEligibleTipVolume.mockImplementationOnce(failure)

    const distribution = await run()

    expect(distribution.curatorBudgetMode).toBe('LEGACY')
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(CAP)
    expect(distribution.distributedPiconeros).toBe(CAP)
    expect(distribution.curatorBudgetParams.errors).toEqual(['planning_failed'])
    const planningLog = logError.mock.calls.find(([, message]) =>
      message === 'rewardsDistributor: dynamic curator budget planning failed; paying the fallback cap')
    expect(planningLog).toBeDefined()
    expect(planningLog[0]).toMatchObject({
      phase: 'curator-budget',
      code: expect.any(String),
      err: {
        name: expect.any(String),
        code: expect.any(String),
        message: expect.any(String)
      }
    })
    if (_label === 'a plain planning error') {
      expect(planningLog[0].code).toBe('unknown')
      expect(planningLog[0].err.message).toContain('injected planning failure')
    } else {
      expect(planningLog[0].err.code).toBe('P2010')
      expect(planningLog[0].err.metaCode).toBe('22012')
      expect(planningLog[0].err.message).toContain('division by zero')
    }
    expect(alert).toHaveBeenCalledWith(
      'critical',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ dedupeKey: `curator-budget-fallback-${distribution.id}` })
    )
    await expectConserved(distribution)
  })

  test('planning-failure diagnostics are logged but credential-shaped text is redacted', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedHistory()
    await seedItemsAndTips()
    await seedInflow(XMR)
    const secret = 'supersecret'
    computeEligibleTipVolume.mockImplementationOnce(async () => {
      throw new Error(
        `connect postgresql://sn:${secret}@db:5432/stackernews password=hunter2 token: abc123 ` +
        'private_key="c2VjcmV0LWtleQ=="'
      )
    })

    const distribution = await run()

    const planningLog = logError.mock.calls.find(([, message]) =>
      message === 'rewardsDistributor: dynamic curator budget planning failed; paying the fallback cap')
    expect(planningLog).toBeDefined()
    const diagnostic = planningLog[0].err
    expect(diagnostic.message).toContain('postgresql://[redacted]@db:5432/stackernews')
    expect(diagnostic.message).toContain('password=[redacted]')
    expect(diagnostic.message).toContain('token: [redacted]')
    expect(diagnostic.message).toContain('private_key="[redacted]"')
    const serializedLog = JSON.stringify(planningLog[0])
    expect(serializedLog).not.toContain(secret)
    expect(serializedLog).not.toContain('hunter2')
    expect(serializedLog).not.toContain('abc123')
    expect(serializedLog).not.toContain('c2VjcmV0LWtleQ==')
    // The alert stays sanitized: no error text or credentials in the body.
    const fallbackAlert = alert.mock.calls.find(([, , , opts = {}]) =>
      opts.dedupeKey === `curator-budget-fallback-${distribution.id}`)
    expect(fallbackAlert).toBeDefined()
    expect(fallbackAlert[2]).not.toContain(secret)
    expect(fallbackAlert[2]).not.toContain('hunter2')
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(CAP)
    await expectConserved(distribution)
  })

  test.each([
    ['P2034 write conflict', { code: 'P2034' }],
    ['40001 serialization failure', { code: 'P2010', meta: { code: '40001' } }],
    ['40P01 deadlock', { code: 'P2010', meta: { code: '40P01' } }]
  ])('%s escapes the savepoint and aborts the run', async (_label, error) => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedHistory()
    await seedItemsAndTips()
    await seedInflow(XMR)
    computeEligibleTipVolume.mockImplementationOnce(async () => { throw error })

    await expect(run()).rejects.toMatchObject({ code: error.code })
    expect(await runWeekCount()).toBe(0)
    expect(alert.mock.calls.some(([, , , opts = {}]) =>
      opts.dedupeKey?.startsWith('curator-budget-fallback-'))).toBe(false)
  })

  test('a same-week rerun reuses the row and does not re-alert', async () => {
    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    await seedHistory()
    await seedItemsAndTips(3n * XMR / 4n)
    await seedInflow(XMR)

    const first = await run()
    expect(alert.mock.calls.some(([, , , opts = {}]) =>
      opts.dedupeKey === `curator-breaker-${first.id}`)).toBe(true)
    const payoutIds = first.payouts.map(p => p.id).sort((a, b) => a - b)
    alert.mockClear()

    const again = await run()

    expect(again.id).toBe(first.id)
    expect(again.payouts.map(p => p.id).sort((a, b) => a - b)).toEqual(payoutIds)
    expect(alert).not.toHaveBeenCalled()
    expect(await runWeekCount()).toBe(1)
    await expectConserved(again)
  })
})
