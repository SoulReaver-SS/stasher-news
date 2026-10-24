/* eslint-env jest */

// ITEM_UPDATE upload-fee regression (A-07). getInitial used to read
// `totalFeesMsats` off uploadFees (renamed to totalFeesPiconeros in Task 1),
// which crashed the prospect with piconeros: undefined. Now getInitial builds a
// POSTING-subaddress URI covering the upload fee and attaches a MEDIA_UPLOAD
// beneficiary (onPaid is a no-op; Upload.paid flips in rewardsWalletObserver's
// flipPendingToLive when the covering fee is observed). The fee only attaches
// when the item already has a paid ITEM_CREATE payIn; otherwise getInitial
// throws ('cannot increase item cost with unpaid invoice').
//
// ITEM_UPDATE result-payIn regression (edit-countdown bug). afterBegin used to
// attach the edit's own ITEM_UPDATE payIn to the result item
// (`{ ...result, payIn }`), and Item.payIn returns an attached payIn as-is. The
// upsertComment fragment caches that as Item:<id>.payIn, so use-can-edit.js
// anchored the client's 10-minute window on the edit while updateItem kept
// anchoring on the item's PAID ITEM_CREATE payIn — the UI showed a live
// countdown that the server refused ("item can no longer be edited"). The
// result item must keep the ITEM_CREATE payIn for ITEM_UPDATE payIns (upstream
// 59f9f8d5; stripped by c0043ef3).
//
// Deferred fee-bearing edits (Task 3, 2026-09-17). An ITEM_UPDATE that attaches
// uploads over 10MB quotes the upload fee on its moneroUri (piconeros stays 0n),
// so the payIn is born PAID and onBegin used to apply the edit immediately — a
// user could attach >10MB media and never pay by dismissing the QR. onBegin now
// stores such an edit in PendingItemUpdate (args + the item's pre-edit text) and
// rewardsWalletObserver.flipPendingToLive applies it when the covering fee is
// observed. A pending row whose item was deleted or edited again while the fee
// was in flight is dropped (the upload stays paid and is re-attachable); free
// edits still apply at onBegin.
//
// R10 turf-addition fees (2026-09-21; repost exemption 2026-09-26). An edit
// that ADDS non-owned turfs is priced at the BASE platform floor per added
// non-owned turf (reposts never carry the anti-spam escalation — the post
// already paid it at creation; the owner premium rides the owner-direct leg
// when the added set resolves to one walleted owner and no uploads are folded
// in) and is deferred until the covering fee is observed — the SAME
// PendingItemUpdate machinery as upload fees. The deferral gate covers both
// legs (moneroSubaddressMajor OR moneroPaymentId). Removals and owned-turf
// additions are free. Only top-level posts can carry subNames (the resolver
// strips comments/bios).
//
// Real-DB integration test (mirrors test/engine/payInItemCreate.test.js):
//   docker exec -u apprunner app npx jest test/engine/payInItemUpdate.test.js

import { expectPlatformFeeLeg } from '../../test/helpers/platformFeeRecipient'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import pay from '@/api/payIn/index'
import { getInitial } from '@/api/payIn/types/itemUpdate'
import { getItem } from '@/api/resolvers/item'
import { flipPendingToLive } from '@/worker/rewardsWalletObserver'
import { logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { applySubFeeReceipt } from '@/api/monero/subFeeObservation'
import { moneroUriAmountPiconeros } from '@/lib/format'

// itemUpdate.js statically imports @/lib/lexical/server/mentions (ESM-only
// mdast-util-from-markdown) and @/api/resolvers/item (getItem), neither of
// which getInitial exercises — stub both like payInItemCreate.test.js.
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../api/resolvers/item', () => ({
  __esModule: true,
  getItem: jest.fn()
}))
// Stub the fee-subaddress pool so getInitial never touches MoneroAccount /
// SubaddressIndex rows (deterministic; same stub as payInItemCreate.test.js).
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
// lwsClient stub so owner-leg edit fees register no real webhook (R10). The
// event id is a STRING because SubFeePidMap.webhookEventId is String? (the real
// lws returns a UUID); an Int here fails Prisma validation on the DB-backed path.
jest.mock('../../api/monero/lwsClient', () => ({
  __esModule: true, lwsClient: { addWebhook: jest.fn(async () => ({ event_id: '1' })) }
}))
// The observer's ITEM_UPDATE branch and applyPendingItemUpdate log/alert on
// drops and apply failures; mock both so the tests assert them directly and the
// output stays pristine.
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))
jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))
// The engine tests below drive pay('ITEM_UPDATE', ...), which imports the
// api/payIn/types barrel. Following payInItemCreate.test.js, the barrel is
// mocked to expose ONLY the real ITEM_UPDATE and MEDIA_UPLOAD modules (the spec
// must be relative; see the comment above on jest.mock vs the @/ alias).
// MEDIA_UPLOAD must be real too: the deferred tests attach uploads, which
// creates a MEDIA_UPLOAD beneficiary through pay().
jest.mock('../../api/payIn/types', () => {
  const itemUpdate = jest.requireActual('../../api/payIn/types/itemUpdate')
  const mediaUpload = jest.requireActual('../../api/payIn/types/mediaUpload')
  return { __esModule: true, default: { ITEM_UPDATE: itemUpdate, MEDIA_UPLOAD: mediaUpload } }
})

const prisma = new PrismaClient()

const created = { users: [], items: [], payIns: [], uploads: [], subs: [], accounts: [], subFeePids: [], tips: [] }

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

// stagenet primary (turfFeeRouting tests): valid base58+checksum, so
// makeIntegratedAddress can derive an integrated address.
const PRIMARY = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqY1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'

// Root post with a paid ITEM_CREATE payIn attached. Optional subNames seed the
// scalar column AND the ItemSub rows (the DB trigger keeps the scalar in sync).
async function createRootPost (userId, { subNames = [] } = {}) {
  const item = await prisma.item.create({
    data: {
      userId,
      title: 'upload-fee update test post',
      subNames,
      ...(subNames.length > 0
        ? { subs: { create: subNames.map(subName => ({ subName })) } }
        : {})
    }
  })
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(item.id)}::ltree WHERE id = ${item.id}::int`
  created.items.push(item.id)
  const payIn = await prisma.payIn.create({
    data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n }
  })
  created.payIns.push(payIn.id)
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  return { id: item.id, payInId: payIn.id }
}

async function createSub (ownerId, name, { postPremiumPiconeros = 0n } = {}) {
  await prisma.sub.create({
    data: { name, userId: ownerId, rankingType: 'WOT', billingType: 'ONCE', billingCost: 0, postPremiumPiconeros }
  })
  created.subs.push(name)
  return name
}

async function createUpload (userId, { size }) {
  const upload = await prisma.upload.create({ data: { userId, size, type: 'image/png' } })
  created.uploads.push(upload.id)
  return upload.id
}

// --- Monerowall freeze re-check on deferred apply (TOCTOU) fixtures ---
const WALL_ENABLED_AT = new Date('2026-09-20T00:00:00Z')
const WALL_TIP_TX_PREFIX = 'iu-wall-test-'

async function seedWall (itemId, { price = 1_000_000_000n } = {}) {
  await prisma.item.update({
    where: { id: itemId },
    data: {
      moneroWallPricePiconeros: price,
      moneroWallThresholdPiconeros: null,
      moneroWallEnabledAt: WALL_ENABLED_AT
    }
  })
}

// ObservedTip requires a MoneroAccount recipient (FK) and a unique txHash. The
// prefix marks the row as test residue, purged in afterAll before the item and
// account deletes (their FKs would otherwise silently block both).
async function seedObservedTip (postId, { detectedAt, state }) {
  const account = await prisma.moneroAccount.create({
    data: { address: `${WALL_TIP_TX_PREFIX}${randomUUID()}`, label: 'iu-wall-test', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(account.id)
  const tip = await prisma.observedTip.create({
    data: {
      txHash: `${WALL_TIP_TX_PREFIX}${randomUUID()}`,
      postId,
      recipientAccountId: account.id,
      paymentId: randomUUID(),
      piconeros: 1_000_000_000n,
      detectedAt,
      ...(state ? { state } : {})
    }
  })
  created.tips.push(tip.id)
}

// A fee-bearing (deferred) wall edit: the >10MB upload makes it quote a fee on
// its moneroUri, so onBegin stores it in PendingItemUpdate instead of applying.
async function deferredWallEdit (userId, itemId, wallArgs) {
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  getItem.mockResolvedValue({ id: itemId, payIn: null })
  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: 'walled edit', uploadIds: [uploadId], ...wallArgs },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  return result
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

// Delete pgboss jobs referencing an item so the worker never executes them
// against test rows (the edit path queues imgproxy; search triggers queue
// indexItem) — same cleanup as payInItemCreate.test.js.
async function deleteJobsForItem (itemId) {
  const id = String(itemId)
  await prisma.$executeRaw`
    DELETE FROM pgboss.job
    WHERE data->>'id' = ${id} OR data->>'itemId' = ${id}`
}

afterAll(async () => {
  for (const id of created.items) {
    await deleteJobsForItem(id)
  }
  // before the item/account deletes: ObservedTip's FKs would block them
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } }).catch(() => {})
  await prisma.observedSubFee.deleteMany({ where: { paymentId: { in: created.subFeePids } } }).catch(() => {})
  await prisma.subFeePidMap.deleteMany({ where: { paymentId: { in: created.subFeePids } } }).catch(() => {})
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } }).catch(() => {})
  await prisma.upload.deleteMany({ where: { id: { in: created.uploads } } }).catch(() => {})
  for (const id of created.items) {
    await prisma.item.deleteMany({ where: { id } }).catch(() => {})
  }
  await prisma.sub.deleteMany({ where: { name: { in: created.subs } } }).catch(() => {})
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } }).catch(() => {})
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } }).catch(() => {})
  if (feeConfigCreated) {
    await prisma.platformFeeConfig.delete({ where: { id: 1 } }).catch(() => {})
  }
  await prisma.$disconnect()
})

// --- A-07 regression: ITEM_UPDATE with uploads no longer crashes (totalFeesMsats bug) ---
test('getInitial builds an upload-fee URI for an item update adding a >10MB upload', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  const { id: itemId } = await createRootPost(userId) // has a paid ITEM_CREATE payIn
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const result = await getInitial(prisma, { id: String(itemId), uploadIds: [uploadId] }, { me: { id: userId } })
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(result.moneroUri).toContain('tx_amount=0.001') // upload fee only
  expect(result.beneficiaries?.some(b => b.payInType === 'MEDIA_UPLOAD')).toBe(true)
})

// --- edit-countdown regression: the result item must keep the ITEM_CREATE payIn ---
//
// Drives pay('ITEM_UPDATE', ...) end-to-end on a real DB. getItem is stubbed at
// the top of this file, so it returns the real ITEM_CREATE PayIn row exactly
// like the ITEM_CREATE-only SQL join in api/resolvers/item.js does. Before the
// fix, afterBegin overwrote result.payIn with the (free) edit's ITEM_UPDATE
// payIn; the client cached it and anchored the 10-minute edit countdown on the
// edit time while updateItem anchored on the create payIn's payInStateChangedAt.
test('pay("ITEM_UPDATE", ...) returns the ITEM_CREATE payIn on the result item, not the edit payIn', async () => {
  const userId = await createUser()
  const { id: itemId, payInId: createPayInId } = await createRootPost(userId)
  const createPayIn = await prisma.payIn.findUnique({ where: { id: createPayInId } })

  getItem.mockImplementationOnce(async () => ({ id: itemId, payIn: createPayIn }))

  const result = await pay('ITEM_UPDATE', { id: String(itemId), text: 'edited body' }, { me: { id: userId } })
  created.payIns.push(result.id)

  // the mutation's own payIn is the ITEM_UPDATE one...
  expect(result.payInType).toBe('ITEM_UPDATE')
  expect(result.payInState).toBe('PAID')
  expect(result.id).not.toBe(createPayInId)

  // ...but the result item must carry the item's PAID ITEM_CREATE payIn so the
  // client countdown and the server's updateItem window agree
  expect(result.result).toBeTruthy()
  expect(result.result.payIn).toBeTruthy()
  expect(result.result.payIn.payInType).toBe('ITEM_CREATE')
  expect(result.result.payIn.id).toBe(createPayInId)
  expect(result.result.payIn.payInState).toBe('PAID')
  expect(new Date(result.result.payIn.payInStateChangedAt).getTime()).toBe(new Date(createPayIn.payInStateChangedAt).getTime())

  // the edit itself landed
  const item = await prisma.item.findUnique({ where: { id: itemId } })
  expect(item.text).toBe('edited body')
})

// --- fee-edit deferral: nothing attaches until the covering fee is observed ---
test('a fee-bearing edit is deferred: item, text and uploads stay untouched', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: `edited ![](http://media.test/uploads/${uploadId})`, uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)

  expect(result.payInType).toBe('ITEM_UPDATE')
  expect(result.payInState).toBe('PAID')
  expect(result.moneroUri).toMatch(/^monero:/)

  const deferred = await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })
  expect(deferred).toBeTruthy()
  expect(deferred.itemId).toBe(itemId)
  expect(deferred.oldText).toBeNull() // createRootPost seeds no text

  const untouched = await prisma.item.findUnique({ where: { id: itemId } })
  expect(untouched.text).toBeNull()
  expect(await prisma.itemUpload.findFirst({ where: { itemId } })).toBeNull()
  expect((await prisma.upload.findUnique({ where: { id: uploadId } })).paid).toBe(false)
})

test('flipPendingToLive applies the deferred edit and marks the upload paid (idempotent)', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  const editedText = `edited with media ![](http://media.test/uploads/${uploadId})`
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: editedText, uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })

  await flipPendingToLive(prisma, payInRow, 1_000_000_000n)

  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBe(editedText)
  expect(await prisma.itemUpload.findFirst({ where: { itemId, uploadId } })).toBeTruthy()
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeNull()
  expect((await prisma.upload.findUnique({ where: { id: uploadId } })).paid).toBe(true)

  // a replayed observation must not apply anything a second time
  await flipPendingToLive(prisma, payInRow, 1_000_000_000n)
  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBe(editedText)
})

test('a deferred edit is dropped, not applied, when the item changed while the fee was in flight', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: 'deferred edit', uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })

  // a newer edit lands (e.g. a free typo fix) before the fee is observed
  await prisma.item.update({ where: { id: itemId }, data: { text: 'newer manual edit' } })

  await flipPendingToLive(prisma, payInRow, 1_000_000_000n)

  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBe('newer manual edit')
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeNull()
  // a dropped edit also drops its fee payIn (the pending row is consumed by the
  // claim, so the abandonment sweep would never reach it)
  expect(await prisma.payIn.findUnique({ where: { id: result.id } })).toBeNull()
  // the fee still counts: the upload is paid and can be re-attached for free
  expect((await prisma.upload.findUnique({ where: { id: uploadId } })).paid).toBe(true)
})

// --- M4: text-less deferred edits (reposts) must survive concurrent text drift ---
// repostItem's pay args carry NO text (a repost is a pure turf addition) and
// the apply merges turfs additively, so the stale-text guard — written for
// full-text payloads — must not drop a PAID repost when a free typo fix lands
// between the QR and the payment.
test('a text-less deferred repost applies despite concurrent text drift (M4)', async () => {
  const userId = await createUser()
  const owner = await createUser()
  await ensureFeeConfig()
  const { id: itemId } = await createRootPost(userId, { subNames: [] })
  const subName = `m4-${Date.now()}`
  await createSub(owner, subName)
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), userId, subNames: [subName] }, // repost shape: no text
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeTruthy()

  // the author fixes a typo in the free-edit window while the fee is in flight
  await prisma.item.update({ where: { id: itemId }, data: { text: 'typo fixed' } })

  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })
  await flipPendingToLive(prisma, payInRow, moneroUriAmountPiconeros(result.moneroUri))

  const liveItem = await prisma.item.findUnique({ where: { id: itemId } })
  expect(liveItem.text).toBe('typo fixed') // the newer words survive
  expect([...liveItem.subNames]).toEqual([subName]) // the paid turf lands anyway
  expect(await prisma.payIn.findUnique({ where: { id: result.id } })).toBeTruthy() // not dropped
})

// --- H1: an initiated-but-never-paid (EXPIRED) tip must not freeze the wall ---
// initiateTipCore mints a PENDING ObservedTip at initiation (detectedAt = now);
// reconcilePendingTips later flips it to EXPIRED. The freeze queries must only
// count tips that are pending (money possibly in flight) or landed — never a
// tip that expired unpaid.
test('a deferred wall edit applies its price delta when the only tip is EXPIRED (H1)', async () => {
  const userId = await createUser()
  await ensureFeeConfig()
  const { id: itemId } = await createRootPost(userId)
  await seedWall(itemId, { price: 1_000_000_000n })
  await seedObservedTip(itemId, { detectedAt: WALL_ENABLED_AT, state: 'EXPIRED' })

  const result = await deferredWallEdit(userId, itemId, { moneroWallPricePiconeros: 2_000_000_000n })

  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })
  await flipPendingToLive(prisma, payInRow, moneroUriAmountPiconeros(result.moneroUri))

  // the EXPIRED (abandoned) tip did not freeze: the paid price delta applies
  expect((await prisma.item.findUnique({ where: { id: itemId } })).moneroWallPricePiconeros).toBe(2_000_000_000n)
})

// The unused-image sweep can remove a deferred edit's unpaid upload before the
// fee lands (deleteUnusedImages now pins fee-due uploads with a live fee payIn,
// but manual/legacy deletions still happen). Attaching a missing upload would
// violate the ItemUpload FK and, uncaught, wedge the observer — the apply must
// drop the edit instead (pending row consumed, item untouched, alert raised).
test('a deferred edit whose upload vanished is dropped without an FK failure', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: 'deferred edit', uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })

  // the upload is gone before the fee lands
  await prisma.upload.delete({ where: { id: uploadId } })

  await expect(flipPendingToLive(prisma, payInRow, 1_000_000_000n)).resolves.toBeUndefined()

  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBeNull()
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeNull()
  // the dropped edit's fee payIn is deleted with it (see the stale-edit test)
  expect(await prisma.payIn.findUnique({ where: { id: result.id } })).toBeNull()
  expect(alert).toHaveBeenCalledWith(
    'warn',
    expect.stringContaining('uploads missing'),
    expect.stringContaining(String(result.id)),
    expect.objectContaining({ dedupeKey: expect.any(String) })
  )
})

// Any unexpected apply failure must not fail the observer run: the cursor only
// advances on a clean run, so a throw here would re-process the same tx on every
// retry (conflict path) and re-run this flip — freezing ALL fee attribution
// until manual intervention (the 2026-08-10 item-2755 incident class).
// flipPendingToLive must catch, log, alert, and let the run finish; the apply
// transaction rolls back and the pending edit survives for the abandonment purge.
test('an unexpected apply failure is contained by flipPendingToLive and does not wedge the observer', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: 'deferred edit', uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })

  // getItem is the last call of applyItemUpdate; rejecting it stands in for any
  // unexpected failure after the apply has begun
  getItem.mockRejectedValueOnce(new Error('boom'))

  await expect(flipPendingToLive(prisma, payInRow, 1_000_000_000n)).resolves.toBeUndefined()

  // the apply tx rolled back: nothing applied, the pending row survives
  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBeNull()
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeTruthy()
  expect(logError).toHaveBeenCalledWith(expect.stringContaining('ITEM_UPDATE failed'), expect.any(Error))
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.any(String),
    expect.stringContaining(String(result.id)),
    expect.objectContaining({ dedupeKey: expect.any(String) })
  )
})

// --- R10: turf-addition fees on edit ---
// Turf repost (2026-09-24): updateItem rejects any turf change, so repostItem
// is now the API entry point for these fees (one added turf per call). These
// tests drive pay('ITEM_UPDATE', ...) directly, exercising the engine's
// multi-add math, which remains as defense behind repostItem.

test('an edit adding 2 non-owned turfs defers and charges the BASE posting fee — no spam escalation on reposts (R10, 2026-09-26)', async () => {
  const userId = await createUser()
  const owner = await createUser()
  await ensureFeeConfig()
  const { id: itemId } = await createRootPost(userId, { subNames: [] })
  const subA = `r10-a-${Date.now()}`
  const subB = `r10-b-${Date.now()}`
  await createSub(owner, subA)
  await createSub(owner, subB)
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: 'now in two turfs', subNames: [subA, subB] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)

  // pricing: BASE platform floor x 2 (two non-owned turfs -> no single-owner
  // route), no owner leg, no spam escalation — reposts are exempt (2026-09-26)
  expect(result.moneroUri).toMatch(/^monero:/)
  const feeMap = await expectPlatformFeeLeg(prisma, result, 'POSTING')
  expect(feeMap.postId).toBe(itemId) // an edit binds its known item at issuance
  const config = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  const expected = config.postingFeeFloorPiconeros * 2n
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(expected)

  // deferred: turf list and text are NOT applied until the fee is observed
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeTruthy()
  const item = await prisma.item.findUnique({ where: { id: itemId } })
  expect(item.text).toBeNull()
  expect(item.subNames).toEqual([])

  // fee observed -> the edit applies and the turfs land
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })
  await flipPendingToLive(prisma, payInRow, expected)
  const liveItem = await prisma.item.findUnique({ where: { id: itemId } })
  expect(liveItem.text).toBe('now in two turfs')
  expect([...liveItem.subNames].sort()).toEqual([subA, subB].sort())
})

test('an edit adding exactly one non-owned walleted turf routes owner-direct and still defers (R10)', async () => {
  const userId = await createUser()
  const owner = await createUser()
  await ensureFeeConfig()
  const subName = `r10-owner-${Date.now()}`
  await createSub(owner, subName, { postPremiumPiconeros: 500_000_000n })
  const account = await prisma.moneroAccount.create({
    data: { ownerUserId: owner, address: PRIMARY, label: 'test-turf-owner', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(account.id)
  const { id: itemId } = await createRootPost(userId, { subNames: [] })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  process.env.TURF_OWNER_FEES = '1'
  let result
  try {
    result = await pay(
      'ITEM_UPDATE',
      { id: String(itemId), text: 'one wallet turf', subNames: [subName] },
      { me: { id: userId } }
    )
  } finally {
    delete process.env.TURF_OWNER_FEES
  }
  created.payIns.push(result.id)
  created.subFeePids.push(result.moneroPaymentId)

  expect(result.moneroPaymentId).toMatch(/^[0-9a-f]{16}$/)
  expect(result.moneroSubaddressMajor).toBeNull()
  // the R10 gate fix: owner-leg payIns carry moneroPaymentId, not a
  // subaddress — they must defer too, or the edit would apply before payment
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeTruthy()
  expect((await prisma.item.findUnique({ where: { id: itemId } })).subNames).toEqual([])

  // independently recompute the quote: BASE floor + the owner premium —
  // neither is ever escalated on the repost path (2026-09-26)
  const config = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  const expected = config.postingFeeFloorPiconeros + 500_000_000n
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(expected)

  // a chain-verified receipt opens the cumulative gate and applies the edit
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })
  await applySubFeeReceipt(prisma, {
    feePayIn: payInRow,
    paymentId: result.moneroPaymentId,
    txHash: randomUUID().replaceAll('-', ''),
    piconeros: expected,
    height: 1234,
    confirmations: 10
  })
  const liveItem = await prisma.item.findUnique({ where: { id: itemId } })
  expect(liveItem.text).toBe('one wallet turf')
  expect(liveItem.subNames).toEqual([subName])
})

test('removing turfs and adding owned turfs stay free and apply immediately (R10)', async () => {
  const userId = await createUser()
  const oldA = `r10-old-a-${Date.now()}`
  const oldB = `r10-old-b-${Date.now()}`
  const ownedNew = `r10-owned-${Date.now()}`
  await createSub(userId, oldA)
  await createSub(userId, oldB)
  await createSub(userId, ownedNew)
  const { id: itemId } = await createRootPost(userId, { subNames: [oldA, oldB] })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: 'swap', subNames: [ownedNew] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)

  expect(result.moneroUri).toBeNull()
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeNull()
  const item = await prisma.item.findUnique({ where: { id: itemId } })
  expect(item.text).toBe('swap')
  expect(item.subNames).toEqual([ownedNew])
})

test('a combined upload + turf-add edit quotes ONE platform URI covering both (R10)', async () => {
  const userId = await createUser()
  const owner = await createUser()
  await ensureFeeConfig()
  const subName = `r10-combined-${Date.now()}`
  await createSub(owner, subName)
  const { id: itemId } = await createRootPost(userId, { subNames: [] })
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: `x ![](http://media.test/uploads/${uploadId})`, uploadIds: [uploadId], subNames: [subName] },
    { me: { id: userId } }
  )
  created.payIns.push(result.id)

  // upload fees force the platform leg (no premium, no owner-direct)
  await expectPlatformFeeLeg(prisma, result, 'POSTING')
  const config = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  const expected = 1_000_000_000n + config.postingFeeFloorPiconeros
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(expected)
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeTruthy()
})

// --- turf-repost (2026-09-24) regression: concurrent deferred reposts ---
// repostItem snapshots subNames at initiation. Two reposts initiated while the
// item is [home] each store [home, A] and [home, B]; applyItemUpdate treats the
// deferred list as the authoritative full set and computes deletions as
// subsDiff(old, new), so paying A then B used to end with [home, B] — A's turf
// silently deleted after its fee was paid. applyPendingItemUpdate must merge the
// deferred list additively with the item's CURRENT subNames so both land.
test('two concurrent deferred reposts both land — a paid-for turf is never deleted', async () => {
  const userId = await createUser()
  const owner = await createUser()
  await ensureFeeConfig()
  const home = `turf-home-${Date.now()}`
  const subA = `turf-a-${Date.now()}`
  const subB = `turf-b-${Date.now()}`
  await createSub(userId, home) // the author's own turf: the item's starting turf
  await createSub(owner, subA)
  await createSub(owner, subB)
  const { id: itemId } = await createRootPost(userId, { subNames: [home] })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  // Two reposts initiated while the item is still [home] — each snapshots the
  // full list as [home, A] / [home, B] and defers (one non-owned turf each).
  const resultA = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), subNames: [home, subA] },
    { me: { id: userId } }
  )
  created.payIns.push(resultA.id)
  const resultB = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), subNames: [home, subB] },
    { me: { id: userId } }
  )
  created.payIns.push(resultB.id)

  // both are fee-bearing and deferred; nothing has landed yet
  expect(resultA.moneroUri).toMatch(/^monero:/)
  expect(resultB.moneroUri).toMatch(/^monero:/)
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: resultA.id } })).toBeTruthy()
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: resultB.id } })).toBeTruthy()
  expect((await prisma.item.findUnique({ where: { id: itemId } })).subNames).toEqual([home])

  // pay A then B
  const payInA = await prisma.payIn.findUnique({ where: { id: resultA.id } })
  const payInB = await prisma.payIn.findUnique({ where: { id: resultB.id } })
  await flipPendingToLive(prisma, payInA, moneroUriAmountPiconeros(resultA.moneroUri))
  await flipPendingToLive(prisma, payInB, moneroUriAmountPiconeros(resultB.moneroUri))

  // both paid-for turfs survive — A must not be deleted by B's stale full-set list
  const item = await prisma.item.findUnique({ where: { id: itemId } })
  expect([...item.subNames].sort()).toEqual([home, subA, subB].sort())
})

// --- Monerowall freeze re-check on deferred apply (TOCTOU) ---
//
// assertMoneroWallWrite freezes an active wall's X/T at REQUEST time. A
// fee-bearing edit is stored in PendingItemUpdate and applied later by
// flipPendingToLive, so a tip observed while its fee was in flight must also
// block the wall delta at apply time. The rest of the paid edit still applies
// (the fee must not be stranded).
test('a deferred wall edit applies an X/T change while the wall is unfrozen (control)', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  await seedWall(itemId)

  const result = await deferredWallEdit(userId, itemId, {
    moneroWallPricePiconeros: '2000000000',
    moneroWallThresholdPiconeros: null
  })
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })
  await flipPendingToLive(prisma, payInRow, 1_000_000_000n)

  const item = await prisma.item.findUnique({ where: { id: itemId } })
  expect(item.text).toBe('walled edit')
  expect(item.moneroWallPricePiconeros).toBe(2_000_000_000n)
})

test('a deferred wall edit strips the X/T change when a tip landed since the wall was enabled', async () => {
  const userId = await createUser()
  const { id: itemId } = await createRootPost(userId)
  await seedWall(itemId)

  const result = await deferredWallEdit(userId, itemId, {
    moneroWallPricePiconeros: 3_000_000_000n,
    moneroWallThresholdPiconeros: null
  })
  // the freeze marker lands while the fee is in flight: detectedAt >=
  // moneroWallEnabledAt (the resolver's query)
  await seedObservedTip(itemId, { detectedAt: WALL_ENABLED_AT })
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })
  await flipPendingToLive(prisma, payInRow, 1_000_000_000n)

  const item = await prisma.item.findUnique({ where: { id: itemId } })
  // the deferred edit still lands, minus the now-frozen wall delta
  expect(item.text).toBe('walled edit')
  expect(item.moneroWallPricePiconeros).toBe(1_000_000_000n)
  expect(item.moneroWallThresholdPiconeros).toBeNull()
  expect(await prisma.pendingItemUpdate.findUnique({ where: { payInId: result.id } })).toBeNull()
})

// --- M3 (2026-09-26 review): text-less updates must not wipe content-derived rows ---
// repostItem's args carry only id/userId/subNames. applyItemUpdate used to
// re-derive mentions/referrers/uploads from data.text (undefined → empty
// lists), so the set-difference deletes computed old − ∅ = ALL: every Mention,
// ItemMention (item reference), ItemUpload link, and pending bot job was
// destroyed on every paid repost (and on title-only edits, which also send no
// text). Text absent now means "text unchanged" — nothing is reconciled.
test('a text-less deferred repost preserves mentions, item references, uploads, and bot jobs (M3)', async () => {
  const userId = await createUser()
  const mentioned = await createUser()
  const owner = await createUser()
  await ensureFeeConfig()
  const { id: itemId } = await createRootPost(userId, { subNames: [] })

  // content-derived rows to protect: a @mention, an /items/ reference, an
  // attached upload, and a pending reminder job
  await prisma.mention.create({ data: { itemId, userId: mentioned } })
  const { id: refItemId } = await createRootPost(mentioned)
  await prisma.itemMention.create({ data: { referrerId: itemId, refereeId: refItemId } })
  const uploadId = await createUpload(userId, { size: 1024 })
  await prisma.itemUpload.create({ data: { itemId, uploadId } })
  await prisma.$executeRaw`
    INSERT INTO pgboss.job (id, name, data, state, startafter, keepuntil)
    VALUES (gen_random_uuid(), 'reminder', jsonb_build_object('itemId', ${itemId}::INTEGER, 'userId', ${userId}::INTEGER),
            'created', now() + interval '1 hour', now() + interval '2 hours')`

  const subName = `m3-${Date.now()}`
  await createSub(owner, subName)
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  const result = await pay(
    'ITEM_UPDATE',
    { id: String(itemId), userId, subNames: [subName] }, // repost shape: NO text
    { me: { id: userId } }
  )
  created.payIns.push(result.id)
  const payInRow = await prisma.payIn.findUnique({ where: { id: result.id } })
  await flipPendingToLive(prisma, payInRow, moneroUriAmountPiconeros(result.moneroUri))

  // the repost itself landed ...
  expect((await prisma.item.findUnique({ where: { id: itemId } })).subNames).toContain(subName)
  // ... and every content-derived row survived it
  expect(await prisma.mention.findFirst({ where: { itemId, userId: mentioned } })).toBeTruthy()
  expect(await prisma.itemMention.findFirst({ where: { referrerId: itemId, refereeId: refItemId } })).toBeTruthy()
  expect(await prisma.itemUpload.findFirst({ where: { itemId, uploadId } })).toBeTruthy()
  const [reminderJob] = await prisma.$queryRaw`
    SELECT 1 AS n FROM pgboss.job
    WHERE name = 'reminder' AND data->>'itemId' = ${itemId}::TEXT AND state = 'created'`
  expect(reminderJob).toBeTruthy()
})

// Text-bearing edits must keep reconciling: removing a mention by editing text
// deletes the row, and omitting uploadIds on a text edit detaches the uploads
// (updateItem derives uploadIds from the new text, so an edit whose text has no
// uploads sends []). Guards against over-correcting M3 into "never reconcile".
test('a text-bearing edit still reconciles mentions and uploads (M3 guardrail)', async () => {
  const userId = await createUser()
  const mentioned = await createUser()
  const { id: itemId } = await createRootPost(userId)
  await prisma.mention.create({ data: { itemId, userId: mentioned } })
  const uploadId = await createUpload(userId, { size: 1024 })
  await prisma.itemUpload.create({ data: { itemId, uploadId } })
  getItem.mockResolvedValue({ id: itemId, payIn: null })

  // free edit (no fee legs): applied immediately at onBegin
  await pay(
    'ITEM_UPDATE',
    { id: String(itemId), text: 'edited text with no mentions and no uploads' },
    { me: { id: userId } }
  )

  expect(await prisma.mention.findFirst({ where: { itemId, userId: mentioned } })).toBeNull()
  expect(await prisma.itemUpload.findFirst({ where: { itemId, uploadId } })).toBeNull()
  expect((await prisma.item.findUnique({ where: { id: itemId } })).text).toBe('edited text with no mentions and no uploads')
})
