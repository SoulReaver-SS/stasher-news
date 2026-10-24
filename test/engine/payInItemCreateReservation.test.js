/* eslint-env jest */

// Free-unit RESERVATION for upload-fee items (finding #6 residual, I-1).
//
// An upload-fee item created in-quota is born PENDING_FEE (optimistic — before
// any payment) and its free unit is only SPENT at the fee flip. Without a
// reservation, every upload-fee submission priced itself against the same
// unspent unit: all of them published when their fees confirmed, only the
// first flip consumed the quota, the rest alerted. The fix makes
// commentQuotaFor/postQuotaFor reservation-aware (pendingQuotaReservations)
// and has onBegin reject a priced-upload-fee-only payIn whose slot vanished
// under the payer lock (the concurrent double-submit race).
//
// Real-DB integration suite (mirrors payInItemCreate.test.js): drives the real
// pay() engine, the real abandonment core, and the real flip bookkeeping.
// Run via the guarded isolated runner (or docker exec app npx jest).

import { PrismaClient } from '@prisma/client'
import pay from '@/api/payIn/index'
import { getInitial } from '@/api/payIn/types/itemCreate'
import { flipPendingToLive } from '@/worker/rewardsWalletObserver'
import { runAbandonFeeItemsOnce } from '@/worker/abandonFeeItems'
import { postingFeePrivatesFor } from '@/api/monero/postingFee'
import { moneroUriAmountPiconeros } from '@/lib/format'

// Fee legs register an lws webhook at issuance; never reach the real lws.
jest.mock('../../api/monero/lwsClient', () => ({
  __esModule: true, lwsClient: { addWebhook: jest.fn(async () => ({ event_id: 'test-fee-hook' })) }
}))

// itemCreate.js statically imports the ESM-only lexical mention parser and
// the heavy getItem resolver chain — stub both (mirrors payInItemCreate.test.js).
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../api/resolvers/item', () => ({
  __esModule: true,
  getItem: jest.fn()
}))
// Stub the fee-subaddress pool so getInitial never touches MoneroAccount /
// SubaddressIndex rows (deterministic; the address is the stagenet primary
// reused in payInItemCreate.test.js).
jest.mock('../../api/monero/feePool', () => ({
  __esModule: true,
  throttleFeeIssuance: jest.fn(),
  resolvePlatformFeeRecipient: jest.fn(models => require('../../test/helpers/platformFeeRecipient').testPlatformFeeRecipient(models)),
  reserveFeeSubaddress: jest.fn(async () => ({
    id: 1,
    major: 1,
    minor: 1,
    address: '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
  }))
}))

// Rendezvous gate for the concurrent double-submit test. While armed, EVERY
// ITEM_CREATE getInitial call waits until TWO calls have arrived before any
// of them prices — both prospects then see the same pre-reservation quota
// state (the bug's precondition), and the payer row lock decides the begin()
// winner deterministically (no timing assertions). Declared `mock*` so the
// jest.mock factory below may legally close over it; dereferenced only at
// call time, after module evaluation.
const mockGate = { armed: false, arrivals: 0, blocker: Promise.resolve(), resolve: () => {} }

// The engine test below drives pay('ITEM_CREATE', ...) end-to-end, so the
// types barrel is mocked to expose ONLY the real ITEM_CREATE (with the gated
// getInitial wrapper) and MEDIA_UPLOAD — same rationale as
// payInItemCreate.test.js (relative paths; jest.requireActual).
jest.mock('../../api/payIn/types', () => {
  const itemCreate = jest.requireActual('../../api/payIn/types/itemCreate')
  const mediaUpload = jest.requireActual('../../api/payIn/types/mediaUpload')
  return {
    __esModule: true,
    default: {
      ITEM_CREATE: {
        ...itemCreate,
        getInitial: async (...callArgs) => {
          // price FIRST, then rendezvous: both prospects must be fully priced
          // against the pre-reservation quota state before either begin()
          // starts, or the second pricer degenerates into the sequential
          // (charged) case instead of the concurrent double-submit race.
          const prospect = await itemCreate.getInitial(...callArgs)
          if (mockGate.armed) {
            mockGate.arrivals += 1
            if (mockGate.arrivals >= 2) mockGate.resolve()
            await mockGate.blocker
          }
          return prospect
        }
      },
      MEDIA_UPLOAD: mediaUpload
    }
  }
})

const prisma = new PrismaClient()

// FK-safe teardown tracking. Race-test rows (winner payIn/item) are never
// individually tracked — everything is swept by userId below.
const created = { users: [], items: [], payIns: [], uploads: [], subs: [] }

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

async function createUpload (userId, { size }) {
  const upload = await prisma.upload.create({ data: { userId, size, type: 'image/png' } })
  created.uploads.push(upload.id)
  return upload.id
}

// Minimal root post (parentId null) for comment fixtures; path set via a
// second statement (ltree is unsupported in Prisma create).
async function createRootPost (userId) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "created_at")
    VALUES (${userId}::int, ${'reservation root'}, now())
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

// PlatformFeeConfig id=1 exists in the dev DB with @default values; create it
// only if absent so the tests stay self-contained on a fresh database.
let feeConfigCreated = false
async function ensureFeeConfig () {
  const existing = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (existing) return
  await prisma.platformFeeConfig.create({ data: { id: 1 } })
  feeConfigCreated = true
}

async function deleteJobsForItem (itemId) {
  const id = String(itemId)
  await prisma.$executeRaw`
    DELETE FROM pgboss.job
    WHERE data->>'id' = ${id} OR data->>'itemId' = ${id}`
}

// Exhaust the weekly comment base and bank one REPLY credit.
async function exhaustCommentsPlusOneCredit (userId) {
  await prisma.$executeRaw`
    UPDATE users SET "freeCommentCount" = 1, "freeCommentResetAt" = now() + interval '3 days'
    WHERE id = ${userId}::int`
  await prisma.$executeRaw`
    INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type")
    VALUES (${userId}::int, now_utc(), now_utc() + interval '2 days', 'REPLY')`
}

// Exhaust the monthly post base and bank one POST credit.
async function exhaustPostsPlusOneCredit (userId) {
  await prisma.$executeRaw`
    UPDATE users SET "freePostCount" = 1, "freePostResetAt" = now() + interval '3 days'
    WHERE id = ${userId}::int`
  await prisma.$executeRaw`
    INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type")
    VALUES (${userId}::int, now_utc(), now_utc() + interval '2 days', 'POST')`
}

async function createItemViaPay (userId, args) {
  const result = await pay(
    'ITEM_CREATE',
    { userId, text: '', ...args },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  const itemPayIn = await prisma.itemPayIn.findFirst({ where: { payInId: result.id } })
  const item = await prisma.item.findUnique({ where: { id: itemPayIn.itemId } })
  created.items.push(item.id)
  return { result, item }
}

afterAll(async () => {
  const itemIds = (await prisma.item.findMany({ where: { userId: { in: created.users } }, select: { id: true } })).map(r => r.id)
  for (const id of itemIds) await deleteJobsForItem(id)
  await prisma.reply.deleteMany({ where: { itemId: { in: itemIds } } })
  await prisma.reply.deleteMany({ where: { ancestorId: { in: itemIds } } })
  for (const id of itemIds) await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
  await prisma.streakReward.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.upload.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.item.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.payIn.deleteMany({ where: { userId: { in: created.users } } })
  for (const name of created.subs) {
    await prisma.userSubTrust.deleteMany({ where: { subName: name } }).catch(() => {})
    await prisma.subSubscription.deleteMany({ where: { subName: name } }).catch(() => {})
    await prisma.sub.deleteMany({ where: { name } }).catch(() => {})
  }
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } }).catch(() => {})
  if (feeConfigCreated) {
    await prisma.platformFeeConfig.delete({ where: { id: 1 } }).catch(() => {})
  }
  await prisma.$disconnect()
})

// --- 1. Sequential stockpile: one unspent unit must price exactly ONE
// upload-fee item free; the next is priced WITH the comment/post fee. ---

test('sequential stockpile (comment): the second upload-fee reply is priced WITH the comment fee', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  const authorId = await createUser()
  const parentId = await createRootPost(authorId)
  await exhaustCommentsPlusOneCredit(userId)

  // first submission: the unit is free -> priced upload-fee-only (0.001 XMR)
  const uploadA = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const { result, item } = await createItemViaPay(userId, {
    parentId: String(parentId),
    text: 'stockpile reply 1',
    uploadIds: [uploadA]
  })
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(1_000_000_000n)
  expect(item.feeStatus).toBe('PENDING_FEE')
  expect(item.feeQuotaEligible).toBe(true)

  // the pending item now HOLDS the unit: the next pricing must not see a slot.
  // (item_spam may escalate the charged leg 1.5x — strictly more than the
  // upload fee is the load-bearing assertion.)
  const uploadB = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const prospect2 = await getInitial(
    prisma,
    { parentId: String(parentId), text: 'stockpile reply 2', uploadIds: [uploadB] },
    { me: { id: userId } }
  )
  expect(moneroUriAmountPiconeros(prospect2.moneroUri)).toBeGreaterThan(1_000_000_000n)

  // committing the charged submission lands PENDING_FEE, NOT quota-eligible
  const { item: item2 } = await createItemViaPay(userId, {
    parentId: String(parentId),
    text: 'stockpile reply 2',
    uploadIds: [uploadB]
  })
  expect(item2.feeStatus).toBe('PENDING_FEE')
  expect(item2.feeQuotaEligible).toBe(false)

  // neither creation consumed the unit: base counter untouched, credit
  // unconsumed (both spends happen at the fee flips, which never ran here)
  const user = await prisma.user.findUnique({ where: { id: userId } })
  expect(user.freeCommentCount).toBe(1)
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: null } })).toBe(1)
})

test('sequential stockpile (post): the second upload-fee post is priced WITH the posting fee', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await exhaustPostsPlusOneCredit(userId)

  const uploadA = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const { result, item } = await createItemViaPay(userId, {
    title: 'stockpile post 1 ' + Date.now(),
    url: 'https://example.com/' + Date.now(),
    uploadIds: [uploadA],
    subNames: []
  })
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(1_000_000_000n)
  expect(item.feeStatus).toBe('PENDING_FEE')
  expect(item.feeQuotaEligible).toBe(true)

  const uploadB = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const prospect2 = await getInitial(
    prisma,
    {
      title: 'stockpile post 2 ' + Date.now(),
      url: 'https://example.com/' + Date.now(),
      uploadIds: [uploadB],
      subNames: []
    },
    { me: { id: userId } }
  )
  expect(moneroUriAmountPiconeros(prospect2.moneroUri)).toBeGreaterThan(1_000_000_000n)

  const { item: item2 } = await createItemViaPay(userId, {
    title: 'stockpile post 2 committed ' + Date.now(),
    url: 'https://example.com/' + Date.now(),
    uploadIds: [uploadB],
    subNames: []
  })
  expect(item2.feeStatus).toBe('PENDING_FEE')
  expect(item2.feeQuotaEligible).toBe(false)

  const user = await prisma.user.findUnique({ where: { id: userId } })
  expect(user.freePostCount).toBe(1)
  expect(await prisma.streakReward.count({ where: { userId, type: 'POST', consumedAt: null } })).toBe(1)
})

// --- 2. Abandonment releases the reservation ---

test('abandonment releases the held unit: pricing is upload-fee-only again', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  const authorId = await createUser()
  const parentId = await createRootPost(authorId)
  await exhaustCommentsPlusOneCredit(userId)

  const uploadA = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const { item } = await createItemViaPay(userId, {
    parentId: String(parentId),
    text: 'abandoned reply',
    uploadIds: [uploadA]
  })
  expect(item.feeQuotaEligible).toBe(true)

  // while pending, the unit is held: charged pricing
  const uploadB = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const heldProspect = await getInitial(
    prisma,
    { parentId: String(parentId), text: 'while held', uploadIds: [uploadB] },
    { me: { id: userId } }
  )
  expect(moneroUriAmountPiconeros(heldProspect.moneroUri)).toBeGreaterThan(1_000_000_000n)

  // age past the 1-day cutoff and run the real abandonment core
  await prisma.$executeRaw`UPDATE "Item" SET "created_at" = now() - interval '2 days' WHERE id = ${item.id}::int`
  const out = await runAbandonFeeItemsOnce({ models: prisma })
  expect(out.abandoned).toBe(1)
  const deleted = await prisma.item.findUnique({ where: { id: item.id } })
  expect(deleted.deletedAt).not.toBeNull()

  // the reservation is gone: upload-fee-only pricing again (the in-quota
  // upload branch never escalates, so the amount is exact)
  const uploadC = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const releasedProspect = await getInitial(
    prisma,
    { parentId: String(parentId), text: 'after release', uploadIds: [uploadC] },
    { me: { id: userId } }
  )
  expect(moneroUriAmountPiconeros(releasedProspect.moneroUri)).toBe(1_000_000_000n)
})

// --- 3. Flip: the unit is spent exactly once, then pricing is charged ---

test('flip spends the held unit exactly once; subsequent pricing is charged', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  const authorId = await createUser()
  const parentId = await createRootPost(authorId)
  await exhaustCommentsPlusOneCredit(userId)

  const uploadA = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const { result, item } = await createItemViaPay(userId, {
    parentId: String(parentId),
    text: 'flip reply',
    uploadIds: [uploadA]
  })
  expect(item.feeQuotaEligible).toBe(true)

  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })
  await flipPendingToLive(prisma, payInRow, 1_000_000_000n)

  const flipped = await prisma.item.findUnique({ where: { id: item.id } })
  expect(flipped.feeStatus).toBe('FEE_PAID')
  // the base was exhausted, so the flip consumed the banked REPLY credit —
  // exactly one spend, base counter untouched
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })).toBe(1)
  const user = await prisma.user.findUnique({ where: { id: userId } })
  expect(user.freeCommentCount).toBe(1)

  // a second flip is a no-op (the WHERE on PENDING_FEE matches nothing)
  await flipPendingToLive(prisma, payInRow, 1_000_000_000n)
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })).toBe(1)

  // unit spent AND reservation cleared: the next pricing is charged
  const uploadB = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const prospect2 = await getInitial(
    prisma,
    { parentId: String(parentId), text: 'after flip', uploadIds: [uploadB] },
    { me: { id: userId } }
  )
  expect(moneroUriAmountPiconeros(prospect2.moneroUri)).toBeGreaterThan(1_000_000_000n)
})

// --- 4. Concurrent double-submit: the loser is rejected BEFORE payment ---

test('concurrent double-submit: exactly one upload-fee reply reserves the unit; the loser leaves no item/payIn', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  const authorId = await createUser()
  const parentId = await createRootPost(authorId)
  await exhaustCommentsPlusOneCredit(userId)

  const uploadA = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const uploadB = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const argsA = { parentId: String(parentId), text: 'race reply A', uploadIds: [uploadA] }
  const argsB = { parentId: String(parentId), text: 'race reply B', uploadIds: [uploadB] }

  // deterministic rendezvous: hold BOTH getInitials until both have priced
  // (both see the single free unit), then release both begins into the
  // payer-row-lock race. The DB lock decides the winner; assertions are
  // order-agnostic.
  mockGate.armed = true
  mockGate.arrivals = 0
  mockGate.blocker = new Promise(resolve => { mockGate.resolve = resolve })
  let results
  try {
    results = await Promise.allSettled([
      pay('ITEM_CREATE', { userId, ...argsA }, { me: { id: userId } }),
      pay('ITEM_CREATE', { userId, ...argsB }, { me: { id: userId } })
    ])
  } finally {
    mockGate.armed = false
    mockGate.resolve()
  }

  const fulfilled = results.filter(r => r.status === 'fulfilled')
  const rejected = results.filter(r => r.status === 'rejected')
  expect(fulfilled).toHaveLength(1)
  expect(rejected).toHaveLength(1)
  expect(String(rejected[0].reason?.message)).toContain('no free comments left')

  // winner: exactly one item, PENDING_FEE, quota-eligible (it holds the unit)
  const items = await prisma.item.findMany({
    where: { userId },
    select: { id: true, feeStatus: true, feeQuotaEligible: true }
  })
  expect(items).toHaveLength(1)
  expect(items[0].feeStatus).toBe('PENDING_FEE')
  expect(items[0].feeQuotaEligible).toBe(true)

  // loser: rolled back before payment — only the winner's ITEM_CREATE payIn
  // and its MEDIA_UPLOAD beneficiary survive
  const payIns = await prisma.payIn.findMany({ where: { userId }, select: { payInType: true } })
  expect(payIns.map(p => p.payInType).sort()).toEqual(['ITEM_CREATE', 'MEDIA_UPLOAD'])

  // the unit is still only RESERVED, not spent: the credit is unconsumed and
  // neither upload was flipped paid
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: null } })).toBe(1)
  for (const uploadId of [uploadA, uploadB]) {
    const upload = await prisma.upload.findUnique({ where: { id: uploadId } })
    expect(upload.paid).toBe(false)
  }
})

// --- 5. Display consistency: the self-view reports the REDUCED left ---

test('postingFeePrivatesFor reflects the reservation (and its release) against the real DB', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await exhaustPostsPlusOneCredit(userId)

  const uploadA = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const { item } = await createItemViaPay(userId, {
    title: 'display post ' + Date.now(),
    url: 'https://example.com/' + Date.now(),
    uploadIds: [uploadA],
    subNames: []
  })
  expect(item.feeQuotaEligible).toBe(true)

  const user = await prisma.user.findUnique({ where: { id: userId } })
  const privates = await postingFeePrivatesFor(prisma, user, userId)
  // left is net of the held unit: nothing spendable, fee required
  expect(privates.freePostsLeft).toBe(0)
  expect(privates.postingFeeRequired).toBe(true)
  // raw inputs stay visible
  expect(privates.freePostCredits).toBe(1)
  expect(privates.freePostsQuota).toBe(1)

  // release (soft-delete) restores the display
  await prisma.item.update({ where: { id: item.id }, data: { deletedAt: new Date() } })
  const released = await postingFeePrivatesFor(prisma, user, userId)
  expect(released.freePostsLeft).toBe(1)
  expect(released.postingFeeRequired).toBe(false)
})

// --- 6. Guards: charged and owner-free upload items must NEVER throw ---

test('a charged upload-fee reply does not throw (the comment fee is already priced in)', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  const authorId = await createUser()
  const parentId = await createRootPost(authorId)
  // past quota, NO credits, NO reservations: left = 0 at pricing AND at onBegin
  await prisma.$executeRaw`
    UPDATE users SET "freeCommentCount" = 1, "freeCommentResetAt" = now() + interval '3 days'
    WHERE id = ${userId}::int`
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })

  const { result, item } = await createItemViaPay(userId, {
    parentId: String(parentId),
    text: 'charged reply',
    uploadIds: [uploadId]
  })
  // the comment fee rides the URI on top of the upload fee
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBeGreaterThan(1_000_000_000n)
  expect(item.feeStatus).toBe('PENDING_FEE')
  expect(item.feeQuotaEligible).toBe(false)
})

test('an owner-free upload post does not throw even with the quota exhausted', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  const turfName = `resv-owner-${userId}-${Date.now()}`
  await prisma.sub.create({
    data: { name: turfName, userId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] }
  })
  created.subs.push(turfName)
  await prisma.$executeRaw`
    UPDATE users SET "freePostCount" = 1, "freePostResetAt" = now() + interval '3 days'
    WHERE id = ${userId}::int`
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })

  const { result, item } = await createItemViaPay(userId, {
    title: 'owner-free upload post ' + Date.now(),
    url: 'https://example.com/' + Date.now(),
    uploadIds: [uploadId],
    subNames: [turfName]
  })
  expect(result.moneroUri).toMatch(/^monero:/) // the upload fee is still charged
  expect(item.feeStatus).toBe('PENDING_FEE')
  // the perk: owner-free items never consume quota (so never reserve one)
  expect(item.feeQuotaEligible).toBe(false)
})
