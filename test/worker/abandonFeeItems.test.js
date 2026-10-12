/* eslint-env jest */

// Integration test for the 1-day abandonment sweep (worker/abandonFeeItems.js).
//
// A PENDING_FEE item is author-only-visible until its posting fee is observed
// on-chain; a fee the author never pays would otherwise linger forever (no
// badge, no re-pay path, no expiry). This sweep soft-deletes PENDING_FEE items
// (feeStatus still PENDING_FEE, feePayInId set) older than
// FEE_ITEM_ABANDON_DAYS (1 day), deletes their fee PayIn (the subaddress pool
// is ASSIGN-never-freed, so no reuse/misattribution risk), and clears any
// queued pgboss jobs for the item (timestampItem/imgproxy were queued at
// onPaid; deleteItem/reminder may be queued by performBotBehavior).
//
// Mirrors the real-DB style of test/worker/rewardsWalletObserver.fee.test.js:
// everything is real DB behaviour against the live dev database.

import { PrismaClient } from '@prisma/client'
import { runAbandonFeeItemsOnce } from '@/worker/abandonFeeItems'
import { FEE_ITEM_ABANDON_DAYS } from '@/lib/constants'
import { applySubFeeReceipt } from '@/api/monero/subFeeObservation'

const prisma = new PrismaClient()

const created = { users: [], items: [], payIns: [], subFees: [], pidMaps: [], feeObservations: [] }

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

// Seed a PENDING_FEE item + its fee PayIn (mirrors itemCreate.onBegin's shape),
// created `ageMs` ago. Returns { item, payIn }.
async function seedPendingFeeItem (minor, { ageMs = 0, feeStatus = 'PENDING_FEE', pollCost, moneroPaymentId } = {}) {
  const userId = await createUser()
  const createdAt = new Date(Date.now() - ageMs)
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'ITEM_CREATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroUri: `monero:5${'F'.repeat(94)}?tx_amount=0.001`,
      moneroSubaddressMajor: 1,
      moneroSubaddressMinor: minor,
      createdAt,
      moneroPaymentId
    }
  })
  created.payIns.push(payIn.id)
  const item = await prisma.item.create({
    data: {
      userId,
      title: `abandon-fixture-${minor}`,
      text: 'unpaid fixture reply',
      parentId: null,
      status: 'ACTIVE',
      feeStatus,
      feePayInId: payIn.id,
      pollCost,
      createdAt
    }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  created.items.push(item.id)
  return { item, payIn }
}

afterAll(async () => {
  for (const id of created.items) {
    await prisma.$executeRaw`DELETE FROM pgboss.job WHERE data->>'id' = ${String(id)} OR data->>'itemId' = ${String(id)}`
  }
  await prisma.reply.deleteMany({ where: { itemId: { in: created.items } } })
  await prisma.reply.deleteMany({ where: { ancestorId: { in: created.items } } })
  await prisma.itemUserAgg.deleteMany({ where: { itemId: { in: created.items } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  // observation rows first: pre-SET-NULL their payInId may still point at a
  // seeded payIn (RESTRICT would block its deletion below)
  for (const id of created.feeObservations) await prisma.feeObservation.deleteMany({ where: { id } })
  for (const id of created.subFees) await prisma.observedSubFee.deleteMany({ where: { id } })
  for (const pid of created.pidMaps) await prisma.subFeePidMap.deleteMany({ where: { paymentId: pid } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

const DAY_MS = 24 * 60 * 60 * 1000

test('abandons a PENDING_FEE item older than FEE_ITEM_ABANDON_DAYS', async () => {
  const { item, payIn } = await seedPendingFeeItem(501, { ageMs: (FEE_ITEM_ABANDON_DAYS + 1) * DAY_MS, pollCost: 10 })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(1)
  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.deletedAt).not.toBeNull()
  expect(live.text).toBe('*deleted by author*')
  expect(live.title).toBe('deleted by author')
  // pollCost is nulled like deleteItemByAuthor does
  expect(live.pollCost).toBeNull()
  // the fee PayIn is gone (subaddress stays ASSIGNED in the pool — no reuse)
  expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).toBeNull()
  expect(await prisma.itemPayIn.findFirst({ where: { itemId: item.id } })).toBeNull()
})

test('leaves a fresh PENDING_FEE item untouched', async () => {
  const { item } = await seedPendingFeeItem(502, { ageMs: 0 })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(0)
  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.deletedAt).toBeNull()
})

test('leaves a PENDING_FEE item younger than the cutoff untouched', async () => {
  const { item } = await seedPendingFeeItem(503, { ageMs: DAY_MS - 60 * 60 * 1000 })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(0)
  expect((await prisma.item.findUnique({ where: { id: item.id } })).deletedAt).toBeNull()
})

test('leaves FEE_PAID and FEE_NOT_REQUIRED items untouched', async () => {
  const paid = await seedPendingFeeItem(504, { ageMs: 2 * DAY_MS, feeStatus: 'FEE_PAID' })
  const free = await seedPendingFeeItem(505, { ageMs: 2 * DAY_MS, feeStatus: 'FEE_NOT_REQUIRED' })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(0)
  expect((await prisma.item.findUnique({ where: { id: paid.item.id } })).deletedAt).toBeNull()
  expect((await prisma.item.findUnique({ where: { id: free.item.id } })).deletedAt).toBeNull()
})

test('is idempotent across re-runs', async () => {
  const { item } = await seedPendingFeeItem(506, { ageMs: 2 * DAY_MS })

  await runAbandonFeeItemsOnce({ models: prisma })
  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(0)
  expect((await prisma.item.findUnique({ where: { id: item.id } })).deletedAt).not.toBeNull()
})

// Regression (final review Finding 1): an underpaid owner-routed leg leaves an
// ObservedSubFee DETECTED receipt pointing at the fee PayIn. The sweep deletes
// that PayIn — with ON DELETE RESTRICT the delete threw P2003, rolled the whole
// abandonment tx back, and the hourly cron re-failed forever on the poison row.
// The FK must be ON DELETE SET NULL (same bug class as FeeObservation's
// 20260814202910 fix): the item is abandoned, the PayIn deleted, and the
// receipt survives detached (payInId nulled).
test('abandons an item with an ObservedSubFee receipt: PayIn deleted, receipt survives with payInId nulled', async () => {
  const PAYMENT_ID = 'deadbeef0c0de507'
  const SUB_NAME = '_abandonturf_507'
  const { item, payIn } = await seedPendingFeeItem(507, { ageMs: 2 * DAY_MS, moneroPaymentId: PAYMENT_ID })

  const receipt = await prisma.observedSubFee.create({
    data: {
      txHash: `abandonsubfee-${payIn.id}`,
      paymentId: PAYMENT_ID,
      payInId: payIn.id,
      subName: SUB_NAME,
      ownerUserId: item.userId,
      piconeros: 1_000n, // underpaid vs the quoted fee
      state: 'DETECTED'
    }
  })
  created.subFees.push(receipt.id)
  await prisma.subFeePidMap.create({
    data: {
      paymentId: PAYMENT_ID,
      subName: SUB_NAME,
      ownerUserId: item.userId,
      amountPiconeros: 1_000_000_000n,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  })
  created.pidMaps.push(PAYMENT_ID)

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(1)
  expect((await prisma.item.findUnique({ where: { id: item.id } })).deletedAt).not.toBeNull()
  expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).toBeNull()
  const live = await prisma.observedSubFee.findUnique({ where: { id: receipt.id } })
  expect(live).not.toBeNull()
  expect(live.payInId).toBeNull()
  expect(live.state).toBe('DETECTED')
})

// --- Finding 5: soft-deleted pending-fee items ---
// Production observation: items soft-deleted while PENDING_FEE kept their fee
// PayIn + SubFeePidMap rows (the old selector required deletedAt null). The fee
// PayIn stayed watched forever and a late fee could flip deleted content live
// (notifications, quota consumption, denormalization). The sweep now selects
// them too, claims inside the transaction, and preserves the prior deletion.

test('cleans an already-deleted stale fee item without rewriting its deletion', async () => {
  const { item, payIn } = await seedPendingFeeItem(508, { ageMs: 3 * DAY_MS })
  const deletedAt = new Date(Date.now() - 2 * DAY_MS)
  await prisma.item.update({ where: { id: item.id }, data: { deletedAt, text: 'retained deletion marker' } })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(out.abandoned).toBe(1)
  expect(after.deletedAt).toEqual(deletedAt)
  expect(after.text).toBe('retained deletion marker')
  expect(after.title).toBe('abandon-fixture-508')
  expect(after.feePayInId).toBeNull()
  expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).toBeNull()
})

test('abandoned counts only rows the claim actually cleaned (fee flip won the race)', async () => {
  const { item, payIn } = await seedPendingFeeItem(509, { ageMs: 2 * DAY_MS })
  const realFindMany = prisma.item.findMany.bind(prisma.item)
  // Deterministic scan→claim barrier (no timing sleep): the flip commits
  // between the sweep's SELECT and its claim transaction.
  const spy = jest.spyOn(prisma.item, 'findMany').mockImplementationOnce(async (args) => {
    const rows = await realFindMany(args)
    await prisma.item.update({ where: { id: item.id }, data: { feeStatus: 'FEE_PAID' } })
    return rows
  })
  let out
  try {
    out = await runAbandonFeeItemsOnce({ models: prisma })
  } finally {
    spy.mockRestore()
  }

  // the claim matched no row → nothing was cleaned, so nothing is counted
  expect(out.abandoned).toBe(0)
  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.feeStatus).toBe('FEE_PAID')
  expect(after.deletedAt).toBeNull()
  expect(after.feePayInId).toBe(payIn.id)
  expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).not.toBeNull()
})

test('leaves a detached PENDING_FEE item (no fee PayIn) untouched', async () => {
  const { item, payIn } = await seedPendingFeeItem(510, { ageMs: 2 * DAY_MS })
  await prisma.item.update({ where: { id: item.id }, data: { feePayInId: null } })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(0)
  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.deletedAt).toBeNull()
  // only a claimed row's RETURNED PayIn is deleted — the stale scan snapshot
  // is never used, so a detached linkage's orphan PayIn survives
  expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).not.toBeNull()
})

test('retains a deleted underpaid item\'s evidence and PID map (payInId nulled, linkage detached)', async () => {
  const PAYMENT_ID = 'deletedunderpaid511'
  const SUB_NAME = '_abandonturf_511'
  const TX_HASH = `deleted-underpaid-${Date.now()}`
  const { item, payIn } = await seedPendingFeeItem(511, { ageMs: 3 * DAY_MS, moneroPaymentId: PAYMENT_ID })
  const deletedAt = new Date(Date.now() - 2 * DAY_MS)
  await prisma.item.update({ where: { id: item.id }, data: { deletedAt } })

  // The underpaid owner-routed receipt: 4e8 observed vs the quoted 1e9 fee.
  const receipt = await prisma.observedSubFee.create({
    data: {
      txHash: TX_HASH,
      paymentId: PAYMENT_ID,
      payInId: payIn.id,
      subName: SUB_NAME,
      ownerUserId: item.userId,
      piconeros: 400_000_000n,
      state: 'DETECTED'
    }
  })
  created.subFees.push(receipt.id)

  // The attributed fee observation for the same underpaid payIn.
  const observation = await prisma.feeObservation.create({
    data: {
      txHash: `${TX_HASH}-obs`,
      payInId: payIn.id,
      feeType: 'POSTING',
      postId: item.id,
      recipientMajor: 1,
      recipientMinor: 511,
      piconeros: 400_000_000n,
      height: 1234,
      state: 'DETECTED'
    }
  })
  created.feeObservations.push(observation.id)

  // Permanent subaddress reservation (ASSIGN-never-freed): the PID map must
  // survive so a late payment can still be attributed.
  const pidMap = await prisma.subFeePidMap.create({
    data: {
      paymentId: PAYMENT_ID,
      subName: SUB_NAME,
      ownerUserId: item.userId,
      amountPiconeros: 1_000_000_000n,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  })
  created.pidMaps.push(PAYMENT_ID)

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.abandoned).toBe(1)
  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.deletedAt).toEqual(deletedAt)
  expect(after.feePayInId).toBeNull()
  expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).toBeNull()

  // evidence survives detached: FK SET NULL, never deleted
  const liveReceipt = await prisma.observedSubFee.findUnique({ where: { id: receipt.id } })
  expect(liveReceipt).not.toBeNull()
  expect(liveReceipt.payInId).toBeNull()
  expect(liveReceipt.piconeros).toBe(400_000_000n)
  const liveObservation = await prisma.feeObservation.findUnique({ where: { id: observation.id } })
  expect(liveObservation).not.toBeNull()
  expect(liveObservation.payInId).toBeNull()

  // the PID map (and thus the subaddress reservation) is untouched
  const liveMap = await prisma.subFeePidMap.findUnique({ where: { paymentId: PAYMENT_ID } })
  expect(liveMap).not.toBeNull()
  expect(liveMap.subName).toBe(SUB_NAME)
  expect(liveMap.ownerUserId).toBe(item.userId)
  expect(liveMap.amountPiconeros).toBe(1_000_000_000n)
  expect(liveMap.expiresAt).toEqual(pidMap.expiresAt)

  // idempotent: the item is now detached (feePayInId null) → no new claim
  const again = await runAbandonFeeItemsOnce({ models: prisma })
  expect(again.abandoned).toBe(0)
})

test('a late receipt after cleanup is recorded via the retained PID map with a null PayIn', async () => {
  const PAYMENT_ID = 'latefeeaftercleanup'
  const SUB_NAME = '_abandonturf_512'
  const { item, payIn } = await seedPendingFeeItem(512, { ageMs: 3 * DAY_MS, moneroPaymentId: PAYMENT_ID })
  await prisma.item.update({ where: { id: item.id }, data: { deletedAt: new Date(Date.now() - 2 * DAY_MS) } })
  await prisma.subFeePidMap.create({
    data: {
      paymentId: PAYMENT_ID,
      subName: SUB_NAME,
      ownerUserId: item.userId,
      amountPiconeros: 1_000_000_000n,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  })
  created.pidMaps.push(PAYMENT_ID)

  const out = await runAbandonFeeItemsOnce({ models: prisma })
  expect(out.abandoned).toBe(1)

  // A writer still holding the pre-cleanup PayIn snapshot hits the existing FK
  // loudly — the abandoned leg is never silently attributed to a dead PayIn.
  await expect(applySubFeeReceipt(prisma, {
    feePayIn: { id: payIn.id, payInType: 'ITEM_CREATE', moneroUri: null },
    paymentId: PAYMENT_ID,
    txHash: `late-stale-${Date.now()}`,
    piconeros: 1_000_000_000n,
    height: 1999,
    confirmations: 0
  })).rejects.toThrow()

  // The normal retry (webhook's abandoned-leg path: feePayIn lookup finds the
  // PayIn gone → null) records the receipt off the retained PID map.
  const lateHash = `late-receipt-${Date.now()}`
  const { transitioned } = await applySubFeeReceipt(prisma, {
    feePayIn: null,
    paymentId: PAYMENT_ID,
    txHash: lateHash,
    piconeros: 1_000_000_000n,
    height: 2000,
    confirmations: 0
  })

  expect(transitioned).toBe(true)
  const late = await prisma.observedSubFee.findUnique({ where: { txHash: lateHash } })
  expect(late).not.toBeNull()
  expect(late.payInId).toBeNull()
  expect(late.subName).toBe(SUB_NAME)
  expect(late.ownerUserId).toBe(item.userId)
  expect(late.state).toBe('DETECTED')
  expect(late.height).toBe(2000)
  created.subFees.push(late.id)

  // the late receipt cannot resurrect the deleted item's live path
  const after = await prisma.item.findUnique({ where: { id: item.id } })
  expect(after.feeStatus).toBe('PENDING_FEE')
  expect(after.deletedAt).not.toBeNull()
  expect(after.feePayInId).toBeNull()
})

// --- deferred fee-bearing edits (PendingItemUpdate) ---
// A never-paid ITEM_UPDATE upload fee leaves the item untouched but strands the
// stored edit; the sweep purges it after FEE_ITEM_ABANDON_DAYS and deletes the
// fee payIn (a late payment then finds no payIn and is ignored, exactly like the
// abandoned ITEM_CREATE behavior).
async function seedPendingUpdate ({ minor, ageMs }) {
  const userId = await createUser()
  const createdAt = new Date(Date.now() - ageMs)
  const item = await prisma.item.create({
    data: {
      userId,
      title: `pending-update-fixture-${minor}`,
      text: 'original text',
      createdAt,
      feeStatus: 'FEE_NOT_REQUIRED'
    }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  const payIn = await prisma.payIn.create({
    data: {
      userId,
      payInType: 'ITEM_UPDATE',
      payInState: 'PAID',
      piconeros: 0n,
      moneroUri: `monero:5${'F'.repeat(94)}?tx_amount=0.001`,
      moneroSubaddressMajor: 1,
      moneroSubaddressMinor: minor,
      createdAt
    }
  })
  created.payIns.push(payIn.id)
  const pending = await prisma.pendingItemUpdate.create({
    data: {
      itemId: item.id,
      payInId: payIn.id,
      oldText: 'original text',
      args: { id: String(item.id), text: 'deferred text' },
      createdAt
    }
  })
  return { item, payIn, pending }
}

test('purges a deferred edit (and its payIn) older than FEE_ITEM_ABANDON_DAYS', async () => {
  const { item, payIn, pending } = await seedPendingUpdate({ minor: 601, ageMs: 2 * DAY_MS })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.pendingPurged).toBe(1)
  expect(await prisma.pendingItemUpdate.findUnique({ where: { id: pending.id } })).toBeNull()
  expect(await prisma.payIn.findUnique({ where: { id: payIn.id } })).toBeNull()
  // the item itself is untouched — the edit was never applied
  const live = await prisma.item.findUnique({ where: { id: item.id } })
  expect(live.deletedAt).toBeNull()
  expect(live.text).toBe('original text')
})

test('leaves a fresh deferred edit untouched', async () => {
  const { pending } = await seedPendingUpdate({ minor: 602, ageMs: 0 })

  const out = await runAbandonFeeItemsOnce({ models: prisma })

  expect(out.pendingPurged).toBe(0)
  expect(await prisma.pendingItemUpdate.findUnique({ where: { id: pending.id } })).toBeTruthy()
})
