/* eslint-env jest */

// ITEM_CREATE pgboss regression (Task 5 fix). pg-boss v9 dropped the DB-side
// default on pgboss.job.id (uuids are now minted by the JS client), so the raw
// INSERTs in itemCreate.onPaid (timestampItem + imgproxy) and in
// performBotBehavior (deleteItem + reminder) must supply gen_random_uuid().
// Before the fix these threw "null value in column \"id\" of relation \"job\""
// and rolled back the entire begin() tx. ITEM_CREATE is piconeros:0n -> payInState
// PAID, so begin() runs onPaid synchronously — i.e. posting crashed on submit.
//
// This is a real-DB integration test: it drives the actual onPaid and
// performBotBehavior code paths against a live migrated database and asserts the
// pgboss rows are genuinely created (a mock-based test could not prove the INSERT
// is accepted by the v9 schema, which is the whole point).
//
// Mirrors the real-DB style of test/engine/payInTerritoryCreate.test.js and
// test/worker/rewardsDistributor.test.js. Run via:
//   docker exec -u apprunner app npx jest test/engine/payInItemCreate.test.js

import { expectPlatformFeeLeg } from '../../test/helpers/platformFeeRecipient'
import { PrismaClient } from '@prisma/client'
import pay from '@/api/payIn/index'
import { onPaid, getInitial } from '@/api/payIn/types/itemCreate'
import { performBotBehavior, countNonOwnedSubs } from '@/api/payIn/lib/item'
import { flipPendingToLive } from '@/worker/rewardsWalletObserver'
import { USER_ID } from '@/lib/constants'
import { moneroUriAmountPiconeros } from '@/lib/format'

// Fee legs register an lws webhook at issuance; never reach the real lws.
jest.mock('../../api/monero/lwsClient', () => ({
  __esModule: true, lwsClient: { addWebhook: jest.fn(async () => ({ event_id: 'test-fee-hook' })) }
}))

// itemCreate.js statically imports @/lib/lexical/server/mentions (ESM-only
// mdast-util-from-markdown, which next/jest does not transform from node_modules)
// and @/api/resolvers/item (getItem — pulls the heavy lexical/html +
// page-metadata-parser chain). Neither is exercised by onPaid, so both are
// stubbed. Relative paths are used because next/jest registers no `@/*`
// moduleNameMapper, so jest.mock — unlike import — cannot resolve the `@/`
// alias as its first argument; jest still resolves both the `@/` import inside
// itemCreate.js and this relative spec to the same absolute path, so the mock
// intercepts the real import. babel-jest hoists these jest.mock calls above the
// ES imports above, so the stubs register before itemCreate.js is evaluated.
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
// reused in downZap.test.js).
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

// The engine test below drives `pay('ITEM_CREATE', ...)` end-to-end, which
// imports the api/payIn/types barrel. Following payInTerritoryCreate.test.js,
// the barrel is mocked to expose ONLY the real ITEM_CREATE and MEDIA_UPLOAD
// modules (MEDIA_UPLOAD must be present too: begin()/onPaid() recurse into
// beneficiaries through the barrel). The comments in payInTerritoryCreate.test.js
// explain why the path must be relative.
jest.mock('../../api/payIn/types', () => {
  const itemCreate = jest.requireActual('../../api/payIn/types/itemCreate')
  const mediaUpload = jest.requireActual('../../api/payIn/types/mediaUpload')
  return { __esModule: true, default: { ITEM_CREATE: itemCreate, MEDIA_UPLOAD: mediaUpload } }
})

const prisma = new PrismaClient()

// FK-safe teardown tracking. Item and PayIn cascade their ItemPayIn / Reminder
// children, so only the parents (items, payIns, users) plus the pgboss jobs we
// created need explicit cleanup.
const created = { users: [], items: [], payIns: [], reminderIds: [], uploads: [], subs: [] }

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

// Minimal root post (parentId null, freebie false) — enough for onPaid and
// performBotBehavior. path is set via a second statement (ltree is unsupported
// in Prisma create), exactly like test/worker/rewardsDistributor.test.js.
async function createRootPost (userId) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "created_at")
    VALUES (${userId}::int, ${'pgboss regression post'}, now())
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

// Delete pgboss jobs we inserted so the worker never executes them against test
// rows (imgproxy startafter is only +5s; this runs in milliseconds after commit).
async function deleteJobsForItem (itemId) {
  const id = String(itemId)
  await prisma.$executeRaw`
    DELETE FROM pgboss.job
    WHERE data->>'id' = ${id} OR data->>'itemId' = ${id}`
}

afterAll(async () => {
  // pgboss.jobs (no FKs) first, then Reminder rows, then parents.
  for (const id of created.items) {
    await deleteJobsForItem(id)
  }
  await prisma.reminder.deleteMany({ where: { id: { in: created.reminderIds } } }).catch(() => {})
  await prisma.upload.deleteMany({ where: { id: { in: created.uploads } } }).catch(() => {})
  for (const id of created.items) {
    await prisma.item.deleteMany({ where: { id } }).catch(() => {})
  }
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } }).catch(() => {})
  for (const name of created.subs) {
    // clean FK dependents first
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

// --- Fix 1: itemCreate.onPaid (timestampItem + imgproxy) ---
test('onPaid creates timestampItem + imgproxy pgboss jobs without throwing', async () => {
  const userId = await createUser()
  const itemId = await createRootPost(userId)
  const payIn = await prisma.payIn.create({
    data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n }
  })
  created.payIns.push(payIn.id)
  await prisma.itemPayIn.create({ data: { itemId, payInId: payIn.id } })

  // This is the regression: before the fix, the first raw INSERT here threw
  // "null value in column id" and rolled back the whole transaction.
  await prisma.$transaction(async tx => {
    await onPaid(tx, payIn.id)
  })

  const jobs = await prisma.$queryRaw`
    SELECT name FROM pgboss.job WHERE data->>'id' = ${String(itemId)}`
  // The restored search triggers (20260908000000_restore_search_index_triggers)
  // enqueue indexItem jobs on every Item insert/update — filter them out; this
  // regression is about timestampItem + imgproxy only.
  const names = jobs.map(r => r.name).filter(n => n !== 'indexItem').sort()
  expect(names).toEqual(['imgproxy', 'timestampItem'])
})

// --- Fix 2: performBotBehavior (deleteItem + reminder) ---
test('performBotBehavior creates deleteItem + reminder pgboss jobs for marked text', async () => {
  const userId = await createUser()
  const itemId = await createRootPost(userId)
  // both directives in one text block -> both INSERTs run
  const text = 'hello world @delete in 1 hour @remindme in 1 day'

  await prisma.$transaction(async tx => {
    await performBotBehavior(tx, { text, id: itemId, userId })
  })

  const deleteJobs = await prisma.$queryRaw`
    SELECT name FROM pgboss.job WHERE name = 'deleteItem' AND data->>'id' = ${String(itemId)}`
  expect(deleteJobs).toHaveLength(1)

  const remindJobs = await prisma.$queryRaw`
    SELECT name FROM pgboss.job WHERE name = 'reminder' AND data->>'itemId' = ${String(itemId)}`
  expect(remindJobs).toHaveLength(1)

  // performBotBehavior also writes a Reminder row alongside the pgboss job
  const reminder = await prisma.reminder.findFirst({ where: { itemId } })
  expect(reminder).toBeTruthy()
  created.reminderIds.push(reminder.id)
})

// --- Fix 3: comments are exempt from the posting-fee gate (spec §2.2, row 826) ---
test('getInitial returns a free prospect for comments — no fee subaddress draw', async () => {
  // No ensureFeeConfig() here: the comment early-return precedes any
  // PlatformFeeConfig read (and thus any feePool subaddress draw).
  const userId = await createUser()
  const result = await getInitial(prisma, { parentId: '999' }, { me: { id: userId } })
  expect(result).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })
  expect(result).not.toHaveProperty('moneroUri')
})

test('getInitial returns a posting-fee URI for low-rep post authors past their 1 free post', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`UPDATE users SET "freePostCount" = 1 WHERE id = ${userId}::int`
  const result = await getInitial(prisma, {}, { me: { id: userId } })
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.001')
  await expectPlatformFeeLeg(prisma, result, 'POSTING')
})

test('getInitial returns a free prospect for established users', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`
    UPDATE users SET "stackedPiconeros" = 10000000000, "created_at" = now() - interval '8 days'
    WHERE id = ${userId}::int`
  const result = await getInitial(prisma, {}, { me: { id: userId } })
  expect(result).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })
  expect(result).not.toHaveProperty('moneroUri')
})

// --- Task 4: established users past the 5/month free-post quota pay a posting fee ---
test('getInitial returns a posting-fee URI for established authors who exhausted their free-post quota', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`
    UPDATE users SET "stackedPiconeros" = 10000000000, "created_at" = now() - interval '8 days', "freePostCount" = 5
    WHERE id = ${userId}::int`
  const result = await getInitial(prisma, {}, { me: { id: userId } })
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.001')
  await expectPlatformFeeLeg(prisma, result, 'POSTING')
})

// --- Fix 4: comments beyond the daily freebie quota pay a flat comment fee ---
test('getInitial returns a comment-fee URI for authors past the freebie quota', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`
    UPDATE users SET "freeCommentCount" = 15
    WHERE id = ${userId}::int`
  const result = await getInitial(prisma, { parentId: '999' }, { me: { id: userId } })
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(600_000_000n)
  await expectPlatformFeeLeg(prisma, result, 'POSTING')
})

// --- anonymous comments pay the comment fee x ANON_COMMENT_FEE_MULTIPLIER ---
test('getInitial returns a x3 anon comment-fee URI for anonymous comments', async () => {
  await ensureFeeConfig()
  const result = await getInitial(prisma, { parentId: '999' }, { me: { id: USER_ID.anon } })
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(1_800_000_000n) // 0.0006 x 3
  await expectPlatformFeeLeg(prisma, result, 'POSTING')
})

// --- anonymous posts pay the flat fee x ANON_POST_FEE_MULTIPLIER ---
test('getInitial returns a x10 anon posting-fee URI for anonymous posts', async () => {
  await ensureFeeConfig()
  const result = await getInitial(prisma, {}, { me: { id: USER_ID.anon } })
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.01') // 0.001 x 10
  await expectPlatformFeeLeg(prisma, result, 'POSTING')
})

// --- A-05: 1.5x spam-fee escalation (item_spam) is applied server-side ---
test('getInitial escalates the posting fee x1.5 for a second root post within 10m', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`UPDATE users SET "freePostCount" = 1 WHERE id = ${userId}::int` // past the 1-post low-rep quota
  await createRootPost(userId) // 1 prior root post by this user -> item_spam(NULL, userId, '10m') = 1
  const result = await getInitial(prisma, {}, { me: { id: userId } })
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.0015') // 0.001 x 1.5^1
})

test('getInitial escalates the comment fee x1.5 for a repeat reply within 10m', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 15 WHERE id = ${userId}::int` // past quota
  // item_spam only counts replies whose tree root is NOT authored by the replier
  // (the fork never maintains Item.rootId, so the reply's rootId is set explicitly
  // here) -> root the thread under a second user.
  const otherUserId = await createUser()
  const parentId = await createRootPost(otherUserId)
  // 1 prior reply by this user to this parent -> item_spam(parentId, userId, '10m') = 1
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", "parentId", text, "rootId", "created_at")
    VALUES (${userId}::int, ${parentId}::int, ${'prior reply'}, ${parentId}::int, now())
    RETURNING id::int AS id`
  const replyId = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(parentId) + '.' + String(replyId)}::ltree WHERE id = ${replyId}::int`
  created.items.push(replyId)
  const result = await getInitial(prisma, { parentId: String(parentId) }, { me: { id: userId } })
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(900_000_000n) // 0.0006 x 1.5^1
})

// --- A-07: uploads over 10MB are charged on new posts ---
test('getInitial includes the upload fee in the posting-fee URI for a >10MB upload', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`UPDATE users SET "freePostCount" = 1 WHERE id = ${userId}::int` // past the 1-post low-rep quota
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 }) // >10MB -> 0.001 XMR
  const result = await getInitial(prisma, { uploadIds: [uploadId] }, { me: { id: userId } })
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.002') // 0.001 posting fee + 0.001 upload fee
  expect(result.beneficiaries?.some(b => b.payInType === 'MEDIA_UPLOAD')).toBe(true)
})

// --- A-07 follow-up: upload fees are proportional (0.001 per 10MB block) ---
test('getInitial folds a 30MB upload fee (0.003 XMR) into the posting-fee URI', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`UPDATE users SET "freePostCount" = 1 WHERE id = ${userId}::int` // past the 1-post low-rep quota
  const uploadId = await createUpload(userId, { size: 30 * 1024 * 1024 }) // 30MB -> 3 blocks -> 0.003 XMR
  const result = await getInitial(prisma, { uploadIds: [uploadId] }, { me: { id: userId } })
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.004') // 0.001 posting fee + 0.003 upload fee
  expect(result.beneficiaries?.some(b => b.payInType === 'MEDIA_UPLOAD')).toBe(true)
})

// --- End-to-end: a >10MB upload drives the full pay('ITEM_CREATE', ...) engine ---
//
// The other tests call getInitial() directly, which never reaches
// assertBalancedPayInAndPayOuts. That assert iterates the beneficiaries and
// reduces each beneficiary.payOutCustodialTokens — the MEDIA_UPLOAD beneficiary
// must keep the always-array contract (payOutCustodialTokens: []), or every
// upload-carrying pay() call crashes with
// "Cannot read properties of undefined (reading 'reduce')" and rolls back.
test('pay("ITEM_CREATE", { uploadIds }) completes without flipping the upload; the observed fee (flipPendingToLive) marks it paid', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  await prisma.$executeRaw`UPDATE users SET "freePostCount" = 1 WHERE id = ${userId}::int` // past the 1-post low-rep quota
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 }) // >10MB -> upload fee

  const result = await pay(
    'ITEM_CREATE',
    {
      userId,
      title: 'e2e upload fee post ' + Date.now(),
      url: 'https://example.com/' + Date.now(),
      text: '',
      uploadIds: [uploadId],
      subNames: []
    },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)

  // fork engine: piconeros 0n + monero fee URI -> the payIn is created PAID, and
  // the post itself is gated PENDING_FEE until the rewardsWalletObserver sees
  // the on-chain fee (the assert below documents what actually happens)
  expect(result.payInType).toBe('ITEM_CREATE')
  expect(result.payInState).toBe('PAID')
  expect(result.moneroUri).toMatch(/^monero:/)

  const beneficiary = result.beneficiaries.find(b => b.payInType === 'MEDIA_UPLOAD')
  expect(beneficiary).toBeTruthy()

  const beneficiaryPayIn = await prisma.payIn.findUnique({
    where: { id: beneficiary.id },
    include: { uploadPayIns: true }
  })
  expect(beneficiaryPayIn.payInState).toBe('PAID')
  expect(beneficiaryPayIn.piconeros).toBe(0n)
  // the MEDIA_UPLOAD beneficiary is associated to its benefactor payIn
  expect(beneficiaryPayIn.benefactorId).toBe(result.id)
  expect(beneficiaryPayIn.uploadPayIns).toHaveLength(1)
  expect(beneficiaryPayIn.uploadPayIns[0].uploadId).toBe(uploadId)

  const uploadPayIn = await prisma.uploadPayIn.findFirst({ where: { payInId: beneficiary.id, uploadId } })
  expect(uploadPayIn).toBeTruthy()

  // attaching must NOT flip the upload: MEDIA_UPLOAD.onPaid is a no-op, so a fee
  // that is never paid can never be exempted (dummy-post evasion). The flip only
  // happens when the rewardsWalletObserver observes the covering fee on-chain.
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } })
  expect(upload.paid).toBe(false)

  const itemPayIn = await prisma.itemPayIn.findFirst({ where: { payInId: result.id } })
  expect(itemPayIn).toBeTruthy()
  const item = await prisma.item.findUnique({ where: { id: itemPayIn.itemId } })
  created.items.push(item.id)
  expect(item.feeStatus).toBe('PENDING_FEE')
  expect(item.feePayInId).toBe(result.id)
  // past the quota: an over-quota item is never marked quota-eligible (R01)
  expect(item.feeQuotaEligible).toBe(false)

  // drive the observation-time flip: the observer sees the covering fee on the
  // rewards wallet (0.002 XMR = posting fee + upload fee) and flips the upload
  await flipPendingToLive(prisma, result, 2_000_000_000n)
  const flippedUpload = await prisma.upload.findUnique({ where: { id: uploadId } })
  expect(flippedUpload.paid).toBe(true)
  const liveItem = await prisma.item.findUnique({ where: { id: item.id } })
  expect(liveItem.feeStatus).toBe('FEE_PAID')
})

// --- R01: onBegin marks in-quota upload-fee items for flip-time quota consumption ---
//
// An in-quota author whose item's only on-chain cost is the >10MB upload fee is
// born PENDING_FEE (feeRequired), so the creation-time incrementFree* calls skip
// it. onBegin sets feeQuotaEligible and flipPendingToLive consumes the quota at
// the fee flip. Over-quota (pinned by the e2e above), owner-free, bio, and anon
// items are never marked.
describe('onBegin — feeQuotaEligible marker (R01)', () => {
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

  test('an in-quota established post carrying only the upload fee is marked', async () => {
    const userId = await createUser()
    await ensureFeeConfig()
    await prisma.$executeRaw`
      UPDATE users SET "stackedPiconeros" = 10000000000, "created_at" = now() - interval '8 days'
      WHERE id = ${userId}::int`
    const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
    const { result, item } = await createItemViaPay(userId, {
      title: 'r01 in-quota post ' + Date.now(),
      url: 'https://example.com/' + Date.now(),
      uploadIds: [uploadId],
      subNames: []
    })
    // the fee URI is the upload fee alone — the posting fee is waived by quota
    expect(result.moneroUri).toMatch(/^monero:/)
    expect(item.feeStatus).toBe('PENDING_FEE')
    expect(item.feeQuotaEligible).toBe(true)
  })

  test('an in-quota established comment carrying only the upload fee is marked', async () => {
    const authorId = await createUser()
    const userId = await createUser()
    await ensureFeeConfig()
    await prisma.$executeRaw`
      UPDATE users SET "stackedPiconeros" = 10000000000, "created_at" = now() - interval '8 days'
      WHERE id = ${userId}::int`
    const parentId = await createRootPost(authorId)
    const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
    const { result, item } = await createItemViaPay(userId, {
      parentId: String(parentId),
      text: 'r01 in-quota comment',
      uploadIds: [uploadId]
    })
    expect(result.moneroUri).toMatch(/^monero:/)
    expect(item.feeStatus).toBe('PENDING_FEE')
    expect(item.feeQuotaEligible).toBe(true)
  })

  test('an owner-free post with an upload is NOT marked (the perk already waives quota)', async () => {
    const userId = await createUser()
    await ensureFeeConfig()
    const turfName = `r01owner-${userId}-${Date.now()}`
    await prisma.sub.create({
      data: { name: turfName, userId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] }
    })
    created.subs.push(turfName)
    const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
    const { result, item } = await createItemViaPay(userId, {
      title: 'r01 owner-free post ' + Date.now(),
      url: 'https://example.com/' + Date.now(),
      uploadIds: [uploadId],
      subNames: [turfName]
    })
    expect(result.moneroUri).toMatch(/^monero:/) // the upload fee is still charged
    expect(item.feeStatus).toBe('PENDING_FEE')
    expect(item.feeQuotaEligible).toBe(false)
  })

  test('records the creation turf as primarySubName; comments stay null', async () => {
    const userId = await createUser()
    await ensureFeeConfig()
    const turfName = `home-${userId}-${Date.now()}`
    await prisma.sub.create({
      data: { name: turfName, userId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] }
    })
    created.subs.push(turfName)

    // owner posts in their own turf: free, so the item is live immediately
    const { item } = await createItemViaPay(userId, {
      title: 'home turf post ' + Date.now(),
      url: 'https://example.com/' + Date.now(),
      subNames: [turfName]
    })
    expect(item.primarySubName).toBe(turfName)

    // a fresh low-rep commenter has a freebie left: the comment is live too
    const rootId = await createRootPost(userId)
    const { item: comment } = await createItemViaPay(userId, {
      parentId: String(rootId),
      text: 'home turf comment'
    })
    expect(comment.parentId).toBe(rootId)
    expect(comment.primarySubName).toBeNull()
  })
})

// --- turf-owner free posting: countNonOwnedSubs scales the fee by non-owned turfs ---
describe('countNonOwnedSubs', () => {
  test('0 when the user owns all subs', () => {
    expect(countNonOwnedSubs([{ userId: 1 }, { userId: 1 }], 1)).toBe(0)
  })

  test('counts non-owned subs', () => {
    expect(countNonOwnedSubs([{ userId: 1 }, { userId: 2 }], 1)).toBe(1)
  })

  test('all subs count for anon (anon owns nothing)', () => {
    expect(countNonOwnedSubs([{ userId: 1 }, { userId: 2 }], USER_ID.anon)).toBe(2)
  })

  test('0 for empty subs', () => {
    expect(countNonOwnedSubs([], 1)).toBe(0)
  })
})

// --- turf-owner free posting: getInitial waives posting and comment fees ---
describe('getInitial — turf-owner fee waiver', () => {
  test('a low-rep owner posts free in their own turf even past their 1-post free quota', async () => {
    const userId = await createUser()
    await ensureFeeConfig()
    await prisma.$executeRaw`UPDATE users SET "freePostCount" = 1 WHERE id = ${userId}::int` // quota exhausted: owner-free waiver is what keeps this free
    const turfName = `ownerpost-${userId}-${Date.now()}`
    await prisma.sub.create({
      data: { name: turfName, userId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] }
    })
    created.subs.push(turfName)
    const result = await getInitial(prisma, { subNames: [turfName] }, { me: { id: userId } })
    expect(result).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })
    expect(result).not.toHaveProperty('moneroUri')
  })

  test('a low-rep owner comments free in their own turf even past the freebie quota', async () => {
    const userId = await createUser()
    await ensureFeeConfig()
    await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 15 WHERE id = ${userId}::int` // quota exhausted
    const turfName = `ownercomment-${userId}-${Date.now()}`
    await prisma.sub.create({
      data: { name: turfName, userId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] }
    })
    created.subs.push(turfName)
    // root post in the owned turf — the THREAD turf is what matters
    const rootRows = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", title, "created_at")
      VALUES (${userId}::int, ${'owner root for comment'}, now())
      RETURNING id::int AS id`
    const rootId = rootRows[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId)}::ltree WHERE id = ${rootId}::int`
    await prisma.itemSub.create({ data: { itemId: rootId, subName: turfName } })
    created.items.push(rootId)

    const result = await getInitial(prisma, { parentId: String(rootId) }, { me: { id: userId } })
    expect(result).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })
    expect(result).not.toHaveProperty('moneroUri')
  })

  test('a non-owner low-rep user still pays the posting fee in a turf they do not own', async () => {
    const ownerId = await createUser()
    const otherId = await createUser()
    await ensureFeeConfig()
    await prisma.$executeRaw`UPDATE users SET "freePostCount" = 1 WHERE id = ${otherId}::int` // past the 1-post low-rep quota
    const turfName = `notowner-${otherId}-${Date.now()}`
    await prisma.sub.create({
      data: { name: turfName, userId: ownerId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] }
    })
    created.subs.push(turfName)
    const result = await getInitial(prisma, { subNames: [turfName] }, { me: { id: otherId } })
    expect(result.piconeros).toBe(0n)
    expect(result.moneroUri).toMatch(/^monero:/)
    expect(result.moneroUri).toContain('tx_amount=0.001')
  })

  test('a mixed multi-turf post (1 owned + 1 non-owned) charges a single posting fee', async () => {
    const ownerId = await createUser()
    await ensureFeeConfig()
    await prisma.$executeRaw`UPDATE users SET "freePostCount" = 1 WHERE id = ${ownerId}::int` // past the 1-post low-rep quota
    const owned = `multi-owned-${ownerId}-${Date.now()}`
    const notOwned = `multi-other-${ownerId}-${Date.now()}`
    const otherId = await createUser()
    await prisma.sub.create({ data: { name: owned, userId: ownerId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    await prisma.sub.create({ data: { name: notOwned, userId: otherId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    created.subs.push(owned, notOwned)
    const result = await getInitial(prisma, { subNames: [owned, notOwned] }, { me: { id: ownerId } })
    expect(result.piconeros).toBe(0n)
    expect(result.moneroUri).toMatch(/^monero:/)
    expect(result.moneroUri).toContain('tx_amount=0.001')
  })

  test('a post to 2 non-owned turfs charges a double fee (0.002 XMR)', async () => {
    const userId = await createUser()
    const otherId = await createUser()
    await ensureFeeConfig()
    await prisma.$executeRaw`UPDATE users SET "freePostCount" = 1 WHERE id = ${userId}::int` // past the 1-post low-rep quota
    const a = `twofee-a-${userId}-${Date.now()}`
    const b = `twofee-b-${userId}-${Date.now()}`
    await prisma.sub.create({ data: { name: a, userId: otherId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    await prisma.sub.create({ data: { name: b, userId: otherId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    created.subs.push(a, b)
    const result = await getInitial(prisma, { subNames: [a, b] }, { me: { id: userId } })
    expect(result.moneroUri).toMatch(/^monero:/)
    expect(result.moneroUri).toContain('tx_amount=0.002')
  })

  test('an anon post to 2 turfs charges 0.02 XMR (0.001 x 2 turfs x 10 anon)', async () => {
    await ensureFeeConfig()
    const ownerId = await createUser()
    const a = `anon2-a-${Date.now()}`
    const b = `anon2-b-${Date.now()}`
    await prisma.sub.create({ data: { name: a, userId: ownerId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    await prisma.sub.create({ data: { name: b, userId: ownerId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    created.subs.push(a, b)
    const result = await getInitial(prisma, { subNames: [a, b] }, { me: { id: USER_ID.anon } })
    expect(result.moneroUri).toMatch(/^monero:/)
    expect(result.moneroUri).toContain('tx_amount=0.02')
  })

  test('a comment past quota in a 2-non-owned-turf thread charges the flat 0.0006 XMR fee', async () => {
    const userId = await createUser()
    const otherId = await createUser()
    await ensureFeeConfig()
    await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 15 WHERE id = ${userId}::int`
    const a = `cmte2-a-${userId}-${Date.now()}`
    const b = `cmte2-b-${userId}-${Date.now()}`
    await prisma.sub.create({ data: { name: a, userId: otherId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    await prisma.sub.create({ data: { name: b, userId: otherId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    created.subs.push(a, b)
    // root post in both turfs authored by otherId
    const rootRows = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", title, "created_at")
      VALUES (${otherId}::int, ${'two-turf root'}, now())
      RETURNING id::int AS id`
    const rootId = rootRows[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId)}::ltree WHERE id = ${rootId}::int`
    await prisma.itemSub.create({ data: { itemId: rootId, subName: a } })
    await prisma.itemSub.create({ data: { itemId: rootId, subName: b } })
    created.items.push(rootId)
    const result = await getInitial(prisma, { parentId: String(rootId) }, { me: { id: userId } })
    expect(result.moneroUri).toMatch(/^monero:/)
    expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(600_000_000n)
  })

  // --- the comment fee is flat: it never scales with the root post's turfs ---
  // (only top-level posts pay per non-owned turf; a replier's cost must not
  // depend on how many turfs the AUTHOR chose to post to)
  test('a comment past quota in a mixed (1 owned + 1 non-owned) turf thread charges the flat 0.0006 XMR fee', async () => {
    const ownerId = await createUser()
    const otherId = await createUser()
    await ensureFeeConfig()
    await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 15 WHERE id = ${ownerId}::int`
    const owned = `mixc-owned-${ownerId}-${Date.now()}`
    const notOwned = `mixc-other-${ownerId}-${Date.now()}`
    await prisma.sub.create({ data: { name: owned, userId: ownerId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    await prisma.sub.create({ data: { name: notOwned, userId: otherId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    created.subs.push(owned, notOwned)
    const rootRows = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", title, "created_at")
      VALUES (${otherId}::int, ${'mixed turf root'}, now())
      RETURNING id::int AS id`
    const rootId = rootRows[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId)}::ltree WHERE id = ${rootId}::int`
    await prisma.itemSub.create({ data: { itemId: rootId, subName: owned } })
    await prisma.itemSub.create({ data: { itemId: rootId, subName: notOwned } })
    created.items.push(rootId)
    const result = await getInitial(prisma, { parentId: String(rootId) }, { me: { id: ownerId } })
    expect(result.moneroUri).toMatch(/^monero:/)
    expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(600_000_000n)
  })

  test('an anon comment in a 2-non-owned-turf thread pays the flat 0.0018 XMR fee (x3 anon, no turf scaling)', async () => {
    await ensureFeeConfig()
    const otherId = await createUser()
    const a = `anonc-a-${Date.now()}`
    const b = `anonc-b-${Date.now()}`
    await prisma.sub.create({ data: { name: a, userId: otherId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    await prisma.sub.create({ data: { name: b, userId: otherId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    created.subs.push(a, b)
    const rootRows = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", title, "created_at")
      VALUES (${otherId}::int, ${'anon two-turf root'}, now())
      RETURNING id::int AS id`
    const rootId = rootRows[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId)}::ltree WHERE id = ${rootId}::int`
    await prisma.itemSub.create({ data: { itemId: rootId, subName: a } })
    await prisma.itemSub.create({ data: { itemId: rootId, subName: b } })
    created.items.push(rootId)
    const result = await getInitial(prisma, { parentId: String(rootId) }, { me: { id: USER_ID.anon } })
    expect(result.moneroUri).toMatch(/^monero:/)
    expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(1_800_000_000n) // 0.0006 x 3 anon — not x2 turfs
  })
})

// --- turf repost: comment fees pin to the root post's home turf ---
describe('getInitial — comments route on primarySubName', () => {
  // mirrors the R01 describe's createItemViaPay: drive the full pay() engine so
  // begin() -> onPaid runs synchronously (piconeros 0n -> PAID)
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

  // root authored by authorId: home turf = homeSubName, reposted into
  // extraSubName (two turfs, one home)
  async function createRepostedRoot (authorId, homeSubName, extraSubName) {
    const rootRows = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", title, "created_at", "primarySubName")
      VALUES (${authorId}::int, ${'reposted root'}, now(), ${homeSubName})
      RETURNING id::int AS id`
    const rootId = rootRows[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId)}::ltree WHERE id = ${rootId}::int`
    await prisma.itemSub.create({ data: { itemId: rootId, subName: homeSubName } })
    await prisma.itemSub.create({ data: { itemId: rootId, subName: extraSubName } })
    created.items.push(rootId)
    return rootId
  }

  test('owner-free reply keys on the home turf even when the root was reposted', async () => {
    const ownerId = await createUser()
    const otherId = await createUser()
    await ensureFeeConfig()
    await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 15 WHERE id = ${ownerId}::int` // quota exhausted
    const owned = `home-owned-${ownerId}-${Date.now()}`
    const other = `home-other-${ownerId}-${Date.now()}`
    await prisma.sub.create({ data: { name: owned, userId: ownerId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    await prisma.sub.create({ data: { name: other, userId: otherId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    created.subs.push(owned, other)

    const rootId = await createRepostedRoot(otherId, owned, other)

    // the home-turf owner replies past their free quota — free, despite the repost
    const result = await getInitial(prisma, { parentId: String(rootId) }, { me: { id: ownerId } })
    expect(result).toEqual({ payInType: 'ITEM_CREATE', userId: ownerId, piconeros: 0n })
    expect(result).not.toHaveProperty('moneroUri')
  })

  // onPaid regression: the free reply above must survive the full pay() engine.
  // onPaid re-derives ownership to decide quota consumption; under the legacy
  // all-root-turfs rule it saw ownerFree=false (owner owns 1 of 2 root turfs)
  // and ran incrementFreeCommentCount on the EXHAUSTED quota — its
  // `freeCommentCount: { lt: quota }` precondition matched 0 rows -> P2025 ->
  // 'no free comments left' -> begin() rolled back and the reply errored.
  test('an over-quota home-turf owner free-replies on a reposted root without an onPaid rollback', async () => {
    const ownerId = await createUser()
    const otherId = await createUser()
    await ensureFeeConfig()
    // quota exhausted INSIDE the current daily window (resetAt in the future):
    // this is the case where incrementFreeCommentCount's `lt: quota`
    // precondition matches 0 rows -> P2025 -> begin() rollback. (With a NULL
    // resetAt it would silently re-baseline the counter instead — the same
    // owner-free-perk violation, just quieter.)
    await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 15, "freeCommentResetAt" = now() + interval '1 day' WHERE id = ${ownerId}::int`
    const owned = `opaid-owned-${ownerId}-${Date.now()}`
    const other = `opaid-other-${ownerId}-${Date.now()}`
    await prisma.sub.create({ data: { name: owned, userId: ownerId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    await prisma.sub.create({ data: { name: other, userId: otherId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] } })
    created.subs.push(owned, other)

    const rootId = await createRepostedRoot(otherId, owned, other)

    // did not throw + item returned is the regression: under the legacy onPaid
    // rule pay() rejected with 'no free comments left'
    const { item } = await createItemViaPay(ownerId, {
      parentId: String(rootId),
      text: 'home owner reply on a reposted root'
    })
    expect(item.id).toBeTruthy()
    expect(item.parentId).toBe(rootId)
    expect(item.freebie).toBe(true)
    expect(item.feeStatus).toBe('FEE_NOT_REQUIRED')
    // the owner-free perk: the exhausted quota counter was left untouched
    const user = await prisma.user.findUnique({ where: { id: ownerId } })
    expect(user.freeCommentCount).toBe(15)
  })
})

// --- bios are free to create (first-bio creation goes through ITEM_CREATE) ---
describe('getInitial — bios', () => {
  test('a low-rep user creates their first bio free (no posting-fee URI)', async () => {
    const userId = await createUser()
    await ensureFeeConfig()
    const result = await getInitial(prisma, { bio: true, text: 'hello' }, { me: { id: userId } })
    expect(result).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })
    expect(result).not.toHaveProperty('moneroUri')
  })

  test('a bio with a >10MB upload charges the upload fee only, not the posting fee', async () => {
    const userId = await createUser()
    await ensureFeeConfig()
    const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 }) // >10MB -> 0.001 XMR upload fee
    const result = await getInitial(prisma, { bio: true, text: 'hello', uploadIds: [uploadId] }, { me: { id: userId } })
    expect(result.piconeros).toBe(0n)
    expect(result.moneroUri).toMatch(/^monero:/)
    expect(result.moneroUri).toContain('tx_amount=0.001') // upload fee only — no posting fee on top
    expect(result.beneficiaries?.some(b => b.payInType === 'MEDIA_UPLOAD')).toBe(true)
  })
})

// --- turf-owner free posting: owner-free items do not consume the freebie quota ---
describe('onPaid — turf-owner quota skip', () => {
  test('an owner-free comment does not increment freeCommentCount', async () => {
    const userId = await createUser()
    await ensureFeeConfig()
    // give the owner a turf and a root post in it
    const turfName = `quota-comment-${userId}-${Date.now()}`
    await prisma.sub.create({
      data: { name: turfName, userId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] }
    })
    created.subs.push(turfName)
    const rootRows = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", title, "created_at")
      VALUES (${userId}::int, ${'quota root'}, now())
      RETURNING id::int AS id`
    const rootId = rootRows[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId)}::ltree WHERE id = ${rootId}::int`
    await prisma.itemSub.create({ data: { itemId: rootId, subName: turfName } })
    created.items.push(rootId)

    // build the comment item directly (freebie, in the owned turf), a PAID PayIn,
    // and the ItemPayIn link — then drive onPaid.
    const commentRows = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", "parentId", "rootId", text, freebie, "feeStatus", "created_at")
      VALUES (${userId}::int, ${rootId}::int, ${rootId}::int, ${'owner comment'}, true, 'FEE_NOT_REQUIRED', now())
      RETURNING id::int AS id`
    const commentId = commentRows[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId) + '.' + String(commentId)}::ltree WHERE id = ${commentId}::int`
    created.items.push(commentId)

    const payIn = await prisma.payIn.create({
      data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n }
    })
    created.payIns.push(payIn.id)
    await prisma.itemPayIn.create({ data: { itemId: commentId, payInId: payIn.id } })

    await prisma.$transaction(async tx => {
      await onPaid(tx, payIn.id)
    })

    const user = await prisma.user.findUnique({ where: { id: userId } })
    expect(user.freeCommentCount ?? 0).toBe(0)
  })

  test('an owner-free post does not increment freePostCount', async () => {
    const userId = await createUser()
    await ensureFeeConfig()
    // established user so the free-post counter would otherwise increment
    await prisma.$executeRaw`
      UPDATE users SET "stackedPiconeros" = 10000000000, "created_at" = now() - interval '8 days'
      WHERE id = ${userId}::int`
    const turfName = `quota-post-${userId}-${Date.now()}`
    await prisma.sub.create({
      data: { name: turfName, userId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postTypes: ['LINK'] }
    })
    created.subs.push(turfName)

    // free top-level post in the owned turf (feeStatus FEE_NOT_REQUIRED, not freebie)
    const postRows = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", title, freebie, "feeStatus", "created_at")
      VALUES (${userId}::int, ${'owner post'}, false, 'FEE_NOT_REQUIRED', now())
      RETURNING id::int AS id`
    const postId = postRows[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(postId)}::ltree WHERE id = ${postId}::int`
    await prisma.itemSub.create({ data: { itemId: postId, subName: turfName } })
    created.items.push(postId)

    const payIn = await prisma.payIn.create({
      data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n }
    })
    created.payIns.push(payIn.id)
    await prisma.itemPayIn.create({ data: { itemId: postId, payInId: payIn.id } })

    await prisma.$transaction(async tx => {
      await onPaid(tx, payIn.id)
    })

    const user = await prisma.user.findUnique({ where: { id: userId } })
    expect(user.freePostCount ?? 0).toBe(0)
  })
})

// --- PENDING_FEE comments must NOT denormalize into their ancestors at onPaid ---
describe('onPaid — comment denormalization timing', () => {
  async function createCommentFixture (userId, feeStatus) {
    const rootRows = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", title, "created_at")
      VALUES (${userId}::int, ${'denorm root'}, now())
      RETURNING id::int AS id`
    const rootId = rootRows[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId)}::ltree WHERE id = ${rootId}::int`
    const commentRows = await prisma.$queryRaw`
      INSERT INTO "Item" ("userId", "parentId", "rootId", text, freebie, "feeStatus", "created_at")
      VALUES (${userId}::int, ${rootId}::int, ${rootId}::int, ${'denorm comment'}, ${feeStatus === 'FEE_NOT_REQUIRED'}, ${feeStatus}::"ItemFeeStatus", now())
      RETURNING id::int AS id`
    const commentId = commentRows[0].id
    await prisma.$executeRaw`UPDATE "Item" SET path = ${String(rootId) + '.' + String(commentId)}::ltree WHERE id = ${commentId}::int`
    created.items.push(rootId, commentId)
    const payIn = await prisma.payIn.create({
      data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n }
    })
    created.payIns.push(payIn.id)
    await prisma.itemPayIn.create({ data: { itemId: commentId, payInId: payIn.id } })
    return { rootId, commentId, payInId: payIn.id }
  }

  async function replyCount (itemId) {
    const rows = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "Reply" WHERE "itemId" = ${itemId}::int`
    return rows[0].n
  }

  test('a FEE_NOT_REQUIRED comment denormalizes ancestors + Reply rows at onPaid', async () => {
    const userId = await createUser()
    const { rootId, commentId, payInId } = await createCommentFixture(userId, 'FEE_NOT_REQUIRED')
    await prisma.$transaction(async tx => { await onPaid(tx, payInId) })
    const root = await prisma.item.findUnique({ where: { id: rootId } })
    expect(root.ncomments).toBe(1)
    expect(root.nDirectComments).toBe(1)
    expect(await replyCount(commentId)).toBe(1)
  })

  test('a PENDING_FEE comment does NOT denormalize at onPaid (that happens at the fee flip)', async () => {
    const userId = await createUser()
    const { rootId, commentId, payInId } = await createCommentFixture(userId, 'PENDING_FEE')
    await prisma.$transaction(async tx => { await onPaid(tx, payInId) })
    const root = await prisma.item.findUnique({ where: { id: rootId } })
    expect(root.ncomments).toBe(0)
    expect(root.nDirectComments).toBe(0)
    expect(await replyCount(commentId)).toBe(0)
  })
})

// --- finding 6: a stale free-reply prospect cannot double-spend one banked
// REPLY credit. getInitial prices BEFORE payIn's payer row lock, so two
// requests can both see the last credit and both price themselves free; the
// locked onPaid consumption must fail closed for the loser and roll its item
// and payIn back. ---
describe('reply quota — stale prospects cannot double-spend a banked REPLY credit', () => {
  function deferred () {
    let resolve
    const promise = new Promise(_resolve => { resolve = _resolve })
    return { promise, resolve }
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  test('two concurrent free replies priced off one banked REPLY credit: exactly one commits, the loser rolls back', async () => {
    const authorId = await createUser()
    const userId = await createUser()
    await ensureFeeConfig()
    const rootId = await createRootPost(authorId)
    // weekly base exhausted, exactly one banked REPLY credit
    await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1, "freeCommentResetAt" = now() + interval '1 day' WHERE id = ${userId}::int`
    await prisma.$executeRaw`INSERT INTO "StreakReward" ("userId", "grantedAt", "expiresAt", "type") VALUES (${userId}::int, now_utc(), now_utc() + interval '2 days', 'REPLY')`

    // Hold the payer row lock on a separate connection so BOTH pay() calls
    // finish getInitial (both see the credit and price free) before either
    // begin() can spend it — deterministic stale-prospect interleaving, not a
    // timing race. Reads are not blocked by the row lock; consumption is.
    const holder = new PrismaClient()
    const locked = deferred()
    const release = deferred()
    const holding = holder.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::int FOR NO KEY UPDATE`
      locked.resolve()
      await release.promise
    }, { timeout: 15000 })
    await locked.promise

    let settled = 0
    const track = p => { p.then(() => { settled++ }, () => { settled++ }); return p }
    const p1 = track(pay('ITEM_CREATE', { userId, parentId: String(rootId), text: 'race reply one' }, { me: { id: userId } }))
    const p2 = track(pay('ITEM_CREATE', { userId, parentId: String(rootId), text: 'race reply two' }, { me: { id: userId } }))
    // both are blocked inside begin() by now: priced, nothing spent
    await sleep(1000)
    expect(settled).toBe(0)

    release.resolve()
    await holding
    const results = await Promise.allSettled([p1, p2])
    try {
      const fulfilled = results.filter(r => r.status === 'fulfilled')
      const rejected = results.filter(r => r.status === 'rejected')

      // track whatever committed BEFORE asserting so cleanup survives a RED run
      const replies = await prisma.item.findMany({ where: { userId, parentId: rootId } })
      for (const reply of replies) created.items.push(reply.id)
      for (const r of fulfilled) created.payIns.push(r.value.id)

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(String(rejected[0].reason.message)).toContain('no free comments left')

      // exactly one reply committed; the loser's item + payIn rolled back
      expect(replies).toHaveLength(1)
      expect(replies[0].freebie).toBe(true)
      expect(replies[0].feeStatus).toBe('FEE_NOT_REQUIRED')

      // the single credit was spent exactly once; the exhausted base is untouched
      expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: { not: null } } })).toBe(1)
      const user = await prisma.user.findUnique({ where: { id: userId } })
      expect(user.freeCommentCount).toBe(1)
    } finally {
      await holder.$disconnect()
    }
  })
})
