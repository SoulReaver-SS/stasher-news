/* eslint-env jest */

// flipPendingToLive wedge isolation (R14, 2026-09-21). The rewardsWalletObserver
// advances its lastTxId cursor only after a fully clean poll, so a
// persistently-throwing post-flip effect used to fail every later poll at the
// same tx and freeze ALL fee attribution (the 2026-08-10 incident class).
// These tests force each guarded site to throw and assert: the money-relevant
// state still flips, the failure alerts with a per-payIn dedupeKey, and a later
// tx in the same pass still processes — no wedge.
//
// denormalizeComment/runItemLiveSideEffects/consumeQuotaForFlippedItem are
// module-mocked so the site-1/site-4 failures are injected without DB
// gymnastics; the territory (sub.updateMany) and upload ($executeRaw) sites are
// forced through the live prisma client, whose delegate is cached and spy-able
// (verified against the running stack).
//
// Real-DB suite (mirrors test/worker/rewardsWalletObserver.fee.test.js):
//   docker exec -w /app -u apprunner app npm run test -- test/worker/rewardsWalletObserver.flip.test.js

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { runRewardsWalletObserverOnce, flipPendingToLive } from '@/worker/rewardsWalletObserver'
import { runAbandonFeeItemsOnce } from '@/worker/abandonFeeItems'
import { alert } from '@/lib/alert'
import { logError } from '@/lib/logger'
import { denormalizeComment, runItemLiveSideEffects } from '@/lib/itemLiveEffects'
import { consumeQuotaForFlippedItem } from '@/api/payIn/lib/freebie'
import { sweepFakeRewardsWallets } from '../helpers/sweepRewardsWallets'

jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))
jest.mock('../../lib/itemLiveEffects', () => ({
  __esModule: true,
  denormalizeComment: jest.fn(),
  runItemLiveSideEffects: jest.fn()
}))
jest.mock('../../api/payIn/lib/freebie', () => ({
  __esModule: true,
  consumeQuotaForFlippedItem: jest.fn()
}))

const prisma = new PrismaClient()

const REWARDS_ADDR = '5RpnlFlipTest' + 'D'.repeat(84) // unique placeholder; never decoded

const created = { users: [], items: [], accounts: [], payIns: [], subs: [], uploads: [] }
let rewardsWallet

beforeAll(async () => {
  await sweepFakeRewardsWallets([REWARDS_ADDR])
  rewardsWallet = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: REWARDS_ADDR, label: 'platform_rewards', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(rewardsWallet.id)
})

beforeEach(() => {
  jest.clearAllMocks()
  denormalizeComment.mockReset()
  consumeQuotaForFlippedItem.mockReset()
  runItemLiveSideEffects.mockReset()
})

afterEach(async () => {
  jest.restoreAllMocks()
  await prisma.feeObservation.deleteMany({ where: { payInId: { in: created.payIns } } })
})

afterAll(async () => {
  await prisma.feeObservation.deleteMany({ where: { payInId: { in: created.payIns } } })
  for (const name of created.subs) await prisma.sub.deleteMany({ where: { name } })
  await prisma.reply.deleteMany({ where: { itemId: { in: created.items } } })
  await prisma.reply.deleteMany({ where: { ancestorId: { in: created.items } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const id of created.uploads) await prisma.upload.deleteMany({ where: { id } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await sweepFakeRewardsWallets([REWARDS_ADDR])
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

// Seed an Item PENDING_FEE + its PayIn watching a rewards-wallet posting-fee
// subaddress (major 1, minor). Mirrors fee.test.js's seedPendingFeePost.
async function seedPendingFeePost (minor) {
  const userId = await createUser()
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'ITEM_CREATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroSubaddressMajor: 1,
      moneroSubaddressMinor: minor
    }
  })
  created.payIns.push(payIn.id)
  const item = await prisma.item.create({
    data: { userId, title: 'pending-fee post', status: 'ACTIVE', feeStatus: 'PENDING_FEE', feePayInId: payIn.id }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  created.items.push(item.id)
  return { item, payIn, major: 1, minor }
}

// Seed a PENDING_FEE COMMENT (reply) + its PayIn — the site-1 trigger path.
async function seedPendingFeeComment (minor) {
  const userId = await createUser()
  const root = await prisma.item.create({ data: { userId, title: 'reply-thread root', status: 'ACTIVE' } })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(root.id)}::ltree WHERE id = ${root.id}::int`
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'ITEM_CREATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroSubaddressMajor: 1,
      moneroSubaddressMinor: minor
    }
  })
  created.payIns.push(payIn.id)
  const comment = await prisma.item.create({
    data: { userId, parentId: root.id, rootId: root.id, text: 'pending-fee reply', status: 'ACTIVE', feeStatus: 'PENDING_FEE', feePayInId: payIn.id }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(root.id) + '.' + String(comment.id)}::ltree WHERE id = ${comment.id}::int`
  await prisma.itemPayIn.create({ data: { itemId: comment.id, payInId: payIn.id } })
  created.items.push(root.id, comment.id)
  return { root, comment, payIn, major: 1, minor }
}

// Seed a Sub PENDING_FEE + its PayIn watching a rewards-wallet territory-fee
// subaddress (major 2, minor) — the site-2 trigger path.
async function seedPendingFeeSub (minor) {
  const userId = await createUser()
  const subName = `turf-flip-${minor}`
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'TERRITORY_BILLING',
      payInState: 'PAID',
      piconeros: 0n,
      moneroSubaddressMajor: 2,
      moneroSubaddressMinor: minor
    }
  })
  created.payIns.push(payIn.id)
  await prisma.sub.create({
    data: {
      name: subName,
      userId,
      rankingType: 'WOT',
      billingType: 'ONCE',
      billingCost: 1000000000,
      billingStatus: 'PENDING_FEE',
      billingPayInId: payIn.id
    }
  })
  created.subs.push(subName)
  await prisma.subPayIn.create({ data: { subName, payInId: payIn.id } })
  return { subName, payIn, major: 2, minor }
}

const txHash = () => randomUUID().replaceAll('-', '')

test('item activation and comment effects have explicit independent transaction budgets', async () => {
  const { payIn } = await seedPendingFeeComment(399)
  const transaction = jest.spyOn(prisma, '$transaction')
  await flipPendingToLive(prisma, payIn, 1000000000n)
  expect(transaction).toHaveBeenCalledTimes(2)
  for (const [, options] of transaction.mock.calls) {
    expect(options).toEqual({ maxWait: 5000, timeout: 15000 })
  }
  expect(denormalizeComment).toHaveBeenCalledTimes(1)
})

function lwsFeeTx (hash, piconeros, major, minor, height = 1234) {
  return { hash, piconeros: BigInt(piconeros), recipient: { maj_i: major, min_i: minor }, height, id: 1, payment_id: null }
}

test('a persistently-throwing denormalizeComment cannot roll back the flip or wedge the pass (R14)', async () => {
  const { comment, payIn, major, minor } = await seedPendingFeeComment(301)
  const later = await seedPendingFeePost(302)
  denormalizeComment.mockRejectedValue(new Error('boom-denormalize'))

  await expect(runRewardsWalletObserverOnce({
    models: prisma,
    account: rewardsWallet,
    txs: [
      lwsFeeTx(txHash(), '1000000000', major, minor),
      lwsFeeTx(txHash(), '1000000000', later.major, later.minor)
    ]
  })).resolves.toBeUndefined()

  // the flip committed despite the denormalization failure
  const flipped = await prisma.item.findUnique({ where: { id: comment.id } })
  expect(flipped.feeStatus).toBe('FEE_PAID')
  expect(logError).toHaveBeenCalledWith(expect.stringContaining('denormaliz'), expect.any(Error))
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.any(String),
    expect.stringContaining(`payIn ${payIn.id}`),
    { dedupeKey: `flip-denormalize-${payIn.id}` })

  // the pass continued: the later tx attributed and flipped normally
  expect((await prisma.item.findUnique({ where: { id: later.item.id } })).feeStatus).toBe('FEE_PAID')
})

test('a throwing territory billing flip leaves the row PENDING_FEE and does not wedge the pass (R14)', async () => {
  const { subName, payIn, major, minor } = await seedPendingFeeSub(303)
  const later = await seedPendingFeePost(304)
  jest.spyOn(prisma.sub, 'updateMany').mockRejectedValueOnce(new Error('boom-territory'))

  await expect(runRewardsWalletObserverOnce({
    models: prisma,
    account: rewardsWallet,
    txs: [
      lwsFeeTx(txHash(), '1000000000', major, minor),
      lwsFeeTx(txHash(), '1000000000', later.major, later.minor)
    ]
  })).resolves.toBeUndefined()

  expect((await prisma.sub.findUnique({ where: { name: subName } })).billingStatus).toBe('PENDING_FEE')
  expect(logError).toHaveBeenCalledWith(expect.stringContaining('territory'), expect.any(Error))
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.any(String),
    expect.stringContaining(`payIn ${payIn.id}`),
    { dedupeKey: `flip-territory-${payIn.id}` })
  expect((await prisma.item.findUnique({ where: { id: later.item.id } })).feeStatus).toBe('FEE_PAID')
})

test('a throwing upload paid-flip leaves the upload unpaid and does not wedge the pass (R14)', async () => {
  const { item, payIn, major, minor } = await seedPendingFeePost(305)
  const later = await seedPendingFeePost(308)
  const upload = await prisma.upload.create({
    data: { userId: payIn.userId, size: 11 * 1024 * 1024, type: 'image/png' }
  })
  created.uploads.push(upload.id)
  await prisma.uploadPayIn.create({ data: { uploadId: upload.id, payInId: payIn.id } })
  jest.spyOn(prisma, '$executeRaw').mockRejectedValueOnce(new Error('boom-upload'))

  await expect(runRewardsWalletObserverOnce({
    models: prisma,
    account: rewardsWallet,
    txs: [
      lwsFeeTx(txHash(), '1000000000', major, minor),
      lwsFeeTx(txHash(), '1000000000', later.major, later.minor)
    ]
  })).resolves.toBeUndefined()

  // the flip committed; only the upload paid-flag flip was skipped
  expect((await prisma.item.findUnique({ where: { id: item.id } })).feeStatus).toBe('FEE_PAID')
  expect((await prisma.upload.findUnique({ where: { id: upload.id } })).paid).toBe(false)
  expect(logError).toHaveBeenCalledWith(expect.stringContaining('upload'), expect.any(Error))
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.any(String),
    expect.stringContaining(`payIn ${payIn.id}`),
    { dedupeKey: `flip-uploads-${payIn.id}` })

  // the pass continued: the later tx attributed and flipped normally
  expect((await prisma.item.findUnique({ where: { id: later.item.id } })).feeStatus).toBe('FEE_PAID')
})

test('a throwing quota consumption cannot roll back the flip or wedge the pass (R14)', async () => {
  const { comment, payIn, major, minor } = await seedPendingFeeComment(306)
  const later = await seedPendingFeePost(307)
  await prisma.item.update({ where: { id: comment.id }, data: { feeQuotaEligible: true } })
  consumeQuotaForFlippedItem.mockRejectedValue(new Error('boom-quota'))

  await expect(runRewardsWalletObserverOnce({
    models: prisma,
    account: rewardsWallet,
    txs: [
      lwsFeeTx(txHash(), '1000000000', major, minor),
      lwsFeeTx(txHash(), '1000000000', later.major, later.minor)
    ]
  })).resolves.toBeUndefined()

  // the flip committed despite the quota failure
  expect((await prisma.item.findUnique({ where: { id: comment.id } })).feeStatus).toBe('FEE_PAID')
  expect(logError).toHaveBeenCalledWith(expect.stringContaining('quota'), expect.any(Error))
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.any(String),
    expect.stringContaining(`payIn ${payIn.id}`),
    { dedupeKey: `flip-quota-${payIn.id}` })

  // the pass continued
  expect((await prisma.item.findUnique({ where: { id: later.item.id } })).feeStatus).toBe('FEE_PAID')
})

// --- Finding 5: deleted content must never enter the live path ---
// deleteItemByAuthor keeps feeStatus PENDING_FEE + feePayInId, so a fee that
// lands after the deletion used to win the ITEM_CREATE pending-to-paid claim:
// the deleted item flipped FEE_PAID, consumed quota, denormalized its ancestors
// and fired creation notifications. The receipt is still recorded (incoming
// funds stay accounted for); only the live claim refuses.

const DAY_MS = 24 * 60 * 60 * 1000

test('a deleted pending post cannot flip live when its fee is observed', async () => {
  const { item, payIn, major, minor } = await seedPendingFeePost(309)
  const deletedAt = new Date(Date.now() - 60 * 60 * 1000)
  await prisma.item.update({ where: { id: item.id }, data: { deletedAt } })

  await runRewardsWalletObserverOnce({
    models: prisma,
    account: rewardsWallet,
    txs: [lwsFeeTx(txHash(), '1000000000', major, minor)]
  })

  // the receipt itself is still recorded
  const obs = await prisma.feeObservation.findFirst({ where: { payInId: payIn.id } })
  expect(obs).toBeTruthy()

  // ...but the deleted item never wins the pending-to-paid claim
  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.feeStatus).toBe('PENDING_FEE')
  expect(after.feeInvestmentPiconeros).toBe(0n)
  expect(after.deletedAt).toEqual(deletedAt)
  expect(runItemLiveSideEffects).not.toHaveBeenCalled()
  expect(consumeQuotaForFlippedItem).not.toHaveBeenCalled()
  expect(denormalizeComment).not.toHaveBeenCalled()
})

test('a deleted pending reply consumes no quota, denormalizes nothing, and does not publish', async () => {
  const { root, comment, payIn, major, minor } = await seedPendingFeeComment(310)
  await prisma.item.update({
    where: { id: comment.id },
    data: { deletedAt: new Date(Date.now() - 60 * 60 * 1000), feeQuotaEligible: true }
  })

  await runRewardsWalletObserverOnce({
    models: prisma,
    account: rewardsWallet,
    txs: [lwsFeeTx(txHash(), '1000000000', major, minor)]
  })

  const obs = await prisma.feeObservation.findFirst({ where: { payInId: payIn.id } })
  expect(obs).toBeTruthy()

  const after = await prisma.item.findUnique({ where: { id: comment.id } })
  expect(after.feeStatus).toBe('PENDING_FEE')
  expect(consumeQuotaForFlippedItem).not.toHaveBeenCalled()
  expect(denormalizeComment).not.toHaveBeenCalled()
  expect(runItemLiveSideEffects).not.toHaveBeenCalled()
  const rootAfter = await prisma.item.findUnique({ where: { id: root.id } })
  expect(rootAfter.ncomments).toBe(0)
  expect(rootAfter.nDirectComments).toBe(0)
})

// --- deletion/payment race orderings (separate clients, awaited barriers,
// no timing sleeps) ---

test('race ordering: a fee flip committed first keeps its paid linkage through the sweep', async () => {
  const flipper = new PrismaClient()
  try {
    const { item, payIn } = await seedPendingFeePost(311)
    // Age past the abandonment cutoff so the sweep WOULD claim the row if it
    // were still PENDING_FEE.
    await prisma.item.update({ where: { id: item.id }, data: { createdAt: new Date(Date.now() - 2 * DAY_MS) } })

    // Barrier: the flip's transaction commits on its own client first.
    await flipPendingToLive(flipper, payIn, 1_000_000_000n)

    // Only then does the sweep run (suite connection).
    const out = await runAbandonFeeItemsOnce({ models: prisma })

    expect(out.abandoned).toBe(0)
    expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).not.toBeNull()
    const after = await prisma.item.findUnique({ where: { id: item.id } })
    expect(after.feeStatus).toBe('FEE_PAID')
    expect(after.feePayInId).toBe(payIn.id)
    expect(after.deletedAt).toBeNull()
    expect(await prisma.itemPayIn.findFirst({ where: { itemId: item.id } })).not.toBeNull()
  } finally {
    await flipper.$disconnect()
  }
})

test('race ordering: an abandonment that claims first makes the later fee flip a no-op', async () => {
  const late = new PrismaClient()
  try {
    const { item, payIn, major, minor } = await seedPendingFeePost(312)
    await prisma.item.update({
      where: { id: item.id },
      data: { createdAt: new Date(Date.now() - 2 * DAY_MS), feeQuotaEligible: true }
    })

    // Barrier: the sweep claims and commits first, deleting the linkage.
    const out = await runAbandonFeeItemsOnce({ models: prisma })
    expect(out.abandoned).toBe(1)

    // The late fee event arrives afterwards on a separate client. The PayIn is
    // gone, so attribution finds no pending leg and the stale in-memory PayIn
    // cannot win a flip either.
    await runRewardsWalletObserverOnce({
      models: late,
      account: rewardsWallet,
      txs: [lwsFeeTx(txHash(), '1000000000', major, minor)]
    })
    await flipPendingToLive(late, payIn, 1_000_000_000n)

    expect(await prisma.feeObservation.count({ where: { payInId: payIn.id } })).toBe(0)
    const after = await prisma.item.findUnique({ where: { id: item.id } })
    expect(after.feeStatus).toBe('PENDING_FEE')
    expect(after.deletedAt).not.toBeNull()
    expect(after.feeInvestmentPiconeros).toBe(0n)
    expect(runItemLiveSideEffects).not.toHaveBeenCalled()
    expect(consumeQuotaForFlippedItem).not.toHaveBeenCalled()
    expect(denormalizeComment).not.toHaveBeenCalled()
  } finally {
    await late.$disconnect()
  }
})
