/* eslint-env jest */

import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { runDistributionOnce } from '@/worker/rewardsDistributor'
import { getNextRewardsPool } from '@/lib/rewardsPool'

// Real allocation/SQL/ledger integration, fake signer only. Never run these
// multiweek fixtures against a shared dev pool or a real rewards wallet.
// Run against a migrated, dedicated stasher_rewards_cap_test (or the existing
// stasher_rewards_repair_test) database:
//   DATABASE_URL=<isolated-db-url> npm test -- --runTestsByPath test/worker/rewardsDistributor.cap.test.js
const ISOLATED_DB = (() => {
  try { return ['/stasher_rewards_cap_test', '/stasher_rewards_repair_test'].includes(new URL(process.env.DATABASE_URL).pathname) } catch { return false }
})()

jest.mock('../../lib/alert', () => ({ alert: jest.fn() }))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn() },
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

const XMR = 1_000_000_000_000n
const CAP = 600_000_000_000n // 0.6 XMR weekly curator cap
const DAY = 24 * 60 * 60 * 1000
const START = new Date('2026-10-19T00:00:00Z')

;(ISOLATED_DB ? describe : describe.skip)('weekly curator cap (isolated DB, no on-chain sends)', () => {
  const db = new PrismaClient()
  const created = { users: [], accounts: [], items: [], distributions: [] }
  const savedEnv = {}
  let savedConfig
  let authorId, curatorId, recipient

  beforeAll(async () => {
    for (const key of ['MONERO_NETWORK', 'PLATFORM_REWARDS_ADDRESS']) savedEnv[key] = process.env[key]
    process.env.MONERO_NETWORK = 'stagenet'
    process.env.PLATFORM_REWARDS_ADDRESS = '5' + '7'.repeat(94)
    savedConfig = await db.platformFeeConfig.findUnique({ where: { id: 1 } })
    const config = { curatorTrustWeightFloor: 1.0, distributionTopN: 10, distributionMinPayoutPiconeros: 1_000_000_000n }
    await db.platformFeeConfig.upsert({ where: { id: 1 }, update: config, create: { id: 1, ...config } })
  })

  beforeEach(async () => {
    // Freeze only the clock, not Prisma's IO or transaction timeout timers.
    jest.useFakeTimers({
      now: START,
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']
    })
    expect(await db.rewardDistribution.count()).toBe(0)
    await db.platformFeeConfig.update({ where: { id: 1 }, data: { distributionTopN: 10, distributionMinPayoutPiconeros: 1_000_000_000n } })
    authorId = await createUser()
    curatorId = await createUser()
    recipient = await createAccount(null, 'author')
    await createAccount(null, 'platform_rewards', process.env.PLATFORM_REWARDS_ADDRESS)
    await createAccount(curatorId, 'curator-payout')
    await seedCuration()
  })

  afterEach(async () => {
    await db.earn.deleteMany({ where: { distributionId: { in: created.distributions } } })
    await db.rewardPayout.deleteMany({ where: { distributionId: { in: created.distributions } } })
    await db.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
    await db.feeObservation.deleteMany({ where: { txHash: { startsWith: 'cap-fee-' } } })
    await db.observedTip.deleteMany({ where: { postId: { in: created.items } } })
    await db.item.deleteMany({ where: { id: { in: created.items } } })
    await db.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
    await db.user.deleteMany({ where: { id: { in: created.users } } })
    for (const ids of Object.values(created)) ids.length = 0
    jest.useRealTimers()
  })

  afterAll(async () => {
    if (savedConfig) {
      const { curatorTrustWeightFloor, distributionTopN, distributionMinPayoutPiconeros } = savedConfig
      await db.platformFeeConfig.update({ where: { id: 1 }, data: { curatorTrustWeightFloor, distributionTopN, distributionMinPayoutPiconeros } })
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await db.$disconnect()
  })

  async function createUser () {
    const user = await db.user.create({ data: {} })
    created.users.push(user.id)
    return user.id
  }

  async function createAccount (ownerUserId, label, address = '5' + randomBytes(47).toString('hex')) {
    const account = await db.moneroAccount.create({ data: { ownerUserId, label, address, network: 'STAGENET', status: 'ACTIVE' } })
    created.accounts.push(account.id)
    return account
  }

  async function seedCuration (tipperId = curatorId, createdAt = new Date(Date.now() - DAY)) {
    const [item] = await db.$queryRaw`
      INSERT INTO "Item" ("userId", title, "weightedVotes", created_at)
      VALUES (${authorId}::int, 'cap test post', 10, ${createdAt}) RETURNING id::int`
    created.items.push(item.id)
    await db.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
    await db.observedTip.create({
      data: {
        postId: item.id,
        tipperId,
        recipientAccountId: recipient.id,
        paymentId: randomBytes(8).toString('hex'),
        txHash: randomBytes(32).toString('hex'),
        piconeros: 2_000_000_000n,
        state: 'CONFIRMED',
        confirmedAt: createdAt
      }
    })
  }

  async function seedInflow (piconeros, donationRewardsPct = 100) {
    await db.feeObservation.create({
      data: {
        feeType: 'DONATE',
        txHash: 'cap-fee-' + randomBytes(16).toString('hex'),
        recipientMajor: 3,
        recipientMinor: 1,
        piconeros,
        donationRewardsPct,
        state: 'CONFIRMED',
        confirmedAt: new Date(Date.now() - 60 * 60 * 1000)
      }
    })
  }

  async function attachReferrer () {
    const referrerId = await createUser()
    await createAccount(referrerId, 'referrer-payout')
    await db.user.update({ where: { id: curatorId }, data: { referrerId } })
    return referrerId
  }

  async function fakeSigner (payouts) {
    await db.rewardPayout.updateMany({ where: { id: { in: payouts.map(p => p.id) }, state: 'QUEUED' }, data: { state: 'SENT', txHash: 'ab'.repeat(32) } })
    return { sent: payouts.length, skipped: 0, failed: 0 }
  }

  async function run (sendPayouts = fakeSigner) {
    const distribution = await runDistributionOnce({ models: db, sendPayouts, scheduleOpsSweep: false })
    if (!created.distributions.includes(distribution.id)) created.distributions.push(distribution.id)
    return distribution
  }

  // Test-only client wrapper that holds both allocation transactions after
  // their first guard read. Without a barrier, two concurrent promises may
  // serialize naturally and prove nothing about the overlapping-read race.
  function overlapModels (onGuardRead) {
    const wrapTx = tx => {
      const rewardDistribution = new Proxy(tx.rewardDistribution, {
        get (target, prop) {
          const value = Reflect.get(target, prop)
          if (prop === 'findFirst') {
            return async args => {
              const found = await target.findFirst(args)
              // Only the idempotency lookup carries a periodEnd lower bound.
              if (args?.where?.periodEnd?.gte) await onGuardRead()
              return found
            }
          }
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      return new Proxy(tx, {
        get (target, prop) {
          if (prop === 'rewardDistribution') return rewardDistribution
          const value = Reflect.get(target, prop)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
    return new Proxy(db, {
      get (target, prop) {
        if (prop === '$transaction') {
          return (fn, opts) => target.$transaction(tx => fn(wrapTx(tx)), opts)
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }

  async function expectConserved (distribution) {
    const earns = await db.earn.aggregate({ where: { distributionId: distribution.id }, _sum: { piconeros: true } })
    expect(earns._sum.piconeros ?? 0n).toBe(distribution.distributedPiconeros)
    expect(distribution.payouts.reduce((sum, p) => sum + p.piconeros, 0n)).toBe(distribution.distributedPiconeros)
    expect(distribution.distributedPiconeros + distribution.rolledOverPiconeros).toBe(distribution.poolPiconeros)
  }

  test.each([
    ['empty', 0n, 0n, 0n],
    ['below cap', 500_000_000_000n, 500_000_000_000n, 0n],
    ['at cap', CAP, CAP, 0n],
    ['one piconero above cap', CAP + 1n, CAP, 1n],
    ['five XMR', 5n * XMR, CAP, 5n * XMR - CAP]
  ])('%s: caps curator payouts without discarding reserve', async (_name, pool, paid, rollover) => {
    if (pool > 0n) await seedInflow(pool)
    const distribution = await run()
    expect(distribution.poolPiconeros).toBe(pool)
    expect(distribution.distributedPiconeros).toBe(paid)
    expect(distribution.rolledOverPiconeros).toBe(rollover)
    expect(distribution.status).toBe('COMPLETE')
    await expectConserved(distribution)
  })

  test('five XMR funds eight full capped weeks plus one partial week with no new inflow', async () => {
    await seedInflow(5n * XMR)
    for (let week = 0; week < 9; week++) {
      if (week > 0) {
        jest.setSystemTime(new Date(START.getTime() + week * 7 * DAY))
        await seedCuration()
      }
      const distribution = await run()
      expect(distribution.poolPiconeros).toBe(5n * XMR - BigInt(week) * CAP)
      if (week < 8) {
        expect(distribution.distributedPiconeros).toBe(CAP)
        expect(distribution.rolledOverPiconeros).toBe(5n * XMR - BigInt(week + 1) * CAP)
      } else {
        // final week: the remaining 0.2 XMR is below the cap and pays in full
        expect(distribution.distributedPiconeros).toBe(5n * XMR - 8n * CAP)
        expect(distribution.rolledOverPiconeros).toBe(0n)
      }
      await expectConserved(distribution)
    }
  })

  test('the cap is shared across curators, not applied to each curator separately', async () => {
    const otherCuratorId = await createUser()
    await createAccount(otherCuratorId, 'curator-payout')
    await seedCuration(otherCuratorId)
    await seedInflow(5n * XMR)
    const distribution = await run()
    expect(distribution.payouts).toHaveLength(2)
    expect(distribution.payouts.map(p => p.piconeros)).toEqual([CAP / 2n, CAP / 2n])
    expect(distribution.rolledOverPiconeros).toBe(5n * XMR - CAP)
    await expectConserved(distribution)
  })

  test.each(['no eligible curators', 'below minimum payout', 'top-N excludes all'])('%s: carries the entire pool forward', async reason => {
    if (reason === 'no eligible curators') await db.observedTip.deleteMany({ where: { postId: { in: created.items } } })
    if (reason === 'below minimum payout') await db.platformFeeConfig.update({ where: { id: 1 }, data: { distributionMinPayoutPiconeros: CAP + 1n } })
    if (reason === 'top-N excludes all') await db.platformFeeConfig.update({ where: { id: 1 }, data: { distributionTopN: 0 } })
    await seedInflow(5n * XMR)
    const distribution = await run()
    expect(distribution.payouts).toHaveLength(0)
    expect(distribution.rolledOverPiconeros).toBe(5n * XMR)
    await expectConserved(distribution)
  })

  test('adds new inflow to the full carry while retaining the weekly curator cap', async () => {
    await seedInflow(5n * XMR)
    await run()
    jest.setSystemTime(new Date(START.getTime() + 7 * DAY))
    await seedCuration()
    await seedInflow(2n * XMR)
    const distribution = await run()
    expect(distribution.poolPiconeros).toBe(5n * XMR - CAP + 2n * XMR)
    expect(distribution.distributedPiconeros).toBe(CAP)
    expect(distribution.rolledOverPiconeros).toBe(5n * XMR + 2n * XMR - 2n * CAP)
    await expectConserved(distribution)
  })

  test.each([
    ['additional referrals', 5n * XMR, CAP / 10n, 5n * XMR - CAP - CAP / 10n],
    ['limited by remaining pool', CAP + 50_000_000_000n, 50_000_000_000n, 0n],
    ['no remaining pool', CAP, 0n, 0n]
  ])('%s: referrals use the full pool remainder, not the curator cap remainder', async (_name, pool, referral, rollover) => {
    const referrerId = await attachReferrer()
    await seedInflow(pool)
    const distribution = await run()
    expect(distribution.payouts.find(p => p.curatorId === curatorId).piconeros).toBe(CAP)
    expect(distribution.payouts.find(p => p.curatorId === referrerId)?.piconeros ?? 0n).toBe(referral)
    expect(distribution.distributedPiconeros).toBe(CAP + referral)
    expect(distribution.rolledOverPiconeros).toBe(rollover)
    const earns = await db.earn.findMany({ where: { distributionId: distribution.id, type: 'FOREVER_REFERRAL' } })
    expect(earns.reduce((sum, e) => sum + e.piconeros, 0n)).toBe(referral)
    await expectConserved(distribution)
  })

  test('retains the entire pool when the curator has no payout address, including their unpaid referral', async () => {
    await attachReferrer()
    await db.moneroAccount.deleteMany({ where: { ownerUserId: curatorId } })
    await seedInflow(5n * XMR)
    const distribution = await run()
    expect(distribution.distributedPiconeros).toBe(0n)
    expect(distribution.rolledOverPiconeros).toBe(5n * XMR)
    expect(distribution.payouts).toHaveLength(0)
    await expectConserved(distribution)
  })

  test('an address-less referrer receives nothing and their share stays in rollover', async () => {
    const referrerId = await attachReferrer()
    await db.moneroAccount.deleteMany({ where: { ownerUserId: referrerId } })
    await seedInflow(5n * XMR)
    const distribution = await run()
    expect(distribution.payouts).toHaveLength(1)
    expect(distribution.distributedPiconeros).toBe(CAP)
    expect(distribution.rolledOverPiconeros).toBe(5n * XMR - CAP)
    await expectConserved(distribution)
  })

  test('resuming an existing pre-cap distribution preserves its committed payouts even above the cap', async () => {
    const legacy = await db.rewardDistribution.create({
      data: {
        periodStart: new Date(START.getTime() - 7 * DAY),
        periodEnd: START,
        poolPiconeros: 5n * XMR,
        distributedPiconeros: 5n * XMR,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'FAILED'
      }
    })
    created.distributions.push(legacy.id)
    const account = await db.moneroAccount.findFirst({ where: { ownerUserId: curatorId } })
    await db.rewardPayout.create({ data: { distributionId: legacy.id, curatorId, recipientAddress: account.address, piconeros: 5n * XMR } })
    await db.earn.create({ data: { distributionId: legacy.id, userId: curatorId, type: 'TIP_POST', piconeros: 5n * XMR } })
    const distribution = await run()
    expect(distribution.id).toBe(legacy.id)
    expect(distribution.status).toBe('COMPLETE')
    expect(distribution.distributedPiconeros).toBe(5n * XMR)
    expect(distribution.payouts[0].piconeros).toBe(5n * XMR)
    expect(await db.rewardDistribution.count()).toBe(1)
    await expectConserved(distribution)
  })

  test('same-week retries reuse the capped payout and Earn contracts without another allocation', async () => {
    await attachReferrer()
    await seedInflow(5n * XMR)
    const failed = await run(async () => { throw new Error('injected pre-send failure') })
    expect(failed.status).toBe('FAILED')
    expect(failed.distributedPiconeros).toBe(CAP + CAP / 10n)
    const retried = await run()
    const again = await run(async () => { throw new Error('must not send twice') })
    expect(retried.id).toBe(failed.id)
    expect(again.id).toBe(failed.id)
    expect(again.status).toBe('COMPLETE')
    expect(again.rolledOverPiconeros).toBe(5n * XMR - CAP - CAP / 10n)
    expect(await db.rewardDistribution.count()).toBe(1)
    expect(await db.earn.count({ where: { distributionId: again.id } })).toBe(2)
    await expectConserved(again)
  })

  test.each([
    ['Monday 02:00', 2 * 60 * 60 * 1000],
    ['Tuesday', DAY],
    ['Sunday 23:00', 6 * DAY + 23 * 60 * 60 * 1000]
  ])('late creation on %s does not block next Monday', async (_label, delay) => {
    // A prior allocation created after Monday's scheduled run must only consume
    // the UTC week it was actually created in. Under the old rolling seven-day
    // guard, any creation >1h late suppressed the following Monday.
    jest.setSystemTime(new Date(START.getTime() + delay))
    await seedCuration()
    await seedInflow(5n * XMR)
    const previous = await run()

    jest.setSystemTime(new Date(START.getTime() + 7 * DAY))
    await seedCuration(curatorId, new Date(START.getTime() + 7 * DAY - 30 * 60 * 1000))
    const next = await run()

    expect(next.id).not.toBe(previous.id)
    expect(next.periodStart).toEqual(previous.periodEnd)
    expect(next.poolPiconeros).toBe(4_400_000_000_000n)
    expect(next.distributedPiconeros).toBe(600_000_000_000n)
    expect(next.rolledOverPiconeros).toBe(3_800_000_000_000n)
    await expectConserved(next)
  })

  test('a rerun at the end of the same UTC week still reuses the allocation', async () => {
    // The old grace window only skipped reruns for 6d23h after the allocation;
    // a Sunday 23:59:59.999 rerun could allocate a second time. Calendar weeks
    // must cover the whole week.
    await seedInflow(5n * XMR)
    const first = await run()
    const payoutIds = first.payouts.map(p => p.id).sort((a, b) => a - b)
    const earnCount = await db.earn.count({ where: { distributionId: first.id } })

    jest.setSystemTime(new Date(START.getTime() + 7 * DAY - 1))
    const again = await run()

    expect(again.id).toBe(first.id)
    expect(again.payouts.map(p => p.id).sort((a, b) => a - b)).toEqual(payoutIds)
    expect(await db.earn.count({ where: { distributionId: first.id } })).toBe(earnCount)
    expect(await db.rewardDistribution.count()).toBe(1)
  })

  test('an exactly-Monday 00:00 UTC allocation is reused later that week', async () => {
    await seedInflow(5n * XMR)
    const first = await run()
    jest.setSystemTime(new Date(START.getTime() + 3 * DAY))
    const again = await run()
    expect(again.id).toBe(first.id)
    expect(await db.rewardDistribution.count()).toBe(1)
  })

  test.each([
    ['2026-10-18T23:59:59.999Z', '2026-10-19T00:00:00.000Z'],
    ['2026-11-01T23:59:59.999Z', '2026-11-02T00:00:00.000Z'],
    ['2027-01-03T23:59:59.999Z', '2027-01-04T00:00:00.000Z']
  ])('a Sunday allocation ending at %s does not block the next Monday (%s)', async (sundayIso, mondayIso) => {
    // Boundary pair, including a UTC month/year rollover. The seed timestamp
    // equals the previous periodEnd, which is the inclusive start of the
    // 1ms-wide next inflow window.
    jest.setSystemTime(new Date(sundayIso))
    const previous = await run()
    await seedCuration(curatorId, previous.periodEnd)

    jest.setSystemTime(new Date(mondayIso))
    const next = await run()

    expect(next.id).not.toBe(previous.id)
    expect(next.periodStart).toEqual(previous.periodEnd)
  })

  test('a Wednesday allocation is reused on Friday of the same UTC week', async () => {
    jest.setSystemTime(new Date(START.getTime() + 2 * DAY))
    const first = await run()
    jest.setSystemTime(new Date(START.getTime() + 4 * DAY))
    const again = await run()
    expect(again.id).toBe(first.id)
    expect(await db.rewardDistribution.count()).toBe(1)
  })

  test('a same-week PENDING distribution is completed and reuses its committed payouts', async () => {
    const distribution = await db.rewardDistribution.create({
      data: {
        periodStart: new Date(START.getTime() - 7 * DAY),
        periodEnd: new Date(START.getTime() + 60 * 60 * 1000),
        poolPiconeros: XMR,
        distributedPiconeros: XMR,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'PENDING'
      }
    })
    created.distributions.push(distribution.id)
    const account = await db.moneroAccount.findFirst({ where: { ownerUserId: curatorId } })
    await db.rewardPayout.create({
      data: { distributionId: distribution.id, curatorId, recipientAddress: account.address, piconeros: XMR }
    })
    await db.earn.create({
      data: { distributionId: distribution.id, userId: curatorId, type: 'TIP_POST', piconeros: XMR }
    })

    jest.setSystemTime(new Date(START.getTime() + 2 * 60 * 60 * 1000))
    const resumed = await run()
    expect(resumed.id).toBe(distribution.id)
    expect(resumed.status).toBe('COMPLETE')
    expect(resumed.payouts[0].state).toBe('SENT')
    expect(await db.rewardDistribution.count()).toBe(1)
    await expectConserved(resumed)
  })

  test('a same-week SENDING distribution is left untouched with no second sender', async () => {
    const distribution = await db.rewardDistribution.create({
      data: {
        periodStart: new Date(START.getTime() - 7 * DAY),
        periodEnd: new Date(START.getTime() + 60 * 60 * 1000),
        poolPiconeros: XMR,
        distributedPiconeros: XMR,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'SENDING',
        startedAt: new Date(START.getTime() - 5 * 60 * 1000)
      }
    })
    created.distributions.push(distribution.id)
    const account = await db.moneroAccount.findFirst({ where: { ownerUserId: curatorId } })
    const payout = await db.rewardPayout.create({
      data: { distributionId: distribution.id, curatorId, recipientAddress: account.address, piconeros: XMR, state: 'QUEUED' }
    })

    const signer = jest.fn()
    const resumed = await run(signer)
    expect(resumed.id).toBe(distribution.id)
    expect(resumed.status).toBe('SENDING')
    expect(signer).not.toHaveBeenCalled()
    expect((await db.rewardPayout.findUnique({ where: { id: payout.id } })).state).toBe('QUEUED')
  })

  test('a prior-week SENDING distribution defers the new allocation until it settles', async () => {
    // The old rolling guard incidentally skipped a new allocation while a prior
    // distribution was still signing. Preserve that wallet serialization across
    // the UTC boundary without blocking a completed late allocation.
    const inFlight = await db.rewardDistribution.create({
      data: {
        periodStart: new Date(START.getTime() - 7 * DAY),
        periodEnd: new Date(START.getTime() - 60 * 60 * 1000),
        poolPiconeros: XMR,
        distributedPiconeros: XMR,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'SENDING',
        startedAt: new Date(START.getTime() - 30 * 60 * 1000)
      }
    })
    created.distributions.push(inFlight.id)
    const account = await db.moneroAccount.findFirst({ where: { ownerUserId: curatorId } })
    const payout = await db.rewardPayout.create({
      data: { distributionId: inFlight.id, curatorId, recipientAddress: account.address, piconeros: XMR, state: 'QUEUED' }
    })

    const signer = jest.fn()
    const deferred = await run(signer)
    expect(deferred.id).toBe(inFlight.id)
    expect(deferred.status).toBe('SENDING')
    expect(signer).not.toHaveBeenCalled()
    expect(await db.rewardDistribution.count()).toBe(1)

    // The in-flight sender finishes; the next run allocates contiguously.
    await db.rewardDistribution.update({
      where: { id: inFlight.id },
      data: { status: 'COMPLETE', completedAt: new Date() }
    })
    await db.rewardPayout.update({
      where: { id: payout.id },
      data: { state: 'SENT', txHash: 'ab'.repeat(32) }
    })
    const next = await run()
    expect(next.id).not.toBe(inFlight.id)
    expect(next.periodStart).toEqual(inFlight.periodEnd)
    expect(next.status).toBe('COMPLETE')
    expect(await db.rewardDistribution.count()).toBe(2)
  })

  test('an on-time allocation completed on Tuesday does not block the following Monday', async () => {
    // Only creation timing assigns a week; completion timing must not move the
    // allocation boundary.
    const previous = await db.rewardDistribution.create({
      data: {
        periodStart: new Date(START.getTime() - 7 * DAY),
        periodEnd: START,
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        status: 'COMPLETE',
        completedAt: new Date(START.getTime() + DAY)
      }
    })
    created.distributions.push(previous.id)

    jest.setSystemTime(new Date(START.getTime() + 7 * DAY))
    const next = await run()
    expect(next.id).not.toBe(previous.id)
    expect(next.periodStart).toEqual(previous.periodEnd)
  })

  test('a several-weeks-old allocation gets exactly one new capped contract and contiguous inflow', async () => {
    const previous = await db.rewardDistribution.create({
      data: {
        periodStart: new Date(START.getTime() - 28 * DAY),
        periodEnd: new Date(START.getTime() - 21 * DAY),
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        status: 'COMPLETE'
      }
    })
    created.distributions.push(previous.id)

    await seedInflow(5n * XMR)
    const next = await run()
    expect(next.id).not.toBe(previous.id)
    expect(next.periodStart).toEqual(previous.periodEnd)
    expect(next.poolPiconeros).toBe(5n * XMR)
    expect(next.distributedPiconeros).toBe(CAP)
    expect(next.rolledOverPiconeros).toBe(4_400_000_000_000n)
    expect(await db.rewardDistribution.count()).toBe(2)
    await expectConserved(next)
  })

  test('a future-dated allocation conservatively blocks a new allocation', async () => {
    const future = await db.rewardDistribution.create({
      data: {
        periodStart: START,
        periodEnd: new Date(START.getTime() + 30 * DAY),
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        status: 'COMPLETE'
      }
    })
    created.distributions.push(future.id)

    const again = await run()
    expect(again.id).toBe(future.id)
    expect(await db.rewardDistribution.count()).toBe(1)
  })

  test('overlapping runs allocate exactly once and never double-send', async () => {
    await seedInflow(5n * XMR)

    let guardReads = 0
    let releaseBarrier
    const bothArrived = new Promise(resolve => { releaseBarrier = resolve })
    const gate = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('overlap barrier timed out')), 8000)
      bothArrived.then(() => { clearTimeout(timer); resolve() })
    })
    const onGuardRead = async () => {
      guardReads += 1
      if (guardReads >= 2) releaseBarrier()
      await gate
    }
    const overlappingModels = overlapModels(onGuardRead)
    const delivered = []
    const signer = async payouts => {
      delivered.push(...payouts.map(p => p.id))
      return await fakeSigner(payouts)
    }

    const results = await Promise.allSettled([
      runDistributionOnce({ models: overlappingModels, sendPayouts: signer, scheduleOpsSweep: false }),
      runDistributionOnce({ models: overlappingModels, sendPayouts: signer, scheduleOpsSweep: false })
    ])
    expect(guardReads).toBeGreaterThanOrEqual(2)
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // The losing Serializable transaction aborts cleanly; retries are the
    // caller's job, never an automatic second allocation here.
    expect(rejected[0].reason.code).toBe('P2034')
    if (!created.distributions.includes(fulfilled[0].value.id)) {
      created.distributions.push(fulfilled[0].value.id)
    }
    expect(await db.rewardDistribution.count()).toBe(1)

    // A same-week retry after the conflict reuses the winner's contract.
    const retried = await run()
    const latest = await db.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' } })
    expect(retried.id).toBe(latest.id)
    expect(await db.rewardDistribution.count()).toBe(1)
    expect(new Set(delivered).size).toBe(delivered.length)

    const payouts = await db.rewardPayout.findMany({ where: { distributionId: retried.id } })
    expect(delivered.sort((a, b) => a - b)).toEqual(payouts.map(p => p.id).sort((a, b) => a - b))
    await expectConserved(retried)
  }, 20000)

  test('leaves the full rollover protected and the separate ops allocation uncapped', async () => {
    await seedInflow(10n * XMR, 50)
    const distribution = await run()
    expect(distribution.opsInflowPiconeros).toBe(5n * XMR)
    expect(distribution.opsAvailablePiconeros).toBe(5n * XMR)
    const pool = await getNextRewardsPool(db)
    expect(pool.poolPiconeros).toBe(5n * XMR - CAP)
    expect(pool.pendingSweepPiconeros).toBe(5n * XMR)
    await expectConserved(distribution)
  })
})
