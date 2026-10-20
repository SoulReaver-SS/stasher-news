/* eslint-env jest */

// Integration test for computeCuratorShares (Phase 4 Task 7 / spec §5).
//
// computeCuratorShares ports SN's worker/earn.js reward-share CTE to StasherNews:
// it reads confirmed ObservedTip rows (P2P Monero tips) instead of legacy PayIn
// ZAPs, ranks the tipped items by weightedVotes-weightedDownVotes, and apportions
// a weekly rewards pool (piconeros) to the curators (tippers) of top content.
// Sub-minPayout shares are excluded and roll over (not redistributed); topN caps
// the number of recipients.
//
// The SQL needs real Item/User/ObservedTip rows, so this is a real-DB integration
// test mirroring test/worker/confirmFinalizer.test.js (live migrated database,
// per-test seeding, FK-safe teardown).
//
// Run via the app container:
//   docker exec -u apprunner app npx jest test/worker/curatorShares.test.js

import { PrismaClient } from '@prisma/client'
import { computeCuratorShares, effectiveTrustWeightFloor, sanitizeExcludedCuratorIds } from '@/worker/curatorShares'
import { USER_ID } from '@/lib/constants'
import { logError } from '@/lib/logger'

jest.mock(`${process.cwd()}/lib/logger`, () => ({ logError: jest.fn() }))

const prisma = new PrismaClient()

const ADDR = '7' + '4'.repeat(94) // 95-char Monero address placeholder

// Every deterministic item title this suite seeds. The interruption-residue
// purge below deletes by these titles, so a killed run cannot leave fixtures
// that collide with the next run's seeding.
const TEST_POST_TITLES = [
  'top post',
  'mid post',
  'low post',
  'normal handicap control post',
  'staff handicapped post',
  'trust weighted post one',
  'trust weighted post two',
  'founder excluded post',
  'founder excluded control post',
  'founder excluded topn post',
  'founder excluded topn control one',
  'founder excluded only post',
  'configured excluded post',
  'configured excluded control post',
  'configured excluded topn post',
  'configured excluded topn control post',
  'configured excluded only post',
  'configured excluded empty post',
  'configured excluded empty control post',
  'configured excluded junk post',
  'configured excluded junk control post',
  'configured excluded comment root',
  'configured excluded comment target',
  'configured excluded comment control'
]

// Tracks every row created across tests so afterAll can tear them down in
// FK-safe order: ObservedTip -> Item -> MoneroAccount -> users.
const created = { users: [], items: [], accounts: [], tips: [], trustRows: [] }

// The shared seed: 3 ranked root posts + 4 tippers (3 heavy, 1 dust). The dust
// tipper (D) tips just above the ZAP_THRESHOLD on the lowest-ranked post, so its
// computed share falls below minPayout and rolls over.
let seed
const POOL = 10_000_000_000n // 1e10 piconeros (~0.00001 XMR-scale test pool)
let periodStart, periodEnd

// Self-healing purge of residue from a prior INTERRUPTED run of this test
// (mirrors rewardsDistributor.test.js's purgePriorResidue). afterAll deletes by
// the in-memory `created` lists, which are empty/incomplete if the process was
// killed, a parallel suite's teardown raced, or beforeAll threw after partial
// seeding. The orphaned deterministic fixtures (cs% tips, 7-then-94-fours
// accounts, titled posts) then collide with the next run's seeding on the
// (address, network) / (txHash) unique keys. Deletes by STABLE patterns only;
// idempotent on a fresh DB. User 616 (real seed user `stasher`) is never deleted.
async function purgePriorResidue () {
  const priorTips = await prisma.observedTip.findMany({
    where: { txHash: { startsWith: 'cs' }, paymentId: { startsWith: 'cstest' } },
    select: { tipperId: true, postId: true }
  })
  const tipperIds = [...new Set(priorTips.map(t => t.tipperId).filter(Boolean))]
  const testPostIds = [...new Set(priorTips.map(t => t.postId).filter(Boolean))]
  const priorAuthorIds = (await prisma.item.findMany({
    where: { title: { in: TEST_POST_TITLES } },
    select: { userId: true }
  })).map(i => i.userId)
  const testUserIds = [...new Set([...tipperIds, ...priorAuthorIds])].filter(id => id !== HANDICAP_USER_ID && id !== USER_ID.stasher)

  // FK-safe order: tips -> item aggregates/items -> accounts -> users.
  await prisma.observedTip.deleteMany({ where: { txHash: { startsWith: 'cs' }, paymentId: { startsWith: 'cstest' } } })
  for (const id of testPostIds) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  await prisma.item.deleteMany({ where: { title: { in: TEST_POST_TITLES } } })
  await prisma.$executeRaw`DELETE FROM "MoneroAccount" WHERE address ~ '^74{94}[0-9]+$'`
  if (testUserIds.length) await prisma.userSubTrust.deleteMany({ where: { userId: { in: testUserIds } } })
  if (testUserIds.length) await prisma.user.deleteMany({ where: { id: { in: testUserIds } } })
}

beforeAll(async () => {
  // Self-heal any residue from a prior interrupted run before seeding anew.
  await purgePriorResidue()

  // A wide window around "now" so freshly seeded rows fall inside it.
  periodStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  periodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000)
  seed = await seedScenario(periodStart)
})

afterAll(async () => {
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const tr of created.trustRows) {
    await prisma.userSubTrust.deleteMany({ where: { subName: tr.subName, userId: tr.userId } })
  }
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

// Root post with an explicit weightedVotes (and zero weightedDownVotes) so it
// ranks without simulating the full trust/vote pipeline. path is the item's own
// id as a single ltree label (SN convention).
async function createRootPost (userId, title, weightedVotes) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "weightedVotes")
    VALUES (${userId}::int, ${title}, ${weightedVotes}::float)
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

// Root post with an explicit created_at so a test can use its own isolated
// reward window and avoid sharing proportions with the suite's fixtures.
async function createRootPostAt (userId, title, weightedVotes, createdAt) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "weightedVotes", "created_at")
    VALUES (${userId}::int, ${title}, ${weightedVotes}::float, ${createdAt})
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

// Comment fixture with an explicit weight/created_at. item_proportions treats
// it as a separate post/comment attribution partition; path is rootId.id.
async function createCommentAt (userId, rootId, title, weightedVotes, createdAt) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", "parentId", "rootId", title, "weightedVotes", "created_at")
    VALUES (${userId}::int, ${rootId}::int, ${rootId}::int, ${title}, ${weightedVotes}::float, ${createdAt})
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${`${rootId}.${id}`}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

// The founder account is migration-seeded, so it normally already exists.
// Track it for teardown only when this test actually created it.
async function ensureFounderUser () {
  const inserted = await prisma.$queryRaw`
    INSERT INTO users (id) VALUES (${USER_ID.stasher}) ON CONFLICT DO NOTHING RETURNING id::int AS id`
  if (inserted.length > 0) created.users.push(USER_ID.stasher)
}

// A minimal MoneroAccount to satisfy ObservedTip.recipientAccountId (FK RESTRICT).
let accountSeq = 0
async function seedAccount () {
  accountSeq += 1
  const account = await prisma.moneroAccount.create({
    data: {
      ownerUserId: null,
      address: ADDR + String(accountSeq), // unique per ([address, network])
      label: 'test',
      network: 'STAGENET',
      status: 'ACTIVE'
    }
  })
  created.accounts.push(account.id)
  return account
}

let tipSeq = 0
async function seedTip ({ postId, tipperId, piconeros, confirmedAt, recipientAccountId }) {
  tipSeq += 1
  const tip = await prisma.observedTip.create({
    data: {
      txHash: 'cs' + String(tipSeq),
      postId,
      tipperId,
      recipientAccountId,
      recipientMajor: 0,
      recipientMinor: 0,
      paymentId: 'cstest' + String(tipSeq).padStart(8, '0') + '00000000',
      piconeros,
      height: 2000,
      confirmations: 10,
      state: 'CONFIRMED',
      proofType: 'INDEXED',
      confirmedAt
    }
  })
  created.tips.push(tip.id)
  return tip
}

async function seedScenario (period) {
  const account = await seedAccount()

  // 3 ranked root posts (weightedVotes > 0, no downvotes).
  const [u1, u2, u3] = await Promise.all([
    createUser(), createUser(), createUser()
  ])
  const item1 = await createRootPost(u1, 'top post', 100) // rank 1
  const item2 = await createRootPost(u2, 'mid post', 50) // rank 2
  const item3 = await createRootPost(u3, 'low post', 10) // rank 3

  // Tippers (curators). confirmedAt ordering controls the early_multiplier
  // (earlier tipper on an item wins). All tips CONFIRMED inside the period.
  const tA = await createUser()
  const tB = await createUser()
  const tC = await createUser()
  const tD = await createUser() // dust tipper -> sub-minPayout share

  const min = 60 * 1000
  await seedTip({ postId: item1, tipperId: tA, piconeros: 5_000_000_000_000n, confirmedAt: new Date(Date.now() + 1 * min), recipientAccountId: account.id })
  await seedTip({ postId: item1, tipperId: tB, piconeros: 3_000_000_000_000n, confirmedAt: new Date(Date.now() + 2 * min), recipientAccountId: account.id })
  await seedTip({ postId: item2, tipperId: tB, piconeros: 2_000_000_000_000n, confirmedAt: new Date(Date.now() + 1 * min), recipientAccountId: account.id })
  await seedTip({ postId: item2, tipperId: tC, piconeros: 1_000_000_000_000n, confirmedAt: new Date(Date.now() + 2 * min), recipientAccountId: account.id })
  // dust: just above ZAP_THRESHOLD_PICONEROS (1e8), on the lowest-ranked post.
  await seedTip({ postId: item3, tipperId: tD, piconeros: 100_000_001n, confirmedAt: new Date(Date.now() + 1 * min), recipientAccountId: account.id })

  return { account, tippers: { tA, tB, tC, tD }, items: { item1, item2, item3 } }
}

test('computeCuratorShares returns shares that exactly reconcile to the pool', async () => {
  const { shares, distributedPiconeros, rolledOverPiconeros } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: 1_000_000_000n, topN: 100 }, prisma)

  expect(BigInt(distributedPiconeros) + BigInt(rolledOverPiconeros)).toBe(POOL)
  expect(BigInt(distributedPiconeros)).toBeLessThanOrEqual(POOL)
  expect(BigInt(rolledOverPiconeros)).toBeGreaterThanOrEqual(0n)
  expect(shares.length).toBeGreaterThan(0)
})

test('every returned share meets minPayout', async () => {
  const minPayout = 1_000_000_000n
  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout, topN: 100 }, prisma)

  for (const s of shares) {
    expect(BigInt(s.sharePiconeros)).toBeGreaterThanOrEqual(minPayout)
  }
})

test('a dust curator whose share is below minPayout is excluded (rolls over)', async () => {
  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: 1_000_000_000n, topN: 100 }, prisma)

  const curatorIds = shares.map(s => Number(s.curatorId))
  // heavy tippers are included ...
  expect(curatorIds).toContain(seed.tippers.tA)
  expect(curatorIds).toContain(seed.tippers.tB)
  expect(curatorIds).toContain(seed.tippers.tC)
  // ... the dust tipper is excluded (its share rolled over, not redistributed).
  expect(curatorIds).not.toContain(seed.tippers.tD)
})

test('minPayout above every share excludes all recipients (full rollover)', async () => {
  const { shares, distributedPiconeros, rolledOverPiconeros } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: POOL + 1n, topN: 100 }, prisma)

  expect(shares).toEqual([])
  expect(BigInt(distributedPiconeros)).toBe(0n)
  expect(BigInt(rolledOverPiconeros)).toBe(POOL)
})

test('minPayout of zero includes every qualifying curator', async () => {
  const { shares, distributedPiconeros } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: 0n, topN: 100 }, prisma)

  const curatorIds = shares.map(s => Number(s.curatorId))
  expect(curatorIds).toContain(seed.tippers.tD)
  expect(BigInt(distributedPiconeros)).toBeLessThanOrEqual(POOL)
})

test('topN caps the number of recipients', async () => {
  // There are 4 qualifying curators; cap to 2 -> exactly 2 shares, the two
  // highest-proportion ones (tB, then tA).
  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: 0n, topN: 2 }, prisma)

  expect(shares.length).toBe(2)
  const curatorIds = shares.map(s => Number(s.curatorId)).sort()
  expect(curatorIds).toEqual([seed.tippers.tA, seed.tippers.tB].sort())
})

test('same inputs yield identical shares (determinism)', async () => {
  const a = await computeCuratorShares(periodStart, periodEnd, POOL, { minPayout: 1_000_000_000n, topN: 100 }, prisma)
  const b = await computeCuratorShares(periodStart, periodEnd, POOL, { minPayout: 1_000_000_000n, topN: 100 }, prisma)
  // BigInt-safe serialization (JSON.stringify can't handle BigInt natively).
  const replacer = (_, v) => (typeof v === 'bigint' ? String(v) : v)
  expect(JSON.stringify(a, replacer)).toEqual(JSON.stringify(b, replacer))
})

test('an empty period yields no shares and a full rollover', async () => {
  // A window far in the future that contains none of the seeded tips/items.
  const futureStart = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  const futureEnd = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000)
  const { shares, distributedPiconeros, rolledOverPiconeros } = await computeCuratorShares(
    futureStart, futureEnd, POOL, { minPayout: 0n, topN: 100 }, prisma)

  expect(shares).toEqual([])
  expect(BigInt(distributedPiconeros)).toBe(0n)
  expect(BigInt(rolledOverPiconeros)).toBe(POOL)
})

test('anonymous tips (null tipperId) never create curator shares', async () => {
  // Anonymous tippers (logged-out initiateTip) must not earn curator rewards:
  // their payouts would be unpayable (no registered receiving account). The
  // shares + proportions must be bit-for-bit identical with and without a large
  // anonymous tip on the top-ranked post.
  const params = { minPayout: 0n, topN: 100 }
  const before = await computeCuratorShares(periodStart, periodEnd, POOL, params, prisma)

  await seedTip({
    postId: seed.items.item1,
    tipperId: null,
    piconeros: 50_000_000_000_000n,
    confirmedAt: new Date(),
    recipientAccountId: seed.account.id
  })

  const after = await computeCuratorShares(periodStart, periodEnd, POOL, params, prisma)
  expect(after.shares.map(s => Number(s.curatorId)).sort()).toEqual(before.shares.map(s => Number(s.curatorId)).sort())
  expect(after.shares.map(s => Number(s.sharePiconeros)).sort()).toEqual(before.shares.map(s => Number(s.sharePiconeros)).sort())
})

test('each share carries per-type earns that sum exactly to the share', async () => {
  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, POOL, { minPayout: 1_000_000_000n, topN: 100 }, prisma)

  expect(shares.length).toBeGreaterThan(0)
  for (const s of shares) {
    expect(s.earns.length).toBeGreaterThan(0)
    for (const e of s.earns) {
      expect(['TIP_POST', 'TIP_COMMENT']).toContain(e.type)
      expect(e.rank).toBeGreaterThan(0)
    }
    const earnedSum = s.earns.reduce((acc, e) => acc + BigInt(e.piconeros), 0n)
    expect(earnedSum).toBe(BigInt(s.sharePiconeros))
  }
})

// HANDICAP_IDS restore (A-09 Task 1): staff users 616/4502 get a 0.5x curator
// proportion. Two identical posts with identical tips; the handicapped one's
// curator share must be exactly half the other's. Uses USER_ID.sn (4502), NOT
// 616: on a dev DB with real activity user 616 can carry genuine recent tips
// inside the period window, which breaks the exact 0.5 ratio (observed
// 2026-08-28: two real 1e9 tips). The insert tracks the user for teardown
// only if it truly creates the row — a pre-existing user is never deleted.
const HANDICAP_USER_ID = USER_ID.sn

test('staff curators (HANDICAP_IDS) get a 0.5x curator proportion', async () => {
  const inserted = await prisma.$queryRaw`
    INSERT INTO users (id) VALUES (${HANDICAP_USER_ID}) ON CONFLICT DO NOTHING RETURNING id::int AS id`
  if (inserted.length > 0) {
    // fresh insert (temporary fixture) — tracked so afterAll removes it
    created.users.push(HANDICAP_USER_ID)
  }

  const normalUser = await createUser()
  const recipientAccount = await seedAccount()
  const normalPost = await createRootPost(normalUser, 'normal handicap control post', 10)
  const staffPost = await createRootPost(HANDICAP_USER_ID, 'staff handicapped post', 10)
  const confirmedAt = new Date(Date.now() + 60 * 1000) // inside the shared period window
  await seedTip({ postId: normalPost, tipperId: normalUser, piconeros: 1_000_000_000n, confirmedAt, recipientAccountId: recipientAccount.id })
  await seedTip({ postId: staffPost, tipperId: HANDICAP_USER_ID, piconeros: 1_000_000_000n, confirmedAt, recipientAccountId: recipientAccount.id })

  const { shares } = await computeCuratorShares(
    periodStart, periodEnd, 10_000_000_000_000n, {}, prisma)

  const normalShare = shares.find(s => s.curatorId === normalUser)
  const staffShare = shares.find(s => s.curatorId === HANDICAP_USER_ID)
  expect(staffShare).toBeDefined()
  expect(normalShare).toBeDefined()
  // Both curators tipped identical amounts on identical posts; the staff
  // handicap halves the proportion, so the staff share is exactly half.
  expect(staffShare.sharePiconeros).toBe(normalShare.sharePiconeros / 2n)
})

// --- Founder exclusion: stasher is not a curator-reward recipient ---

const FOUNDER_EXCLUSION_DAY = 24 * 60 * 60 * 1000

test('stasher earns no post or comment curator share', async () => {
  await ensureFounderUser()
  const curator = await createUser()
  const account = await seedAccount()
  const base = Date.now() + 90 * FOUNDER_EXCLUSION_DAY

  const founderPost = await createRootPostAt(USER_ID.stasher, 'founder excluded post', 10, new Date(base))
  const curatorPost = await createRootPostAt(curator, 'founder excluded control post', 10, new Date(base + 1000))
  const confirmedAt = new Date(base + 2000)
  await seedTip({
    postId: founderPost,
    tipperId: USER_ID.stasher,
    piconeros: 1_000_000_000n,
    confirmedAt,
    recipientAccountId: account.id
  })
  await seedTip({
    postId: curatorPost,
    tipperId: curator,
    piconeros: 1_000_000_000n,
    confirmedAt: new Date(confirmedAt.getTime() + 1000),
    recipientAccountId: account.id
  })

  const { shares } = await computeCuratorShares(
    new Date(base - 1000), new Date(base + FOUNDER_EXCLUSION_DAY), POOL,
    { minPayout: 0n, topN: 100 }, prisma)

  expect(shares.map(s => s.curatorId)).not.toContain(USER_ID.stasher)
  const curatorShare = shares.find(s => s.curatorId === curator)
  expect(curatorShare).toBeDefined()
  expect(curatorShare.sharePiconeros).toBeGreaterThan(0n)
})

test('stasher does not consume a topN slot or reward rank', async () => {
  await ensureFounderUser()
  const largerCurator = await createUser()
  const account = await seedAccount()
  const base = Date.now() + 180 * FOUNDER_EXCLUSION_DAY

  // The founder post carries most of the vote weight, so an unfiltered
  // stasher would outrank the control curator even through the 0.5x handicap.
  const founderPost = await createRootPostAt(USER_ID.stasher, 'founder excluded topn post', 100, new Date(base))
  const largerPost = await createRootPostAt(largerCurator, 'founder excluded topn control one', 10, new Date(base + 1000))
  const confirmedAt = new Date(base + 3000)
  await seedTip({
    postId: founderPost,
    tipperId: USER_ID.stasher,
    // Large enough to still top the ranking through the 0.5x founder
    // handicap, so an unfiltered stasher would consume the only topN slot.
    piconeros: 10_000_000_000_000n,
    confirmedAt,
    recipientAccountId: account.id
  })
  await seedTip({
    postId: largerPost,
    tipperId: largerCurator,
    piconeros: 10_000_000_000n,
    confirmedAt: new Date(confirmedAt.getTime() + 1000),
    recipientAccountId: account.id
  })

  const { shares } = await computeCuratorShares(
    new Date(base - 1000), new Date(base + FOUNDER_EXCLUSION_DAY), POOL,
    { minPayout: 0n, topN: 1 }, prisma)

  // If stasher were filtered after topN, its larger proportion would consume
  // the only slot and this list would be empty. If it were filtered after the
  // rank window, the surviving curator's rank would be 2.
  expect(shares).toHaveLength(1)
  expect(shares[0].curatorId).toBe(largerCurator)
  expect(shares[0].earns[0].rank).toBe(1)
})

test('a period with only stasher curator tips rolls the whole pool over', async () => {
  await ensureFounderUser()
  const account = await seedAccount()
  const base = Date.now() + 270 * FOUNDER_EXCLUSION_DAY
  const founderPost = await createRootPostAt(USER_ID.stasher, 'founder excluded only post', 10, new Date(base))
  await seedTip({
    postId: founderPost,
    tipperId: USER_ID.stasher,
    piconeros: 1_000_000_000n,
    confirmedAt: new Date(base + 1000),
    recipientAccountId: account.id
  })

  const { shares, distributedPiconeros, rolledOverPiconeros } = await computeCuratorShares(
    new Date(base - 1000), new Date(base + FOUNDER_EXCLUSION_DAY), POOL,
    { minPayout: 0n, topN: 100 }, prisma)

  expect(shares).toEqual([])
  expect(distributedPiconeros).toBe(0n)
  expect(rolledOverPiconeros).toBe(POOL)
})

// --- Configurable curator exclusion: same path as the founder exclusion ---

function serializeShares (result) {
  return JSON.stringify(result, (_, value) => typeof value === 'bigint' ? String(value) : value)
}

async function seedExclusionPair ({
  excludedId,
  base,
  titles,
  excludedWeight = 10,
  controlWeight = 10,
  excludedPiconeros = 1_000_000_000n,
  controlPiconeros = 1_000_000_000n
}) {
  const controlId = await createUser()
  const account = await seedAccount()
  const excludedPost = await createRootPostAt(excludedId, titles[0], excludedWeight, new Date(base))
  const controlPost = await createRootPostAt(controlId, titles[1], controlWeight, new Date(base + 1000))
  const confirmedAt = new Date(base + 2000)
  await seedTip({
    postId: excludedPost,
    tipperId: excludedId,
    piconeros: excludedPiconeros,
    confirmedAt,
    recipientAccountId: account.id
  })
  await seedTip({
    postId: controlPost,
    tipperId: controlId,
    piconeros: controlPiconeros,
    confirmedAt: new Date(confirmedAt.getTime() + 1000),
    recipientAccountId: account.id
  })
  return { controlId }
}

test('a configured excluded curator earns no post or comment share', async () => {
  const excluded = await createUser()
  const base = Date.now() + 360 * FOUNDER_EXCLUSION_DAY
  const { controlId } = await seedExclusionPair({
    excludedId: excluded,
    base,
    titles: ['configured excluded post', 'configured excluded control post']
  })

  const { shares } = await computeCuratorShares(
    new Date(base - 1000), new Date(base + FOUNDER_EXCLUSION_DAY), POOL,
    { minPayout: 0n, topN: 100, excludedCuratorIds: [excluded] }, prisma)

  expect(shares.map(s => s.curatorId)).not.toContain(excluded)
  expect(shares.map(s => s.curatorId)).toContain(controlId)
})

test('a configured excluded curator does not consume a topN slot or reward rank', async () => {
  const excluded = await createUser()
  const base = Date.now() + 450 * FOUNDER_EXCLUSION_DAY
  const { controlId } = await seedExclusionPair({
    excludedId: excluded,
    base,
    titles: ['configured excluded topn post', 'configured excluded topn control post'],
    excludedWeight: 100,
    controlWeight: 10,
    excludedPiconeros: 10_000_000_000_000n,
    controlPiconeros: 10_000_000_000n
  })

  const { shares } = await computeCuratorShares(
    new Date(base - 1000), new Date(base + FOUNDER_EXCLUSION_DAY), POOL,
    { minPayout: 0n, topN: 1, excludedCuratorIds: [excluded] }, prisma)

  expect(shares).toHaveLength(1)
  expect(shares[0].curatorId).toBe(controlId)
  expect(shares[0].earns[0].rank).toBe(1)
})

test('a configured excluded curator earns no comment share and does not consume comment rank', async () => {
  const excluded = await createUser()
  const control = await createUser()
  const author = await createUser()
  const account = await seedAccount()
  const base = Date.now() + 810 * FOUNDER_EXCLUSION_DAY
  const root = await createRootPostAt(author, 'configured excluded comment root', 10, new Date(base))
  const excludedComment = await createCommentAt(excluded, root, 'configured excluded comment target', 100, new Date(base + 1000))
  const controlComment = await createCommentAt(control, root, 'configured excluded comment control', 10, new Date(base + 2000))
  const confirmedAt = new Date(base + 3000)
  await seedTip({
    postId: excludedComment,
    tipperId: excluded,
    piconeros: 10_000_000_000_000n,
    confirmedAt,
    recipientAccountId: account.id
  })
  await seedTip({
    postId: controlComment,
    tipperId: control,
    piconeros: 10_000_000_000n,
    confirmedAt: new Date(confirmedAt.getTime() + 1000),
    recipientAccountId: account.id
  })

  const { shares } = await computeCuratorShares(
    new Date(base - 1000), new Date(base + FOUNDER_EXCLUSION_DAY), POOL,
    { minPayout: 0n, topN: 100, excludedCuratorIds: [excluded] }, prisma)

  expect(shares.map(s => s.curatorId)).not.toContain(excluded)
  expect(shares).toHaveLength(1)
  expect(shares[0].curatorId).toBe(control)
  expect(shares[0].earns).toHaveLength(1)
  expect(shares[0].earns[0].type).toBe('TIP_COMMENT')
  expect(shares[0].earns[0].rank).toBe(1)
  // Independent oracle: the only surviving curator owns the whole pool. (The
  // EACH_ZAP_PORTION split is a pre-normalization weight; with no surviving
  // post-partition curators to normalize against, the roll-up renormalizes the
  // sole comment share to 1.)
  expect(shares[0].sharePiconeros).toBe(POOL)
  expect(shares[0].earns[0].piconeros).toBe(shares[0].sharePiconeros)
})

test('a period with only a configured excluded curator\'s tips rolls the whole pool over', async () => {
  const excluded = await createUser()
  const account = await seedAccount()
  const base = Date.now() + 540 * FOUNDER_EXCLUSION_DAY
  const post = await createRootPostAt(excluded, 'configured excluded only post', 10, new Date(base))
  await seedTip({
    postId: post,
    tipperId: excluded,
    piconeros: 1_000_000_000n,
    confirmedAt: new Date(base + 1000),
    recipientAccountId: account.id
  })

  const { shares, distributedPiconeros, rolledOverPiconeros } = await computeCuratorShares(
    new Date(base - 1000), new Date(base + FOUNDER_EXCLUSION_DAY), POOL,
    { minPayout: 0n, topN: 100, excludedCuratorIds: [excluded] }, prisma)

  expect(shares).toEqual([])
  expect(distributedPiconeros).toBe(0n)
  expect(rolledOverPiconeros).toBe(POOL)
})

test('empty or NULL exclusion config preserves founder-only behavior bit-for-bit', async () => {
  await ensureFounderUser()
  const controlId = await createUser()
  const account = await seedAccount()
  const base = Date.now() + 630 * FOUNDER_EXCLUSION_DAY
  const founderPost = await createRootPostAt(USER_ID.stasher, 'configured excluded empty post', 10, new Date(base))
  const controlPost = await createRootPostAt(controlId, 'configured excluded empty control post', 10, new Date(base + 1000))
  const confirmedAt = new Date(base + 2000)
  await seedTip({
    postId: founderPost,
    tipperId: USER_ID.stasher,
    piconeros: 1_000_000_000n,
    confirmedAt,
    recipientAccountId: account.id
  })
  await seedTip({
    postId: controlPost,
    tipperId: controlId,
    piconeros: 1_000_000_000n,
    confirmedAt: new Date(confirmedAt.getTime() + 1000),
    recipientAccountId: account.id
  })

  const periodStart = new Date(base - 1000)
  const periodEnd = new Date(base + FOUNDER_EXCLUSION_DAY)
  const params = { minPayout: 0n, topN: 100 }
  const omitted = await computeCuratorShares(periodStart, periodEnd, POOL, params, prisma)
  const empty = await computeCuratorShares(periodStart, periodEnd, POOL, { ...params, excludedCuratorIds: [] }, prisma)
  const nullConfig = await computeCuratorShares(periodStart, periodEnd, POOL, { ...params, excludedCuratorIds: null }, prisma)

  for (const result of [omitted, empty, nullConfig]) {
    expect(result.shares.map(s => s.curatorId)).not.toContain(USER_ID.stasher)
    expect(result.shares.map(s => s.curatorId)).toContain(controlId)
    // Independent oracle: after the founder is removed, the control curator is
    // the only survivor in either partition, so the normalized roll-up gives
    // that account the whole pool.
    expect(result.shares).toHaveLength(1)
    expect(result.shares[0].curatorId).toBe(controlId)
    expect(result.shares[0].sharePiconeros).toBe(POOL)
  }
  expect(serializeShares(empty)).toBe(serializeShares(omitted))
  expect(serializeShares(nullConfig)).toBe(serializeShares(omitted))
})

test('duplicate, unknown, and malformed configured ids never invent new semantics', async () => {
  const excluded = await createUser()
  const base = Date.now() + 720 * FOUNDER_EXCLUSION_DAY
  await seedExclusionPair({
    excludedId: excluded,
    base,
    titles: ['configured excluded junk post', 'configured excluded junk control post']
  })

  const periodStart = new Date(base - 1000)
  const periodEnd = new Date(base + FOUNDER_EXCLUSION_DAY)
  const params = { minPayout: 0n, topN: 100 }
  const single = await computeCuratorShares(periodStart, periodEnd, POOL,
    { ...params, excludedCuratorIds: [excluded] }, prisma)
  const duplicate = await computeCuratorShares(periodStart, periodEnd, POOL,
    { ...params, excludedCuratorIds: [excluded, excluded] }, prisma)
  const unknown = await computeCuratorShares(periodStart, periodEnd, POOL,
    { ...params, excludedCuratorIds: [excluded, 999_999_999] }, prisma)

  logError.mockClear()
  const malformed = await computeCuratorShares(periodStart, periodEnd, POOL,
    { ...params, excludedCuratorIds: [excluded, 'junk', 1.5, null, {}, 2 ** 40] }, prisma)

  expect(single.shares).toHaveLength(1)
  expect(single.shares[0].sharePiconeros).toBe(POOL)
  expect(serializeShares(duplicate)).toBe(serializeShares(single))
  expect(serializeShares(unknown)).toBe(serializeShares(single))
  expect(serializeShares(malformed)).toBe(serializeShares(single))
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ invalidCount: 5 }),
    expect.stringContaining('distributionExcludedCuratorIds'))
})

test('sanitizeExcludedCuratorIds keeps valid ids, dedupes, and ignores malformed config', () => {
  expect(sanitizeExcludedCuratorIds([42, 42, 7])).toEqual([42, 7])
  expect(sanitizeExcludedCuratorIds(null)).toEqual([])
  expect(sanitizeExcludedCuratorIds(undefined)).toEqual([])

  logError.mockClear()
  expect(sanitizeExcludedCuratorIds('not-an-array')).toEqual([])
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ valueType: 'string' }),
    expect.stringContaining('distributionExcludedCuratorIds'))

  logError.mockClear()
  expect(sanitizeExcludedCuratorIds([1.5, '2', null, {}, 9])).toEqual([9])
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ invalidCount: 4 }),
    expect.stringContaining('distributionExcludedCuratorIds'))
})

// --- #6: trust-weight floor helpers (pure, no DB) ---

test('effectiveTrustWeightFloor: fresh trust passes the config floor through', () => {
  const now = new Date('2026-09-21T00:00:00Z').getTime()
  expect(effectiveTrustWeightFloor(0.5, new Date(now - 60 * 60 * 1000), now)).toBe(0.5)
  expect(effectiveTrustWeightFloor(0.25, new Date(now - 25 * 60 * 60 * 1000), now)).toBe(0.25)
})

test('effectiveTrustWeightFloor: stale trust (>26h) forces 1.0', () => {
  const now = new Date('2026-09-21T00:00:00Z').getTime()
  expect(effectiveTrustWeightFloor(0.5, new Date(now - 27 * 60 * 60 * 1000), now)).toBe(1.0)
})

test('effectiveTrustWeightFloor: missing/invalid freshness (empty table) forces 1.0', () => {
  expect(effectiveTrustWeightFloor(0.5, null, Date.now())).toBe(1.0)
  expect(effectiveTrustWeightFloor(0.5, undefined, Date.now())).toBe(1.0)
  expect(effectiveTrustWeightFloor(0.5, 'not-a-date', Date.now())).toBe(1.0)
})

test('effectiveTrustWeightFloor: invalid config floors fall back to 1.0', () => {
  const fresh = new Date()
  expect(effectiveTrustWeightFloor('nope', fresh, Date.now())).toBe(1.0)
  expect(effectiveTrustWeightFloor(1.5, fresh, Date.now())).toBe(1.0)
  expect(effectiveTrustWeightFloor(-1, fresh, Date.now())).toBe(1.0)
  expect(effectiveTrustWeightFloor(NaN, fresh, Date.now())).toBe(1.0)

  // coercible-to-0 junk must NOT masquerade as floor 0 (strict typing):
  expect(effectiveTrustWeightFloor(null, fresh, Date.now())).toBe(1.0)
  expect(effectiveTrustWeightFloor(undefined, fresh, Date.now())).toBe(1.0)
  expect(effectiveTrustWeightFloor('', fresh, Date.now())).toBe(1.0)
  expect(effectiveTrustWeightFloor('0.5', fresh, Date.now())).toBe(1.0)
})

// --- #6: trust-weighted curator shares (integration) ---

// Test items are created WITHOUT subNames, so their turf resolves to META_SUB
// ('stasher') — the same real sub rewardsDistributor.test.js seeds trust into.
async function seedTrustRow (userId, zapPostTrust, zapCommentTrust = zapPostTrust) {
  await prisma.userSubTrust.create({
    data: { subName: 'stasher', userId, zapPostTrust, zapCommentTrust }
  })
  created.trustRows.push({ subName: 'stasher', userId })
}

const TRUST_POOL = 10_000_000_000_000n

// Two identical posts, one tipped by a curator we give trust, one by a curator
// we don't. Symmetric items => identical baseline contributions, so any share
// difference is attributable ONLY to the trust multiplier.
async function seedTrustScenario () {
  const account = await seedAccount()
  const author1 = await createUser()
  const author2 = await createUser()
  const trustedTipper = await createUser()
  const untrustedTipper = await createUser()
  const post1 = await createRootPost(author1, 'trust weighted post one', 10)
  const post2 = await createRootPost(author2, 'trust weighted post two', 10)
  const at = new Date(Date.now() + 90 * 60 * 1000) // inside the shared period window
  await seedTip({ postId: post1, tipperId: trustedTipper, piconeros: 1_000_000_000n, confirmedAt: at, recipientAccountId: account.id })
  await seedTip({ postId: post2, tipperId: untrustedTipper, piconeros: 1_000_000_000n, confirmedAt: at, recipientAccountId: account.id })
  return { trustedTipper, untrustedTipper }
}

test('a full-trust curator is unaffected by the floor (multiplier exactly 1)', async () => {
  const sc = await seedTrustScenario()
  await seedTrustRow(sc.trustedTipper, 1, 1)
  await seedTrustRow(sc.untrustedTipper, 1, 1)
  const { shares } = await computeCuratorShares(periodStart, periodEnd, TRUST_POOL, { minPayout: 0n, topN: 100, trustWeightFloor: 0.25 }, prisma)
  const a = shares.find(s => s.curatorId === sc.trustedTipper)
  const b = shares.find(s => s.curatorId === sc.untrustedTipper)
  expect(a).toBeDefined()
  expect(b).toBeDefined()
  // identical symmetric contributions x trust 1 => identical shares
  expect(a.sharePiconeros).toBe(b.sharePiconeros)
})

test('a zero-trust curator (no UserSubTrust row) earns ~floor x weight at floor=0.25', async () => {
  const sc = await seedTrustScenario()
  await seedTrustRow(sc.trustedTipper, 1, 1)
  // untrustedTipper gets NO row -> COALESCE(trust, 0)
  const { shares } = await computeCuratorShares(periodStart, periodEnd, TRUST_POOL, { minPayout: 0n, topN: 100, trustWeightFloor: 0.25 }, prisma)
  const a = shares.find(s => s.curatorId === sc.trustedTipper)
  const b = shares.find(s => s.curatorId === sc.untrustedTipper)
  expect(a).toBeDefined()
  expect(b).toBeDefined()
  // proportions 0.8 vs 0.2 => ~4x ratio (tolerant of BigInt floor rounding)
  const t = BigInt(a.sharePiconeros)
  const u = BigInt(b.sharePiconeros)
  expect(t).toBeGreaterThan(3n * u)
  expect(t).toBeLessThan(5n * u)
})

test('floor=0 excludes zero-trust curators from rewards entirely', async () => {
  const sc = await seedTrustScenario()
  await seedTrustRow(sc.trustedTipper, 1, 1)
  const { shares } = await computeCuratorShares(periodStart, periodEnd, TRUST_POOL, { minPayout: 0n, topN: 100, trustWeightFloor: 0 }, prisma)
  const ids = shares.map(s => s.curatorId)
  expect(ids).toContain(sc.trustedTipper)
  expect(ids).not.toContain(sc.untrustedTipper)
})

test('trustWeightFloor omitted (default 1.0) is bit-for-bit identical to legacy behavior', async () => {
  const params = { minPayout: 1_000_000_000n, topN: 100 }
  const legacy = await computeCuratorShares(periodStart, periodEnd, POOL, params, prisma)
  const explicit = await computeCuratorShares(periodStart, periodEnd, POOL, { ...params, trustWeightFloor: 1.0 }, prisma)
  const replacer = (_, v) => (typeof v === 'bigint' ? String(v) : v)
  expect(JSON.stringify(explicit, replacer)).toEqual(JSON.stringify(legacy, replacer))
})
