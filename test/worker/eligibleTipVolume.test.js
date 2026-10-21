/* eslint-env jest */

// Integration tests for computeEligibleTipVolume (dynamic curator budget spec
// §4). The volume T is computed from real Item/ObservedTip/UserSubTrust rows, so
// this mirrors test/worker/curatorShares.test.js: live migrated DB, per-test
// seeding, FK-safe teardown, and a residue purge keyed on this suite's own
// prefixes.
//
// Run via the app container:
//   docker exec -u apprunner app npx jest test/worker/eligibleTipVolume.test.js

import { PrismaClient } from '@prisma/client'
import { computeEligibleTipVolume } from '@/worker/eligibleTipVolume'
import { USER_ID } from '@/lib/constants'

const prisma = new PrismaClient()

const ADDR = '8' + '6'.repeat(94) // 95-char Monero address placeholder
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

// Every fixture this suite owns is prefixed: users `etv-`, posts `etv `, tips
// `etv-`, accounts labelled `etv-test`. The purge below deletes by STABLE
// patterns only, so a killed run cannot collide with the next run's seeding.
const TEST_TITLE_PREFIX = 'etv '
const TEST_USER_PREFIX = 'etv-'
const TEST_TX_PREFIX = 'etv-'
const TEST_ACCOUNT_LABEL = 'etv-test'

let account
let userSeq = 0
let tipSeq = 0
let windowSeq = 0
let createdSystemUsers = []

// Self-healing purge from a prior INTERRUPTED run (also the teardown). FK-safe
// order: tips -> item aggregates/items -> accounts -> trust rows -> users.
async function purgeOwnedFixtures () {
  await prisma.observedTip.deleteMany({ where: { txHash: { startsWith: TEST_TX_PREFIX } } })
  await prisma.$executeRaw`DELETE FROM "ItemUserAgg" WHERE "itemId" IN (SELECT id FROM "Item" WHERE title LIKE 'etv %')`
  await prisma.$executeRaw`DELETE FROM "Item" WHERE title LIKE 'etv %' AND "parentId" IS NOT NULL`
  await prisma.$executeRaw`DELETE FROM "Item" WHERE title LIKE 'etv %'`
  await prisma.moneroAccount.deleteMany({ where: { label: TEST_ACCOUNT_LABEL } })
  await prisma.$executeRaw`DELETE FROM "UserSubTrust" WHERE "userId" IN (SELECT id FROM users WHERE name LIKE 'etv-%')`
  await prisma.$executeRaw`DELETE FROM users WHERE name LIKE 'etv-%'`
}

beforeAll(async () => {
  await purgeOwnedFixtures()
  userSeq = 0
  tipSeq = 0
  windowSeq = 0
  createdSystemUsers = []
  account = await prisma.moneroAccount.create({
    data: {
      ownerUserId: null,
      address: ADDR,
      label: TEST_ACCOUNT_LABEL,
      network: 'STAGENET',
      status: 'ACTIVE'
    }
  })
})

afterAll(async () => {
  await purgeOwnedFixtures()
  if (createdSystemUsers.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdSystemUsers } } })
  }
  await prisma.$disconnect()
})

async function createUser () {
  userSeq += 1
  const rows = await prisma.$queryRaw`
    INSERT INTO users (name) VALUES (${`${TEST_USER_PREFIX}user-${userSeq}`})
    RETURNING id::int AS id`
  return rows[0].id
}

// The migration-seeded system users normally exist; only a truly created row
// is tracked for teardown.
async function ensureSystemUser (id) {
  const inserted = await prisma.$queryRaw`
    INSERT INTO users (id) VALUES (${id}) ON CONFLICT DO NOTHING RETURNING id::int AS id`
  if (inserted.length > 0) createdSystemUsers.push(id)
}

// Each test gets an isolated 24h window, 2 days apart, far from "now" and from
// every other test so fixtures cannot leak across assertions.
function testWindow () {
  const base = Date.UTC(2031, 0, 1) + windowSeq * 2 * DAY_MS
  windowSeq += 1
  return { start: new Date(base), end: new Date(base + DAY_MS), base }
}

async function createRootPost (userId, title, { subNames = [], createdAt, bio = false, deletedAt = null } = {}) {
  const created = createdAt ?? new Date()
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "weightedVotes", "subNames", "created_at", bio, "deletedAt")
    VALUES (${userId}::int, ${title}, 10::float, ${subNames}::citext[], ${created}, ${bio}, ${deletedAt})
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  return id
}

async function createComment (userId, rootId, title, { subNames = [], createdAt } = {}) {
  const created = createdAt ?? new Date()
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", "parentId", "rootId", title, "weightedVotes", "subNames", "created_at")
    VALUES (${userId}::int, ${rootId}::int, ${rootId}::int, ${title}, 10::float, ${subNames}::citext[], ${created})
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${`${rootId}.${id}`}::ltree WHERE id = ${id}::int`
  return id
}

async function seedTrust (userId, subName, { zapPostTrust = 0, zapCommentTrust = 0 } = {}) {
  await prisma.userSubTrust.create({
    data: { subName, userId, zapPostTrust, zapCommentTrust }
  })
}

async function seedTip ({
  postId,
  tipperId = null,
  piconeros,
  confirmedAt,
  rankPiconeros = null,
  state = 'CONFIRMED'
}) {
  tipSeq += 1
  const suffix = String(tipSeq).padStart(9, '0')
  return prisma.observedTip.create({
    data: {
      txHash: `${TEST_TX_PREFIX}${tipSeq}`,
      postId,
      tipperId,
      recipientAccountId: account.id,
      recipientMajor: 0,
      recipientMinor: 0,
      paymentId: `etvtest${suffix}`,
      piconeros,
      rankPiconeros,
      height: 3000,
      confirmations: 10,
      state,
      proofType: 'INDEXED',
      confirmedAt
    }
  })
}

function compute (window, overrides = {}) {
  return computeEligibleTipVolume(prisma, {
    periodStart: window.start,
    periodEnd: window.end,
    trustWeightFloor: 1.0,
    excludedCuratorIds: [USER_ID.stasher],
    capShareBps: 2500,
    ...overrides
  })
}

function bigintsAscending (values) {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

test('anonymous tips count in raw but never in eligible', async () => {
  const w = testWindow()
  const author = await createUser()
  const tipper = await createUser()
  const item = await createRootPost(author, `${TEST_TITLE_PREFIX}anonymous`, { createdAt: new Date(w.base - 10 * DAY_MS) })

  await seedTip({ postId: item, tipperId: null, piconeros: 500n, confirmedAt: new Date(w.base + HOUR_MS) })
  await seedTip({ postId: item, tipperId: tipper, piconeros: 700n, confirmedAt: new Date(w.base + 2 * HOUR_MS) })

  const result = await compute(w)

  expect(result.rawPiconeros).toBe(1200n)
  expect(result.stages).toEqual({
    raw: '1200',
    eligible: '700',
    afterExclusions: '700',
    ranked: '700',
    handicapped: '700',
    trusted: '700',
    capped: '0'
  })
  expect(Object.keys(result.stages)).toEqual([
    'raw', 'eligible', 'afterExclusions', 'ranked', 'handicapped', 'trusted', 'capped'
  ])
  expect(result.perTipper).toEqual([700n])
  expect(result.tipperCount).toBe(1)
  expect(result.cappedPiconeros).toBe(0n)
  expect(result.levelPiconeros).toBe(0n)
})

test('confirmed self-tips are excluded by the author guard; EXCLUDED rows are not raw', async () => {
  const w = testWindow()
  const author = await createUser()
  const other = await createUser()

  const selfItem = await createRootPost(author, `${TEST_TITLE_PREFIX}self confirmed`, { createdAt: new Date(w.base - 10 * DAY_MS) })
  const excludedSelfItem = await createRootPost(author, `${TEST_TITLE_PREFIX}self excluded`, { createdAt: new Date(w.base - 10 * DAY_MS) })

  await seedTip({ postId: selfItem, tipperId: author, piconeros: 900n, confirmedAt: new Date(w.base + HOUR_MS) })
  await seedTip({
    postId: excludedSelfItem,
    tipperId: author,
    piconeros: 300n,
    confirmedAt: new Date(w.base + 2 * HOUR_MS),
    state: 'EXCLUDED'
  })
  await seedTip({ postId: selfItem, tipperId: other, piconeros: 400n, confirmedAt: new Date(w.base + 3 * HOUR_MS) })

  const result = await compute(w)

  // raw sees the confirmed self-tip but not the EXCLUDED one; eligible drops
  // the self-tip too.
  expect(result.rawPiconeros).toBe(1300n)
  expect(result.stages.raw).toBe('1300')
  expect(result.stages.eligible).toBe('400')
  expect(result.stages.afterExclusions).toBe('400')
  expect(result.perTipper).toEqual([400n])
})

test('stasher and a configured excluded id disappear from afterExclusions onward', async () => {
  const w = testWindow()
  const author = await createUser()
  const excluded = await createUser()
  const normal = await createUser()
  const item = await createRootPost(author, `${TEST_TITLE_PREFIX}exclusions`, { createdAt: new Date(w.base - 10 * DAY_MS) })

  await seedTip({ postId: item, tipperId: USER_ID.stasher, piconeros: 3000n, confirmedAt: new Date(w.base + HOUR_MS) })
  await seedTip({ postId: item, tipperId: excluded, piconeros: 2000n, confirmedAt: new Date(w.base + 2 * HOUR_MS) })
  await seedTip({ postId: item, tipperId: normal, piconeros: 1000n, confirmedAt: new Date(w.base + 3 * HOUR_MS) })

  const result = await compute(w, { excludedCuratorIds: [USER_ID.stasher, excluded] })

  expect(result.stages.raw).toBe('6000')
  expect(result.stages.eligible).toBe('6000')
  expect(result.stages.afterExclusions).toBe('1000')
  expect(result.stages.ranked).toBe('1000')
  expect(result.stages.handicapped).toBe('1000')
  expect(result.stages.trusted).toBe('1000')
  expect(result.perTipper).toEqual([1000n])
  expect(result.tipperCount).toBe(1)
})

test('HANDICAP_NYMS accounts contribute at half weight and T tracks the capped level', async () => {
  const w = testWindow()
  await ensureSystemUser(USER_ID.sn)
  const author = await createUser()
  const normals = [await createUser(), await createUser(), await createUser()]
  const item = await createRootPost(author, `${TEST_TITLE_PREFIX}handicap`, { createdAt: new Date(w.base - 10 * DAY_MS) })

  await seedTip({ postId: item, tipperId: USER_ID.sn, piconeros: 1000n, confirmedAt: new Date(w.base + HOUR_MS) })
  for (let i = 0; i < normals.length; i++) {
    await seedTip({
      postId: item,
      tipperId: normals[i],
      piconeros: 1000n,
      confirmedAt: new Date(w.base + (i + 2) * HOUR_MS)
    })
  }

  const result = await compute(w)

  expect(result.stages.raw).toBe('4000')
  expect(result.stages.eligible).toBe('4000')
  expect(result.stages.afterExclusions).toBe('4000')
  expect(result.stages.ranked).toBe('4000')
  // sn is one of HANDICAP_NYMS: 1000 x 0.5 = 500, plus three full 1000s.
  expect(result.stages.handicapped).toBe('3500')
  expect(result.stages.trusted).toBe('3500')
  expect(bigintsAscending(result.perTipper)).toEqual([500n, 1000n, 1000n, 1000n])
  expect(result.tipperCount).toBe(4)
  // Hand-checked cap for x = [1000, 1000, 1000, 500]: L = 500, T = 3*500 + 500.
  expect(result.levelPiconeros).toBe(500n)
  expect(result.cappedPiconeros).toBe(2000n)
  expect(result.stages.capped).toBe('2000')
})

test('rankPiconeros is used when set and piconeros when NULL', async () => {
  const w = testWindow()
  const author = await createUser()
  const tippers = [await createUser(), await createUser(), await createUser(), await createUser()]
  const item = await createRootPost(author, `${TEST_TITLE_PREFIX}rank`, { createdAt: new Date(w.base - 10 * DAY_MS) })

  await seedTip({ postId: item, tipperId: tippers[0], piconeros: 1000n, rankPiconeros: 5000n, confirmedAt: new Date(w.base + HOUR_MS) })
  await seedTip({ postId: item, tipperId: tippers[1], piconeros: 2000n, rankPiconeros: null, confirmedAt: new Date(w.base + 2 * HOUR_MS) })
  await seedTip({ postId: item, tipperId: tippers[2], piconeros: 3000n, rankPiconeros: 3000n, confirmedAt: new Date(w.base + 3 * HOUR_MS) })
  await seedTip({ postId: item, tipperId: tippers[3], piconeros: 4000n, rankPiconeros: null, confirmedAt: new Date(w.base + 4 * HOUR_MS) })

  const result = await compute(w)

  expect(result.stages.raw).toBe('10000')
  expect(result.stages.eligible).toBe('10000')
  expect(result.stages.ranked).toBe('14000') // 5000 + 2000 + 3000 + 4000
  expect(bigintsAscending(result.perTipper)).toEqual([2000n, 3000n, 4000n, 5000n])
  expect(result.tipperCount).toBe(4)
})

test('trust floor 1.0 ignores trust; floor 0.25 uses post/comment trust in the item turf', async () => {
  const w = testWindow()
  const author = await createUser()
  const commentAuthor = await createUser()
  const trustedPostTipper = await createUser()
  const trustedCommentTipper = await createUser()
  const zeroTrustPostTipper = await createUser()
  const zeroTrustCommentTipper = await createUser()

  // Post A: bitcoin turf, post trust 1.0 (comment trust deliberately 0).
  const post = await createRootPost(author, `${TEST_TITLE_PREFIX}trust post`, {
    subNames: ['bitcoin'], createdAt: new Date(w.base - 10 * DAY_MS)
  })
  // Comment B: its own turf differs from the root turf. Only the ROOT turf
  // (monero) carries zapCommentTrust = 1; the own turf (bitcoin) row has 0.
  const root = await createRootPost(author, `${TEST_TITLE_PREFIX}trust root`, {
    subNames: ['monero'], createdAt: new Date(w.base - 10 * DAY_MS)
  })
  const comment = await createComment(commentAuthor, root, `${TEST_TITLE_PREFIX}trust comment`, {
    subNames: ['bitcoin'], createdAt: new Date(w.base - 10 * DAY_MS)
  })

  await seedTrust(trustedPostTipper, 'bitcoin', { zapPostTrust: 1, zapCommentTrust: 0 })
  await seedTrust(trustedCommentTipper, 'monero', { zapPostTrust: 0, zapCommentTrust: 1 })
  await seedTrust(trustedCommentTipper, 'bitcoin', { zapPostTrust: 0, zapCommentTrust: 0 })

  await seedTip({ postId: post, tipperId: trustedPostTipper, piconeros: 1000n, confirmedAt: new Date(w.base + HOUR_MS) })
  await seedTip({ postId: comment, tipperId: trustedCommentTipper, piconeros: 1000n, confirmedAt: new Date(w.base + 2 * HOUR_MS) })
  await seedTip({ postId: post, tipperId: zeroTrustPostTipper, piconeros: 1000n, confirmedAt: new Date(w.base + 3 * HOUR_MS) })
  await seedTip({ postId: comment, tipperId: zeroTrustCommentTipper, piconeros: 1000n, confirmedAt: new Date(w.base + 4 * HOUR_MS) })

  const full = await compute(w, { trustWeightFloor: 1.0 })
  // Floor 1.0 is exactly 1.0: no trust loss, exact per-tipper integer sums.
  expect(full.stages.trusted).toBe('4000')
  expect(full.stages.trusted).toBe(full.stages.handicapped)
  expect(bigintsAscending(full.perTipper)).toEqual([1000n, 1000n, 1000n, 1000n])
  expect(full.cappedPiconeros).toBe(4000n)

  const weighted = await compute(w, { trustWeightFloor: 0.25 })
  // A uses zapPostTrust (1.0) => 1000. B is a comment whose ROOT turf is
  // monero (zapCommentTrust 1.0) => 1000; own turf/bitcoin would give 250.
  // The two untrusted tippers floor to 0.25 x 1000 = 250 each.
  expect(weighted.stages.handicapped).toBe('4000')
  expect(weighted.stages.trusted).toBe('2500')
  expect(bigintsAscending(weighted.perTipper)).toEqual([250n, 250n, 1000n, 1000n])
  expect(weighted.tipperCount).toBe(4)
  // Hand-checked cap for x = [1000, 1000, 250, 250]: L = 250, T = 2*250 + 500.
  expect(weighted.levelPiconeros).toBe(250n)
  expect(weighted.cappedPiconeros).toBe(1000n)
})

test('window boundaries: periodStart included, periodEnd excluded, DETECTED ignored', async () => {
  const w = testWindow()
  const author = await createUser()
  const tippers = [await createUser(), await createUser(), await createUser(), await createUser()]
  const item = await createRootPost(author, `${TEST_TITLE_PREFIX}window`, { createdAt: new Date(w.base - 10 * DAY_MS) })

  await seedTip({ postId: item, tipperId: tippers[0], piconeros: 100n, confirmedAt: w.start })
  await seedTip({ postId: item, tipperId: tippers[1], piconeros: 200n, confirmedAt: w.end })
  await seedTip({ postId: item, tipperId: tippers[2], piconeros: 400n, confirmedAt: new Date(w.base + HOUR_MS), state: 'DETECTED' })
  await seedTip({ postId: item, tipperId: tippers[3], piconeros: 300n, confirmedAt: new Date(w.end.getTime() - 1) })

  const result = await compute(w)

  expect(result.rawPiconeros).toBe(400n)
  expect(result.stages.raw).toBe('400')
  expect(result.stages.eligible).toBe('400')
  expect(bigintsAscending(result.perTipper)).toEqual([100n, 300n])
  expect(result.tipperCount).toBe(2)
  expect(result.cappedPiconeros).toBe(0n) // fewer than 4 tippers
})

test('three tippers cap to zero', async () => {
  const w = testWindow()
  const author = await createUser()
  const tippers = [await createUser(), await createUser(), await createUser()]
  const item = await createRootPost(author, `${TEST_TITLE_PREFIX}cap three`, { createdAt: new Date(w.base - 10 * DAY_MS) })

  for (let i = 0; i < tippers.length; i++) {
    await seedTip({
      postId: item,
      tipperId: tippers[i],
      piconeros: 1000n,
      confirmedAt: new Date(w.base + (i + 1) * HOUR_MS)
    })
  }

  const result = await compute(w)

  expect(result.stages.trusted).toBe('3000')
  expect(result.perTipper).toEqual([1000n, 1000n, 1000n])
  expect(result.tipperCount).toBe(3)
  expect(result.levelPiconeros).toBe(0n)
  expect(result.cappedPiconeros).toBe(0n)
  expect(result.stages.capped).toBe('0')
})

test('five tippers with one whale cap at the hand-computed level', async () => {
  const w = testWindow()
  const author = await createUser()
  const whale = await createUser()
  const tippers = [await createUser(), await createUser(), await createUser(), await createUser()]
  const item = await createRootPost(author, `${TEST_TITLE_PREFIX}cap whale`, { createdAt: new Date(w.base - 10 * DAY_MS) })

  await seedTip({ postId: item, tipperId: whale, piconeros: 10_000n, confirmedAt: new Date(w.base + HOUR_MS) })
  for (let i = 0; i < tippers.length; i++) {
    await seedTip({
      postId: item,
      tipperId: tippers[i],
      piconeros: 1000n,
      confirmedAt: new Date(w.base + (i + 2) * HOUR_MS)
    })
  }

  const result = await compute(w)

  // x = [10000, 1000, 1000, 1000, 1000]; S = 14000.
  // k=1: R = 4000, L = floor(4000 * 2500 / 7500) = 1333 >= 1000.
  // T = 1*1333 + 4000 = 5333.
  expect(result.stages.trusted).toBe('14000')
  expect(bigintsAscending(result.perTipper)).toEqual([1000n, 1000n, 1000n, 1000n, 10_000n])
  expect(result.tipperCount).toBe(5)
  expect(result.levelPiconeros).toBe(1333n)
  expect(result.cappedPiconeros).toBe(5333n)
  expect(result.stages.capped).toBe('5333')
})

test('tips on items created before the period and on deleted/bio items still count', async () => {
  const w = testWindow()
  const author = await createUser()
  const tippers = [await createUser(), await createUser()]
  const oldItem = await createRootPost(author, `${TEST_TITLE_PREFIX}old item`, {
    createdAt: new Date(w.base - 100 * DAY_MS)
  })
  const deletedItem = await createRootPost(author, `${TEST_TITLE_PREFIX}deleted bio item`, {
    createdAt: new Date(w.base - 100 * DAY_MS),
    bio: true,
    deletedAt: new Date(w.base - 90 * DAY_MS)
  })

  await seedTip({ postId: oldItem, tipperId: tippers[0], piconeros: 1000n, confirmedAt: new Date(w.base + HOUR_MS) })
  await seedTip({ postId: deletedItem, tipperId: tippers[1], piconeros: 234n, confirmedAt: new Date(w.base + 2 * HOUR_MS) })

  const result = await compute(w)

  expect(result.rawPiconeros).toBe(1234n)
  expect(result.stages.eligible).toBe('1234')
  expect(result.stages.afterExclusions).toBe('1234')
  expect(result.stages.ranked).toBe('1234')
  expect(result.stages.trusted).toBe('1234')
  expect(bigintsAscending(result.perTipper)).toEqual([234n, 1000n])
})

test('an empty period is all zeroes', async () => {
  const w = testWindow()

  const result = await compute(w)

  expect(result.rawPiconeros).toBe(0n)
  expect(result.stages).toEqual({
    raw: '0',
    eligible: '0',
    afterExclusions: '0',
    ranked: '0',
    handicapped: '0',
    trusted: '0',
    capped: '0'
  })
  expect(result.perTipper).toEqual([])
  expect(result.tipperCount).toBe(0)
  expect(result.cappedPiconeros).toBe(0n)
  expect(result.levelPiconeros).toBe(0n)
})
