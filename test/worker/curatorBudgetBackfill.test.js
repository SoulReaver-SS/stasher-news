/* eslint-env jest */

import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { runDistributionOnce } from '@/worker/rewardsDistributor'
import { backfillCuratorBudgetHistory } from '@/worker/curatorBudget'
import { approveCuratorMakeup } from '../../scripts/approve-curator-makeup'

// Real SQL backfill integration. Runs only against a dedicated, migrated DB:
//   DATABASE_URL=postgresql://.../stasher_rewards_backfill_test npm test -- \
//     --runTestsByPath test/worker/curatorBudgetBackfill.test.js
// Never point this at the shared dev DB: it seeds distributions and tips.
const ISOLATED_DB = (() => {
  try {
    return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_backfill_test'
  } catch { return false }
})()

const XMR = 1_000_000_000_000n
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function startOfUtcWeek (date) {
  const start = new Date(date)
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
  return start
}

// Every column the backfill is allowed to touch (spec §9.1).
const WRITABLE_FIELDS = new Set([
  'rawTipPiconeros',
  'eligibleTipStages',
  'trustedTipPiconeros',
  'tipperCount',
  'breakerTripped',
  'breakerRawTPiconeros',
  'incomePiconeros',
  'curatorBudgetParams'
])

function snapshot (value) {
  return JSON.parse(JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item))
}

;(ISOLATED_DB ? describe : describe.skip)('curator budget history backfill (isolated DB)', () => {
  const db = new PrismaClient()
  const created = { users: [], accounts: [], items: [], distributions: [] }
  const savedEnv = {}
  let savedConfig
  let savedHealth
  let authorId
  let authorAccountId
  let curators

  beforeAll(async () => {
    for (const key of ['MONERO_NETWORK', 'PLATFORM_REWARDS_ADDRESS']) savedEnv[key] = process.env[key]
    process.env.MONERO_NETWORK = 'stagenet'
    process.env.PLATFORM_REWARDS_ADDRESS = '5' + '7'.repeat(94)
    await db.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
    savedConfig = await db.platformFeeConfig.findUnique({ where: { id: 1 } })
    savedHealth = await db.healthSnapshot.findUnique({ where: { id: 1 } })
  })

  beforeEach(async () => {
    expect(await db.rewardDistribution.count()).toBe(0)
    await setConfig()
    curators = []
    await seedBase()
  })

  afterEach(async () => {
    await db.earn.deleteMany({ where: { distributionId: { in: created.distributions } } })
    await db.rewardPayout.deleteMany({ where: { distributionId: { in: created.distributions } } })
    await db.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
    await db.observedTip.deleteMany({ where: { postId: { in: created.items } } })
    await db.feeObservation.deleteMany({ where: { txHash: { startsWith: 'dcb-bf-' } } })
    await db.item.deleteMany({ where: { id: { in: created.items } } })
    await db.userSubTrust.deleteMany({ where: { userId: { in: created.users } } })
    await db.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
    await db.user.updateMany({ where: { id: { in: created.users } }, data: { referrerId: null } })
    await db.user.deleteMany({ where: { id: { in: created.users } } })
    for (const ids of Object.values(created)) ids.length = 0
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
          downvoteRewardsPct: savedConfig.downvoteRewardsPct,
          territoryFeeRewardsPct: savedConfig.territoryFeeRewardsPct,
          boostRewardsPct: savedConfig.boostRewardsPct,
          walletlessTipRewardsPct: savedConfig.walletlessTipRewardsPct,
          distributionExcludedCuratorIds: savedConfig.distributionExcludedCuratorIds,
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
    if (savedHealth) {
      await db.healthSnapshot.upsert({
        where: { id: 1 },
        update: { trustCompletedAt: savedHealth.trustCompletedAt },
        create: { id: 1, trustCompletedAt: savedHealth.trustCompletedAt }
      })
    } else {
      await db.healthSnapshot.deleteMany({ where: { id: 1 } })
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
        downvoteRewardsPct: 100,
        territoryFeeRewardsPct: 100,
        boostRewardsPct: 100,
        walletlessTipRewardsPct: 100,
        distributionExcludedCuratorIds: [],
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
    const authorAccount = await createAccount(authorId, 'author')
    authorAccountId = authorAccount.id
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
      VALUES (${userId}::int, 'curator budget backfill test post', 10, ${createdAt}) RETURNING id::int`
    created.items.push(item.id)
    await db.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
    return item.id
  }

  async function seedTip (tipperId, postId, piconeros, confirmedAt) {
    await db.observedTip.create({
      data: {
        postId,
        tipperId,
        recipientAccountId: authorAccountId,
        paymentId: randomBytes(8).toString('hex'),
        txHash: randomBytes(32).toString('hex'),
        piconeros,
        state: 'CONFIRMED',
        confirmedAt
      }
    })
  }

  async function seedFee (piconeros, confirmedAt, { feeType = 'POSTING', donationRewardsPct = 100 } = {}) {
    await db.feeObservation.create({
      data: {
        feeType,
        txHash: 'dcb-bf-' + randomBytes(16).toString('hex'),
        recipientMajor: 3,
        recipientMinor: 1,
        piconeros,
        donationRewardsPct,
        state: 'CONFIRMED',
        walletReceipt: true,
        confirmedAt
      }
    })
  }

  // Four equal tippers keep the cap inactive (each is exactly 25% of the sum),
  // so the capped T is the round XMR total passed here.
  async function seedTipsForWindow (periodStart, totalT) {
    const tippedAt = new Date(periodStart.getTime() + 2 * 60 * 60 * 1000)
    const itemId = await createItem(authorId, new Date(tippedAt.getTime() - 60 * 60 * 1000))
    const each = totalT / BigInt(curators.length)
    for (const tipperId of curators) {
      await seedTip(tipperId, itemId, each, tippedAt)
    }
  }

  async function createDistribution ({
    periodEnd,
    poolPiconeros = 0n,
    rolledOverPiconeros = 0n,
    trustedTipPiconeros = null,
    incomePiconeros = null,
    status = 'COMPLETE',
    breakerTripped = false,
    breakerRawTPiconeros = null,
    breakerMakeupApproved = false
  }) {
    const row = await db.rewardDistribution.create({
      data: {
        periodStart: new Date(periodEnd.getTime() - WEEK_MS),
        periodEnd,
        poolPiconeros,
        distributedPiconeros: 0n,
        rolledOverPiconeros,
        payoutCount: 0,
        status,
        trustedTipPiconeros,
        incomePiconeros,
        breakerTripped,
        breakerRawTPiconeros,
        breakerMakeupApproved
      }
    })
    created.distributions.push(row.id)
    return row
  }

  // Builds a weekly series oldest -> newest. Each row's pool is its own
  // non-donation fee income + the PREVIOUS row's rollover + any donation, so
  // the backfill's derived earmark equals the seeded fee income.
  async function seedSeries ({
    newestPeriodEnd,
    tipVolumes,
    feeVolumes,
    donationVolumes = [],
    rollovers = []
  }) {
    const rows = []
    let previousRollover = 0n
    for (let i = 0; i < tipVolumes.length; i++) {
      const periodEnd = new Date(newestPeriodEnd.getTime() - (tipVolumes.length - 1 - i) * WEEK_MS)
      const periodStart = new Date(periodEnd.getTime() - WEEK_MS)
      const donation = donationVolumes[i] ?? 0n
      const rollover = rollovers[i] ?? 0n
      await seedTipsForWindow(periodStart, tipVolumes[i])
      if (feeVolumes[i] > 0n) {
        await seedFee(feeVolumes[i], new Date(periodStart.getTime() + 3 * 60 * 60 * 1000))
      }
      if (donation > 0n) {
        await seedFee(donation, new Date(periodStart.getTime() + 4 * 60 * 60 * 1000), { feeType: 'DONATE' })
      }
      const row = await createDistribution({
        periodEnd,
        poolPiconeros: previousRollover + feeVolumes[i] + donation,
        rolledOverPiconeros: rollover
      })
      rows.push(row)
      previousRollover = rollover
    }
    return rows
  }

  async function backfill (periods, dryRun) {
    return await db.$transaction(
      tx => backfillCuratorBudgetHistory(tx, { periods, dryRun }),
      { isolationLevel: 'Serializable', timeout: 60000 }
    )
  }

  async function allDistributionRows () {
    return await db.rewardDistribution.findMany({ orderBy: { id: 'asc' } })
  }

  test('dry run writes nothing and reports the computed series', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    const rows = await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR, 2n * XMR, 3n * XMR],
      feeVolumes: [XMR, XMR, XMR]
    })
    const before = snapshot(await allDistributionRows())

    const result = await backfill(3, true)

    expect(result.dryRun).toBe(true)
    expect(result.refused).toBeUndefined()
    expect(result.rows).toHaveLength(3)
    expect(result.rows.map(row => row.id)).toEqual(rows.map(row => row.id))
    expect(result.rows.map(row => row.finalTPiconeros)).toEqual([XMR, 2n * XMR, 3n * XMR])
    expect(result.rows.every(row => row.wrote === false)).toBe(true)
    expect(snapshot(await allDistributionRows())).toEqual(before)
  })

  test('dry run refuses when the config singleton is missing and creates nothing', async () => {
    await db.platformFeeConfig.delete({ where: { id: 1 } })
    try {
      await expect(backfill(3, true)).rejects.toThrow(/PlatformFeeConfig/)
      // the dry run must not have seeded the singleton it refused on
      expect(await db.platformFeeConfig.findUnique({ where: { id: 1 } })).toBeNull()
    } finally {
      // restore the singleton the rest of the suite and its cleanup expect
      await db.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
    }
  })

  test('dry run and confirm make identical sequential in-memory calculations', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR, 2n * XMR, 3n * XMR, 4n * XMR],
      feeVolumes: [XMR, 1n * XMR, 1n * XMR, 1n * XMR]
    })

    const dry = await backfill(4, true)
    const confirmed = await backfill(4, false)

    const comparable = result => ({
      rows: result.rows.map(({ wrote, ...row }) => row),
      tHistory: result.tHistory,
      fHistory: result.fHistory,
      openPeriod: {
        ...result.openPeriod,
        periodEnd: null
      }
    })
    expect(comparable(confirmed)).toEqual(comparable(dry))
    expect(confirmed.rows.every(row => row.wrote === true)).toBe(true)
  })

  test('confirm fills only the allowlisted fields and never touches money, payouts or Earn rows', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    const rows = await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR, 2n * XMR],
      feeVolumes: [3n * XMR, 4n * XMR],
      rollovers: [0n, 2n * XMR]
    })
    const payout = await db.rewardPayout.create({
      data: {
        distributionId: rows[0].id,
        curatorId: curators[0],
        recipientAddress: '5' + '8'.repeat(94),
        piconeros: 123n,
        state: 'SENT',
        txHash: 'ab'.repeat(32)
      }
    })
    const earn = await db.earn.create({
      data: {
        userId: curators[0],
        distributionId: rows[0].id,
        piconeros: 123n,
        type: 'TIP_POST'
      }
    })
    const before = await allDistributionRows()
    const beforePayouts = snapshot(await db.rewardPayout.findMany({ orderBy: { id: 'asc' } }))
    const beforeEarns = snapshot(await db.earn.findMany({ orderBy: { id: 'asc' } }))

    const result = await backfill(2, false)

    expect(result.rows.every(row => row.wrote === true)).toBe(true)
    const after = await allDistributionRows()
    for (let i = 0; i < before.length; i++) {
      const oldRow = before[i]
      const newRow = after[i]
      for (const key of Object.keys(oldRow)) {
        if (WRITABLE_FIELDS.has(key)) continue
        expect({ id: oldRow.id, key, value: newRow[key] }).toEqual({ id: oldRow.id, key, value: oldRow[key] })
      }
      expect(newRow.rawTipPiconeros).not.toBeNull()
      expect(newRow.trustedTipPiconeros).not.toBeNull()
      expect(newRow.tipperCount).toBe(4)
      expect(newRow.incomePiconeros).not.toBeNull()
      expect(newRow.breakerRawTPiconeros).not.toBeNull()
    }
    expect(after[0].eligibleTipStages.backfilled).toBe(true)
    expect(after[0].eligibleTipStages.staleTrustFallback).toBe(false)
    expect(after[0].curatorBudgetParams).toMatchObject({
      backfilled: true,
      trustWeightFloor: 1.0,
      capShareBps: 2500,
      excludedCuratorIds: [616]
    })
    expect(after[0].curatorBudgetParams.at).toEqual(expect.any(String))
    expect(after[0].curatorBudgetParams.scriptVersion).toEqual(expect.any(String))
    // The budget fields stay NULL because no dynamic budget was paid.
    expect(after[0].tipT4Piconeros).toBeNull()
    expect(after[0].incomeF4Piconeros).toBeNull()
    expect(after[0].reservePiconeros).toBeNull()
    expect(after[0].spendLimitPiconeros).toBeNull()
    expect(after[0].multBps).toBeNull()
    expect(after[0].dynamicBudgetPiconeros).toBeNull()
    expect(after[0].dynamicBudgetMode).toBeNull()
    expect(after[0].curatorBudgetMode).toBeNull()
    expect(after[0].appliedCuratorBudgetPiconeros).toBeNull()
    expect(after[0].makeupPiconeros).toBeNull()
    expect(after[0].breakerMakeupApproved).toBe(false)
    expect(payout.id).toBeGreaterThan(0)
    expect(earn.id).toBeGreaterThan(0)
    expect(snapshot(await db.rewardPayout.findMany({ orderBy: { id: 'asc' } }))).toEqual(beforePayouts)
    expect(snapshot(await db.earn.findMany({ orderBy: { id: 'asc' } }))).toEqual(beforeEarns)
  })

  test('a second confirm is idempotent and writes nothing', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR, 2n * XMR],
      feeVolumes: [XMR, XMR]
    })
    await backfill(2, false)
    const before = snapshot(await allDistributionRows())

    const second = await backfill(2, false)

    expect(second.rows.every(row => row.skipped === true)).toBe(true)
    expect(second.rows.every(row => row.wrote === false)).toBe(true)
    expect(snapshot(await allDistributionRows())).toEqual(before)
  })

  test('refuses a gap before writing when a newer row is filled and an older row is NULL', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    const rows = await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR, 2n * XMR],
      feeVolumes: [XMR, XMR]
    })
    await db.rewardDistribution.update({
      where: { id: rows[1].id },
      data: {
        rawTipPiconeros: 2n * XMR,
        trustedTipPiconeros: 2n * XMR,
        incomePiconeros: XMR,
        tipperCount: 4,
        eligibleTipStages: { raw: (2n * XMR).toString(), final: (2n * XMR).toString() }
      }
    })
    const before = snapshot(await allDistributionRows())

    const result = await backfill(2, false)

    expect(result.refused).toBe('gap')
    expect(result.rows).toEqual([])
    expect(snapshot(await allDistributionRows())).toEqual(before)
  })

  test('F uses the actual predecessor rollover even outside the requested N, and ignores donations', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    // Row 1 is outside the requested N=2; its rollover is row 2's input.
    const rows = await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR, 2n * XMR, 3n * XMR],
      feeVolumes: [XMR, 4n * XMR, 5n * XMR],
      donationVolumes: [0n, 2n * XMR, 1n * XMR],
      rollovers: [3n * XMR, 0n, 0n]
    })

    const result = await backfill(2, false)

    expect(result.rows.map(row => row.id)).toEqual([rows[1].id, rows[2].id])
    // Row 2: pool = predecessor rollover 3 + fee 4 + donation 2 = 9; earmark
    // 6; F excludes the 2 donation = 4. Row 3: pool = 5 + 1 donation = 6 with
    // no predecessor rollover; earmark 6; F = 5.
    expect(result.rows[0].previousDistributionId).toBe(rows[0].id)
    expect(result.rows[0].earmarkPiconeros).toBe(6n * XMR)
    expect(result.rows[0].donationsPiconeros).toBe(2n * XMR)
    expect(result.rows[0].incomePiconeros).toBe(4n * XMR)
    expect(result.rows[1].earmarkPiconeros).toBe(6n * XMR)
    expect(result.rows[1].donationsPiconeros).toBe(XMR)
    expect(result.rows[1].incomePiconeros).toBe(5n * XMR)
    expect((await db.rewardDistribution.findUnique({ where: { id: rows[1].id } })).incomePiconeros).toBe(4n * XMR)
    expect((await db.rewardDistribution.findUnique({ where: { id: rows[2].id } })).incomePiconeros).toBe(5n * XMR)
  })

  test('the first-ever distribution uses the whole pool for F', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    const rows = await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR],
      feeVolumes: [4n * XMR],
      donationVolumes: [3n * XMR],
      rollovers: [0n]
    })

    const result = await backfill(1, true)

    expect(result.rows[0].previousDistributionId).toBeNull()
    expect(result.rows[0].earmarkPiconeros).toBe(7n * XMR)
    expect(result.rows[0].donationsPiconeros).toBe(3n * XMR)
    expect(result.rows[0].incomePiconeros).toBe(4n * XMR)
    expect(rows[0].id).toBe(result.rows[0].id)
  })

  test('reports when the inflow reader disagrees with the derived earmark without failing', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    // Deliberately inconsistent pool: reader rewards = 1, derived earmark = 5.
    const rows = await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR],
      feeVolumes: [XMR],
      rollovers: [0n]
    })
    await db.rewardDistribution.update({
      where: { id: rows[0].id },
      data: { poolPiconeros: 5n * XMR }
    })

    const result = await backfill(1, true)

    expect(result.rows[0].earmarkPiconeros).toBe(5n * XMR)
    expect(result.rows[0].readerRewardsPiconeros).toBe(XMR)
    expect(result.rows[0].readerEarmarkMismatch).toBe(true)
    expect(result.rows[0].incomePiconeros).toBe(5n * XMR)
  })

  test('the breaker runs sequentially: rows 1-4 unarmed, row 5 armed, row 6 trips against rows 2-5', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    const tipVolumes = [XMR, XMR, XMR, XMR, XMR, 8n * XMR, XMR, XMR]
    const rows = await seedSeries({
      newestPeriodEnd,
      tipVolumes,
      feeVolumes: [XMR, XMR, XMR, XMR, XMR, XMR, XMR, XMR]
    })

    const result = await backfill(8, true)

    expect(result.rows.map(row => row.id)).toEqual(rows.map(row => row.id))
    expect(result.rows.slice(0, 4).every(row => row.breaker.armed === false)).toBe(true)
    expect(result.rows[4].breaker.armed).toBe(true)
    expect(result.rows[4].breaker.tripped).toBe(false)
    expect(result.rows[5].breaker.armed).toBe(true)
    expect(result.rows[5].breaker.tripped).toBe(true)
    expect(result.rows[5].breaker.thresholdPiconeros).toBe(25n * XMR / 10n)
    expect(result.rows[5].breaker.rawTPiconeros).toBe(8n * XMR)
    expect(result.rows[5].finalTPiconeros).toBe(25n * XMR / 10n)
    expect(result.rows[6].breaker.tripped).toBe(false)
    expect(result.rows[7].breaker.tripped).toBe(false)
  })

  test('includes recorded T history older than the requested N in the breaker series', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    await setConfig({
      curatorBudgetAvgPeriods: 1,
      curatorBreakerFloorMedianPeriods: 12,
      curatorBreakerArmPeriods: 1
    })
    const older = []
    for (let i = 4; i >= 1; i--) {
      older.push(await createDistribution({
        periodEnd: new Date(newestPeriodEnd.getTime() - (i + 1) * WEEK_MS),
        poolPiconeros: XMR,
        trustedTipPiconeros: 2n * XMR,
        incomePiconeros: XMR
      }))
    }
    await seedSeries({
      newestPeriodEnd,
      tipVolumes: [10n * XMR, XMR],
      feeVolumes: [XMR, XMR]
    })

    const result = await backfill(2, true)

    // The first requested row sees the four older recorded Ts: prior mean and
    // median are both 2 XMR, so the 2.5x threshold is 5 XMR and the 10 XMR
    // spike is capped there.
    expect(result.rows[0].priorTCount).toBe(4)
    expect(result.rows[0].breaker.armed).toBe(true)
    expect(result.rows[0].breaker.thresholdPiconeros).toBe(5n * XMR)
    expect(result.rows[0].breaker.tripped).toBe(true)
    expect(result.rows[0].finalTPiconeros).toBe(5n * XMR)
    expect(result.rows[1].priorTCount).toBe(5)
    expect(older).toHaveLength(4)
  })

  test('retains enough recorded history for arming in the backfill and derived run', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    await setConfig({
      curatorBudgetAvgPeriods: 4,
      curatorBreakerFloorMedianPeriods: 12,
      curatorBreakerArmPeriods: 20
    })
    await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR, XMR],
      feeVolumes: [XMR, XMR]
    })
    const addOlder = async (from, to) => {
      for (let i = from; i <= to; i++) {
        await createDistribution({
          periodEnd: new Date(newestPeriodEnd.getTime() - (i + 1) * WEEK_MS),
          poolPiconeros: 0n,
          trustedTipPiconeros: 100n,
          incomePiconeros: XMR
        })
      }
    }

    // 17 older rows + 2 selected = 19 recorded after the backfill: the derived
    // first-run projection must not arm yet. The first selected row only sees
    // the 17 earlier rows.
    await addOlder(1, 17)
    let result = await backfill(2, true)
    expect(result.rows[0].priorTCount).toBe(17)
    expect(result.rows[0].breaker.armed).toBe(false)
    expect(result.tHistory).toHaveLength(19)
    expect(result.openPeriod.breaker.armed).toBe(false)

    // The 20th recorded period arms the derived projection.
    await addOlder(18, 18)
    result = await backfill(2, true)
    expect(result.rows[0].priorTCount).toBe(18)
    expect(result.tHistory).toHaveLength(20)
    expect(result.openPeriod.breaker.armed).toBe(true)

    // Earlier-history retention is bounded by the arming requirement, not the
    // old max(avg, median) = 12 limit.
    await addOlder(19, 30)
    result = await backfill(2, true)
    expect(result.rows[0].priorTCount).toBe(20)
    expect(result.tHistory).toHaveLength(20)
    expect(result.openPeriod.breaker.armed).toBe(true)
  })

  test('a live ACTIVE run uses the backfilled T and F in T4, F4 and the breaker', async () => {
    const weekStart = startOfUtcWeek(new Date())
    const newestPeriodEnd = new Date(weekStart.getTime() - 60 * 60 * 1000)
    const history = await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR, XMR, XMR, XMR],
      feeVolumes: [XMR, XMR, XMR, XMR],
      rollovers: [0n, 0n, 0n, 10n * XMR]
    })
    await backfill(4, false)

    await setConfig({ curatorBudgetMode: 'ACTIVE' })
    const now = new Date()
    const openItem = await createItem(authorId, new Date(now.getTime() - 30 * 60 * 1000))
    for (const tipperId of curators) {
      await seedTip(tipperId, openItem, XMR / BigInt(curators.length), new Date(now.getTime() - 20 * 60 * 1000))
    }
    await seedFee(XMR, new Date(now.getTime() - 10 * 60 * 1000))

    const distribution = await runDistributionOnce({
      models: db,
      sendPayouts: async payouts => {
        await db.rewardPayout.updateMany({
          where: { id: { in: payouts.map(p => p.id) }, state: 'QUEUED' },
          data: { state: 'SENT', txHash: 'ab'.repeat(32) }
        })
        return { sent: payouts.length, skipped: 0, failed: 0 }
      },
      scheduleOpsSweep: false
    })
    created.distributions.push(distribution.id)

    expect(distribution.poolPiconeros).toBe(11n * XMR)
    expect(distribution.curatorBudgetMode).toBe('ACTIVE')
    expect(distribution.trustedTipPiconeros).toBe(XMR)
    expect(distribution.tipT4Piconeros).toBe(XMR)
    expect(distribution.incomeF4Piconeros).toBe(XMR)
    expect(distribution.eligibleTipStages.breakerArmed).toBe(true)
    expect(distribution.eligibleTipStages.breakerThreshold).toBe((25n * XMR / 10n).toString())
    expect(distribution.breakerTripped).toBe(false)
    expect(distribution.dynamicBudgetPiconeros).toBe(15n * XMR / 10n)
    expect(distribution.appliedCuratorBudgetPiconeros).toBe(15n * XMR / 10n)
    expect(history.every(row => row.id !== distribution.id)).toBe(true)
  })

  test('make-up approval is refused on a backfilled row', async () => {
    const newestPeriodEnd = new Date(startOfUtcWeek(new Date()).getTime() - 60 * 60 * 1000)
    const rows = await seedSeries({
      newestPeriodEnd,
      tipVolumes: [XMR, XMR, XMR, XMR, 8n * XMR],
      feeVolumes: [XMR, XMR, XMR, XMR, XMR]
    })
    await backfill(5, false)
    const latest = await db.rewardDistribution.findUnique({ where: { id: rows[4].id } })
    expect(latest.id).toBe(rows[4].id)
    expect(latest.breakerTripped).toBe(true)
    expect(latest.breakerMakeupApproved).toBe(false)

    const summary = await approveCuratorMakeup(db, latest.id, { confirm: true })

    expect(summary.refused).toBe('backfilled')
    expect((await db.rewardDistribution.findUnique({ where: { id: latest.id } })).breakerMakeupApproved).toBe(false)
  })
})
