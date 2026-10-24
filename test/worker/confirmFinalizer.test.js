/* eslint-env jest */

// Integration test for the confirmFinalizer job (Task 7 / spec §5.5, Q5).
//
// runConfirmFinalizerOnce is the testable core of the pg-boss confirmFinalizer
// job: it reads the current chain height from monerod (get_info) once per run,
// scans DETECTED ObservedTips whose height is set (mempool tips with height
// null cannot be confirmed yet), and flips the mature ones (confirmations =
// chainHeight - tip.height + 1 >= REQUIRED_CONFIRMATIONS) to CONFIRMED. The
// flip and the author's stackedPiconeros denorm bump run in ONE Prisma
// $transaction so they can never diverge (atomicity is the whole point — a
// DETECTED tip's ranking delta is already applied at detection time; the
// CONFIRMED flip only finalizes the lifetime-received denorm, Q5).
//
// The daemonClient is the only mock — it is the network boundary (DI seam on
// runConfirmFinalizerOnce). Everything else is real DB behaviour against a
// live, migrated database.
//
// Run via the node:22.23.4 helper container:
//   docker exec sn-prisma npx jest test/worker/confirmFinalizer.test.js

import { PrismaClient } from '@prisma/client'
import { runConfirmFinalizerOnce, backfillNullBountyHeights, backfillNullObservationHeights } from '@/worker/confirmFinalizer'
import { bountyFeePiconeros } from '@/api/monero/bounties'
import { recheckDetectedTip } from '@/api/monero/selfTip'
import { DETECTED_NULL_HEIGHT_BACKSTOP_AGE_MS } from '@/lib/constants'

// Credit callers consume recheckDetectedTip's object contract; spy at the
// module boundary (same pattern as test/api/monero/webhook.test.js) so the
// lost-binding-race test can pin the caller's use of the winner-bound amount.
// The default implementation stays REAL, so every other test exercises the
// production re-check against the live DB.
jest.mock(`${process.cwd()}/api/monero/selfTip`, () => {
  const actual = jest.requireActual(`${process.cwd()}/api/monero/selfTip`)
  return { ...actual, recheckDetectedTip: jest.fn(actual.recheckDetectedTip) }
})

const prisma = new PrismaClient()

const ADDR = '5' + '3'.repeat(94) // 95-char Monero address placeholder

// Tracks every row created across tests so afterAll can tear them down in
// FK-safe order: ObservedTip/ObservedDownvote -> Item -> MoneroAccount -> users.
const created = { users: [], items: [], accounts: [], tips: [], downvotes: [], subFees: [], bounties: [], fees: [] }

// Pin the fee config deterministically for the height-set-short reconcile
// fixture (same regime as test/worker/bounties.test.js, so the quote math is
// exact: declared 1e12 -> fee 1e10 -> expected 1.01e12); restore in afterAll.
const FEE_CONFIG = { bountyFeeMinPiconeros: 10_000_000_000n, bountyFeePct: 1 }
let feeConfigSnapshot = null

// The finalizer upserts the shared chain_state tip (id=1) on every run, which
// would otherwise leave mock heights (e.g. 209) in the dev DB after the suite
// (self-healing at the worker's next tick, but trace-ful). Snapshot the live
// row up front and restore it in afterAll — same regime as feeConfigSnapshot.
// No row at snapshot time means the suite's upsert CREATES it: delete instead
// of restoring a bogus one.
let chainStateSnapshot = null

beforeAll(async () => {
  const row = await prisma.chainState.findUnique({ where: { id: 1 } })
  if (row) chainStateSnapshot = { chainHeight: row.chainHeight, updatedAt: row.updatedAt }
})

afterAll(async () => {
  // AbuseSignal rows FK-reference ObservedTip (RESTRICT) — delete before the tips.
  await prisma.abuseSignal.deleteMany({ where: { tipId: { in: created.tips } } })
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  await prisma.observedDownvote.deleteMany({ where: { id: { in: created.downvotes } } })
  await prisma.observedSubFee.deleteMany({ where: { id: { in: created.subFees } } })
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  // ObservedBountyReceipt rows cascade on ObservedBounty delete (FK onDelete: Cascade).
  await prisma.observedBounty.deleteMany({ where: { id: { in: created.bounties } } })
  await prisma.feeObservation.deleteMany({ where: { postId: { in: created.items }, feeType: 'BOUNTY_FEE' } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  // MoneroViewKey must go before MoneroAccount (FK: accountId -> account.id).
  await prisma.moneroViewKey.deleteMany({ where: { accountId: { in: created.accounts } } })
  // ObservedTip must go before MoneroAccount (FK: recipientAccountId -> account.id, RESTRICT)
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  // Restore the live dev config row if a test pinned it deterministically.
  if (feeConfigSnapshot) {
    await prisma.platformFeeConfig.update({ where: { id: 1 }, data: feeConfigSnapshot })
    feeConfigSnapshot = null
  }
  // Restore the live dev chain tip the mock heights overwrote (explicit
  // updatedAt included, so the staleness window the wall loader reads stays
  // intact); drop the row entirely when the suite created it.
  if (chainStateSnapshot) {
    await prisma.chainState.update({ where: { id: 1 }, data: chainStateSnapshot })
  } else {
    await prisma.chainState.deleteMany({ where: { id: 1 } })
  }
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  return rows[0].id
}

// Root post: path is the item's own id as a single ltree label (SN convention).
async function createRoot (userId, title) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title) VALUES (${userId}::int, ${title})
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  return id
}

// A minimal MoneroAccount to satisfy the ObservedTip.recipientAccountId FK.
// confirmFinalizer never touches the view key, so none is seeded here.
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

// An account carrying a (dummy) view key, so the finalizer's lws backfill path
// treats it as scannable. The lwsClient is mocked in those tests, so the dummy
// envelope is never actually decrypted — it just needs to be truthy.
let viewAccountSeq = 1000
async function seedAccountWithViewKey ({ label = 'test', network = 'STAGENET' } = {}) {
  viewAccountSeq += 1
  const account = await prisma.moneroAccount.create({
    data: {
      ownerUserId: null,
      address: ADDR + 'vk' + String(viewAccountSeq),
      label,
      network,
      status: 'ACTIVE'
    }
  })
  created.accounts.push(account.id)
  await prisma.moneroViewKey.create({
    data: {
      accountId: account.id,
      ciphertext: Buffer.alloc(1),
      iv: Buffer.alloc(12),
      tag: Buffer.alloc(16),
      wrappedDek: Buffer.alloc(1),
      dekVersion: 0
    }
  })
  return account
}

// A mock lwsClient whose getAddressTxs reports no txs — keeps the live-DB runs
// hermetic (no real lws call, no accidental funding of unrelated dev-DB bounties
// such as the stuck item 2808, whose NULL-height row would otherwise be picked
// up by the backfill scan).
function emptyLws () {
  return { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 0 }) }
}

// Seed a DETECTED ObservedTip directly (bypassing the indexer) so the test
// exercises ONLY the confirmFinalizer flip path. txHash must be unique under
// the @@unique([txHash, recipientAccountId, recipientMajor, recipientMinor]).
let tipSeq = 0
async function seedTip ({ postId, piconeros, height, recipientAccountId, txHash }) {
  tipSeq += 1
  const tip = await prisma.observedTip.create({
    data: {
      txHash: txHash ?? 'cf' + String(tipSeq),
      postId,
      tipperId: null,
      recipientAccountId,
      recipientMajor: 0,
      recipientMinor: 0,
      paymentId: 'cftest' + String(tipSeq).padStart(8, '0') + '00000000',
      piconeros,
      height,
      state: 'DETECTED',
      proofType: 'INDEXED'
    }
  })
  created.tips.push(tip.id)
  return tip
}

// The daemonClient DI mock: only getHeight is consulted per run.
function mockClient (height) {
  return { getHeight: jest.fn().mockResolvedValue(height) }
}

function readTip (id) {
  return prisma.observedTip.findUnique({ where: { id } })
}

function readUser (id) {
  return prisma.user.findUnique({ where: { id }, select: { stackedPiconeros: true } })
}

// Seed a DETECTED ObservedDownvote directly (bypassing the indexer) so the test
// exercises ONLY the confirmFinalizer flip path. txHash/paymentId must be
// unique under the @@unique([txHash, paymentId]).
let downvoteSeq = 0
async function seedDownvote ({ postId, piconeros, height, downvoterId = null }) {
  downvoteSeq += 1
  const downvote = await prisma.observedDownvote.create({
    data: {
      txHash: 'odv' + String(downvoteSeq),
      postId,
      downvoterId,
      paymentId: 'odvtest' + String(downvoteSeq).padStart(8, '0') + '00000000',
      piconeros,
      height,
      state: 'DETECTED'
    }
  })
  created.downvotes.push(downvote.id)
  return downvote
}

test('a DETECTED tip at height 200 becomes CONFIRMED at chain height 209 (10 confs) and bumps the author denorm atomically', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'confirm-target'); created.items.push(postId)
  const account = await seedAccount()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: 200, recipientAccountId: account.id })

  expect((await readUser(authorId)).stackedPiconeros).toBe(0n)

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(209), lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('CONFIRMED')
  expect(after.confirmations).toBe(10)
  expect(after.confirmedAt).toBeInstanceOf(Date)
  expect((await readUser(authorId)).stackedPiconeros).toBe(5_000_000n)
})

test('a DETECTED tip stays DETECTED at 9 confirmations (chain 208) and does not bump the author', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'not-yet'); created.items.push(postId)
  const account = await seedAccount()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: 200, recipientAccountId: account.id })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(208), lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('DETECTED')
  expect(after.confirmedAt).toBeNull()
  expect((await readUser(authorId)).stackedPiconeros).toBe(0n)
})

test('a mempool tip (height null) is skipped even at high chain height', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'mempool'); created.items.push(postId)
  const account = await seedAccount()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: null, recipientAccountId: account.id })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(9999), lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('DETECTED')
  expect((await readUser(authorId)).stackedPiconeros).toBe(0n)
})

test('idempotent: running twice does not double-bump the author denorm', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'idempotent'); created.items.push(postId)
  const account = await seedAccount()
  const tip = await seedTip({ postId, piconeros: 7_000_000n, height: 200, recipientAccountId: account.id })

  const client = mockClient(209)
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: client, lwsClient: emptyLws() })
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: client, lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('CONFIRMED')
  expect((await readUser(authorId)).stackedPiconeros).toBe(7_000_000n)
})

test('a mature DETECTED wash tip (self-send from the recipient own wallet) is EXCLUDED, reversed, and never credited', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const tipperId = await createUser(); created.users.push(tipperId)
  const postId = await createRoot(authorId, 'wash-target'); created.items.push(postId)
  // The account must be scannable (view key present) for the confirm-time
  // self-send re-check to run its lws lookup; the lws mock supplies the proof.
  const account = await seedAccountWithViewKey()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: 200, recipientAccountId: account.id })
  // Post-detection state: an attributed tipper whose delta was applied at
  // DETECTED (the 0-conf scan failed open — spent_outputs do not exist for
  // mempool txs). Mirror exactly what applyTipDetected would have done.
  await prisma.observedTip.update({ where: { id: tip.id }, data: { tipperId, rankPiconeros: 3_500_000n } })
  await prisma.itemUserAgg.create({ data: { userId: tipperId, itemId: postId, tipPiconeros: 5_000_000n } })
  await prisma.item.update({ where: { id: postId }, data: { upvotes: 1, piconeros: 5_000_000n, tipRankPiconeros: 3_500_000n, weightedVotes: 1.0 } })

  // The lws scan returns the tip tx with a spent output from the recipient
  // account's own primary subaddress (0,0) — a literal self-send.
  const washLws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: tip.txHash, height: 200, payment_id: tip.paymentId, piconeros: 5_000_000n, fee: 0n, spent_outputs: [{ amount: '5000000', sender: { maj_i: 0, min_i: 0 } }] }]
    })
  }

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(209), lwsClient: washLws })

  const after = await readTip(tip.id)
  expect(after.state).toBe('EXCLUDED')
  expect(after.exclusionReason).toBe('SELF_SEND')
  // the author was never credited
  expect((await readUser(authorId)).stackedPiconeros).toBe(0n)
  // the detection-applied ranking effects were reversed (exact inverse)
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.upvotes).toBe(0)
  expect(item.piconeros).toBe(0n)
  expect(item.tipRankPiconeros).toBe(0n)
  const agg = await prisma.itemUserAgg.findUnique({ where: { itemId_userId: { itemId: postId, userId: tipperId } } })
  expect(agg.tipPiconeros).toBe(0n)
  // the abuse signal was written transactionally with the exclusion
  const signal = await prisma.abuseSignal.findUnique({ where: { tipId: tip.id } })
  expect(signal.kind).toBe('SELF_SEND_EXCLUDED')
  expect(signal.subjectUserId).toBe(authorId)
  expect(signal.actorUserId).toBe(tipperId)
  // One scan for THIS tip's account (incremental from a null cursor, pid
  // found, no full-history fallback). The shared mock may also serve the
  // NULL-height backstop's ambient scans for other dev-DB accounts, so count
  // only this account's scans — a fallback would make it 2.
  const washScans = washLws.getAddressTxs.mock.calls.filter(([scanned]) => scanned.id === account.id)
  expect(washScans).toHaveLength(1)
  expect(washScans[0][1]).toBe(0)
})

test('a mature DETECTED tip whose ring merely DECOY-references an own output is CONFIRMED and credited', async () => {
  // Own candidate 1000000 - fee 0 != received 5000000: do not exclude.
  const authorId = await createUser(); created.users.push(authorId)
  const tipperId = await createUser(); created.users.push(tipperId)
  const postId = await createRoot(authorId, 'decoy-target'); created.items.push(postId)
  const account = await seedAccountWithViewKey()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: 200, recipientAccountId: account.id })
  await prisma.observedTip.update({ where: { id: tip.id }, data: { tipperId, rankPiconeros: 3_500_000n } })
  await prisma.itemUserAgg.create({ data: { userId: tipperId, itemId: postId, tipPiconeros: 5_000_000n } })
  await prisma.item.update({ where: { id: postId }, data: { upvotes: 1, piconeros: 5_000_000n, tipRankPiconeros: 3_500_000n, weightedVotes: 1.0 } })

  const decoyLws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: tip.txHash, height: 200, payment_id: tip.paymentId, piconeros: 5_000_000n, fee: 0n, spent_outputs: [{ amount: '1000000', sender: { maj_i: 0, min_i: 0 } }] }]
    })
  }

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(209), lwsClient: decoyLws })

  const after = await readTip(tip.id)
  expect(after.state).toBe('CONFIRMED')
  expect(after.exclusionReason).toBe(null)
  // the author was credited at confirmation
  expect((await readUser(authorId)).stackedPiconeros).toBe(5_000_000n)
  // the detection-applied ranking effects were never reversed
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.upvotes).toBe(1)
  expect(item.piconeros).toBe(5_000_000n)
  // no abuse signal for a decoy reference
  expect(await prisma.abuseSignal.findUnique({ where: { tipId: tip.id } })).toBe(null)
})

test('a mature DETECTED tip whose stored amount disagrees with the chain is EXCLUDED (CHAIN_MISMATCH), reversed, and never credited', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const tipperId = await createUser(); created.users.push(tipperId)
  const postId = await createRoot(authorId, 'forged-amount-target'); created.items.push(postId)
  const account = await seedAccountWithViewKey()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: 200, recipientAccountId: account.id })
  // Post-detection state: the forged amount was applied at DETECTED (pre-
  // verification webhook callback) — mirror exactly what applyTipDetected did.
  // amountVerifiedAt is SET: only a BOUND row disagreeing with the chain is
  // forged evidence (CHAIN_MISMATCH); an unbound row would be trust-corrected.
  await prisma.observedTip.update({ where: { id: tip.id }, data: { tipperId, rankPiconeros: 3_500_000n, amountVerifiedAt: new Date('2026-09-01T00:00:00Z') } })
  await prisma.itemUserAgg.create({ data: { userId: tipperId, itemId: postId, tipPiconeros: 5_000_000n } })
  await prisma.item.update({ where: { id: postId }, data: { upvotes: 1, piconeros: 5_000_000n, tipRankPiconeros: 3_500_000n, weightedVotes: 1.0 } })

  // The chain carries only 1_000_000n for this payment id — the stored
  // 5_000_000n is a forged pre-verification callback amount.
  const forgedLws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: tip.txHash, height: 200, payment_id: tip.paymentId, piconeros: 1_000_000n, spent_outputs: [] }]
    })
  }

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(209), lwsClient: forgedLws })

  const after = await readTip(tip.id)
  expect(after.state).toBe('EXCLUDED')
  expect(after.exclusionReason).toBe('CHAIN_MISMATCH')
  // the author was never credited with the forged amount
  expect((await readUser(authorId)).stackedPiconeros).toBe(0n)
  // the detection-applied ranking effects (forged delta) were reversed
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.upvotes).toBe(0)
  expect(item.piconeros).toBe(0n)
  expect(item.tipRankPiconeros).toBe(0n)
  const agg = await prisma.itemUserAgg.findUnique({ where: { itemId_userId: { itemId: postId, userId: tipperId } } })
  expect(agg.tipPiconeros).toBe(0n)
  // the abuse signal records both sides of the mismatch
  const signal = await prisma.abuseSignal.findUnique({ where: { tipId: tip.id } })
  expect(signal.kind).toBe('CHAIN_MISMATCH_EXCLUDED')
  expect(signal.subjectUserId).toBe(authorId)
  expect(signal.details.storedPiconeros).toBe('5000000')
  expect(signal.details.onChainPiconeros).toBe('1000000')
})

test('an unbound DETECTED tip is credited with the corrected chain amount, not the provisional one', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const tipperId = await createUser(); created.users.push(tipperId)
  const postId = await createRoot(authorId, 'corrected-credit'); created.items.push(postId)
  const account = await seedAccountWithViewKey()
  // Provisional 1000n recorded at DETECTED by the pre-verification write; the
  // row is UNBOUND (amountVerifiedAt null), so the re-check TRUST-CORRECTS it
  // to the chain amount (400n) instead of excluding it.
  const tip = await seedTip({ postId, piconeros: 1_000n, height: 200, recipientAccountId: account.id, txHash: 'bb'.repeat(32) })
  // Post-detection state mirroring the CHAIN_MISMATCH test: the provisional
  // delta was applied at DETECTED. The correction reverses it and re-applies
  // at 400n inside recheckDetectedTip.
  await prisma.observedTip.update({ where: { id: tip.id }, data: { tipperId, rankPiconeros: 700n } })
  await prisma.itemUserAgg.create({ data: { userId: tipperId, itemId: postId, tipPiconeros: 1_000n } })
  await prisma.item.update({ where: { id: postId }, data: { upvotes: 1, piconeros: 1_000n, tipRankPiconeros: 700n, weightedVotes: 1.0 } })

  // lws reports the SAME tx hash at 400n — a correction, not a mismatch.
  const correctedLws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ hash: tip.txHash, height: 200, payment_id: tip.paymentId, piconeros: 400n, spent_outputs: [] }]
    })
  }

  const baseline = (await prisma.user.findUnique({ where: { id: authorId }, select: { stackedPiconeros: true } })).stackedPiconeros
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(209), lwsClient: correctedLws })
  const after = await prisma.user.findUnique({ where: { id: authorId }, select: { stackedPiconeros: true } })

  const row = await readTip(tip.id)
  expect(row.state).toBe('CONFIRMED')
  expect(row.amountVerifiedAt).toBeInstanceOf(Date)
  expect(after.stackedPiconeros - baseline).toBe(400n)
})

test('a lost binding race credits the amount the re-check reports, not the stale snapshot', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'lost-race-credit'); created.items.push(postId)
  const account = await seedAccount()
  // The finalizer's snapshot read is the provisional 1000n, but the re-check
  // reports the row was already bound to the chain's 400n — the webhook won
  // the binding race. The credit must use 400n, never the snapshot.
  const tip = await seedTip({ postId, piconeros: 1_000n, height: 200, recipientAccountId: account.id })

  const realRecheck = recheckDetectedTip.getMockImplementation()
  recheckDetectedTip.mockImplementation(async (args) =>
    args.tip.id === tip.id ? { action: 'clean', piconeros: 400n } : realRecheck(args))
  try {
    const baseline = (await readUser(authorId)).stackedPiconeros
    await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(209), lwsClient: emptyLws() })
    const after = await readUser(authorId)
    expect((await readTip(tip.id)).state).toBe('CONFIRMED')
    expect(after.stackedPiconeros - baseline).toBe(400n)
  } finally {
    recheckDetectedTip.mockImplementation(realRecheck)
  }
})

test('a deferred re-check (lws miss corroborated by monerod) never credits or excludes, and retries next pass', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'deferred-credit'); created.items.push(postId)
  const account = await seedAccountWithViewKey()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: 200, recipientAccountId: account.id, txHash: 'cc'.repeat(32) })
  const baseline = (await readUser(authorId)).stackedPiconeros
  // lws cannot see the tx but monerod still has it: the fail-closed verdict is
  // 'deferred' — this pass must neither credit nor exclude.
  const daemon = {
    getHeight: async () => 209,
    getTransactions: async () => [{ hash: tip.txHash }]
  }
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: daemon, lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('DETECTED')
  expect(after.amountVerifiedAt).toBeNull()
  expect((await readUser(authorId)).stackedPiconeros).toBe(baseline)
  const signal = await prisma.abuseSignal.findUnique({ where: { tipId: tip.id } })
  expect(signal).toBeNull()
})

// PR1 credit-hole lock-in (audit 2026-09-11, finding 2; Task 4/5 object
// contract): a forged DETECTED row whose tx exists NOWHERE — absent from lws
// AND absent from monerod. The fail-closed corroboration must claim
// TX_NOT_FOUND (EXCLUDED + AbuseSignal) and the credit pass must never bump the
// author. (The deferred test above is the same lws miss when monerod still HAS
// the tx — deferral, not exclusion.)
test('a forged DETECTED tip whose tx never existed is excluded, never credited', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'forged-no-tx'); created.items.push(postId)
  // The account must be scannable (view key present) or the re-check fails
  // open with 'clean' before reaching the lws/monerod evidence.
  const account = await seedAccountWithViewKey()
  // Distinct from the deferred test's 'cc…' fixture: the global txHash unique
  // (2026-09-19 hardening) makes duplicate hashes unrepresentable.
  const tip = await seedTip({ postId, piconeros: 5_000n, height: 200, recipientAccountId: account.id, txHash: 'ce'.repeat(32) })
  expect(tip.amountVerifiedAt).toBeNull()
  const baseline = (await readUser(authorId)).stackedPiconeros

  // lws reports no txs for the account and monerod does not know the anchored
  // hash either — the tx never existed. Scope the empty monerod answer to OUR
  // hash so any other live-DB DETECTED tip resolves 'deferred' (retry), never
  // excluded by this run.
  const daemon = {
    getHeight: jest.fn().mockResolvedValue(209),
    getTransactions: jest.fn().mockImplementation(async (hashes) =>
      hashes.includes(tip.txHash) ? [] : [{ hash: hashes[0] }])
  }
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: daemon, lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('EXCLUDED')
  expect(after.exclusionReason).toBe('TX_NOT_FOUND')
  // the author was never credited
  expect((await readUser(authorId)).stackedPiconeros).toBe(baseline)
  // the exclusion wrote its abuse signal transactionally (stored side recorded,
  // on-chain side absent)
  const signal = await prisma.abuseSignal.findUnique({ where: { tipId: tip.id } })
  expect(signal.kind).toBe('TX_NOT_FOUND_EXCLUDED')
  expect(signal.subjectUserId).toBe(authorId)
  expect(signal.actorUserId).toBeNull()
  expect(signal.details.storedPiconeros).toBe('5000')
  expect(signal.details.onChainPiconeros).toBeNull()
  expect(signal.details.storedTxHash).toBe(tip.txHash)
  // the anchored hash was corroborated against monerod
  expect(daemon.getTransactions).toHaveBeenCalledWith([tip.txHash])
})

// I3 (final whole-branch review): a tip detected at 0-conf (daemon level) can
// sit DETECTED with height NULL. If every later mined webhook is lost, nothing
// scans it — the maturity pass requires height NOT NULL, reconcilePendingTips
// scans PENDING only, webhookMissCheck pages PENDING only — and at 48h
// reverseStaleDetections would flip it REORGED, silently reversing a real,
// paid tip. The bounded NULL-height backstop re-checks such rows through the
// same recheckDetectedTip gate; it never credits in the same run (the credit
// pass runs first), so a backfilled row is credited by the NEXT tick's
// height-not-null pass after a fresh re-read.

function backdated (ms) {
  return new Date(Date.now() - ms)
}

test('the NULL-height DETECTED backstop backfills a mined tip older than the grace period (next run credits it)', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'null-height-backstop'); created.items.push(postId)
  const account = await seedAccountWithViewKey()
  // A bound row (amount already lws-verified; only the height is missing) —
  // the shape left by a mempool-shaped lws sight. Backdate detection past the
  // grace period so the backstop is willing to scan it.
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: null, recipientAccountId: account.id, txHash: 'ab'.repeat(32) })
  await prisma.observedTip.update({
    where: { id: tip.id },
    data: {
      amountVerifiedAt: new Date(),
      detectedAt: backdated(DETECTED_NULL_HEIGHT_BACKSTOP_AGE_MS + 60_000)
    }
  })
  const lws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: tip.txHash, height: 700, payment_id: tip.paymentId, piconeros: 5_000_000n, spent_outputs: [] }],
      blockchain_height: 709
    })
  }

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(709), lwsClient: lws })

  // Backstop run: height backfilled, but NOT credited in this same pass.
  let after = await readTip(tip.id)
  expect(after.height).toBe(700)
  expect(after.state).toBe('DETECTED')
  expect((await readUser(authorId)).stackedPiconeros).toBe(0n)

  // Next run: the row is height-set and mature, so the normal credit pass
  // (fresh DB re-read + re-check) credits it.
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(709), lwsClient: lws })
  after = await readTip(tip.id)
  expect(after.state).toBe('CONFIRMED')
  expect(after.confirmations).toBe(10)
  expect((await readUser(authorId)).stackedPiconeros).toBe(5_000_000n)
})

test('a fresh NULL-height DETECTED tip (inside the grace period) is NOT scanned by the backstop', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'fresh-null-height'); created.items.push(postId)
  const account = await seedAccountWithViewKey()
  const tip = await seedTip({ postId, piconeros: 5_000_000n, height: null, recipientAccountId: account.id, txHash: 'cd'.repeat(32) })
  await prisma.observedTip.update({ where: { id: tip.id }, data: { amountVerifiedAt: new Date() } })
  // The lws scan WOULD resolve this tip if the backstop scanned it — proving
  // the absence of a scan via the row staying height-NULL and no lookup for
  // this account.
  const lws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ id: 1, hash: tip.txHash, height: 700, payment_id: tip.paymentId, piconeros: 5_000_000n, spent_outputs: [] }],
      blockchain_height: 709
    })
  }

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(709), lwsClient: lws })

  const after = await readTip(tip.id)
  expect(after.height).toBeNull()
  expect(after.state).toBe('DETECTED')
  const scansForAccount = lws.getAddressTxs.mock.calls.filter(call => call[0].id === account.id)
  expect(scansForAccount).toHaveLength(0)
})

test('a stale NULL-height DETECTED tip whose tx is absent everywhere is corroborated and excluded (never silently stranded to REORGED)', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'absent-null-height'); created.items.push(postId)
  const account = await seedAccountWithViewKey()
  const tip = await seedTip({ postId, piconeros: 5_000n, height: null, recipientAccountId: account.id, txHash: 'ef'.repeat(32) })
  await prisma.observedTip.update({
    where: { id: tip.id },
    data: { detectedAt: backdated(DETECTED_NULL_HEIGHT_BACKSTOP_AGE_MS + 60_000) }
  })
  const baseline = (await readUser(authorId)).stackedPiconeros
  // monerod also has no such tx (only the anchored hash is asked; every other
  // hash resolves non-empty so no unrelated live-DB row is excluded by this run).
  const daemon = {
    getHeight: jest.fn().mockResolvedValue(709),
    getTransactions: jest.fn().mockImplementation(async (hashes) =>
      hashes.includes(tip.txHash) ? [] : [{ hash: hashes[0] }])
  }

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: daemon, lwsClient: emptyLws() })

  const after = await readTip(tip.id)
  expect(after.state).toBe('EXCLUDED')
  expect(after.exclusionReason).toBe('TX_NOT_FOUND')
  expect((await readUser(authorId)).stackedPiconeros).toBe(baseline)
  const signal = await prisma.abuseSignal.findUnique({ where: { tipId: tip.id } })
  expect(signal.kind).toBe('TX_NOT_FOUND_EXCLUDED')
  expect(daemon.getTransactions).toHaveBeenCalledWith([tip.txHash])
})

test('a DETECTED ObservedDownvote becomes CONFIRMED at 10 confirmations', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'downvote-confirm-target'); created.items.push(postId)
  const downvote = await seedDownvote({ postId, piconeros: 1_000_000_000n, height: 500 })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(509), lwsClient: emptyLws() })

  const after = await prisma.observedDownvote.findUnique({ where: { id: downvote.id } })
  expect(after.state).toBe('CONFIRMED')
  expect(after.confirmations).toBe(10)
  expect(after.confirmedAt).toBeInstanceOf(Date)
})

test('a DETECTED ObservedDownvote stays DETECTED below 10 confirmations', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createRoot(authorId, 'downvote-not-yet'); created.items.push(postId)
  const downvote = await seedDownvote({ postId, piconeros: 1_000_000_000n, height: 500 })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(508), lwsClient: emptyLws() })

  const after = await prisma.observedDownvote.findUnique({ where: { id: downvote.id } })
  expect(after.state).toBe('DETECTED')
  expect(after.confirmedAt).toBeNull()
})

// Task 13: a NULL-height downvote (observer/webhook detected the mempool tx
// before it was mined) is transitioned by the lws backfill through the shared
// applyDownvoteTransition — height AND the ranking penalty are applied exactly
// once, no matter how many finalizer runs see the row.
test('a NULL-height DETECTED downvote is transitioned via lws and penalised exactly once across two runs', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const downvoterId = await createUser(); created.users.push(downvoterId)
  const postId = await createRoot(authorId, 'downvote-null-height'); created.items.push(postId)
  const downvote = await seedDownvote({ postId, piconeros: 1_000_000_000n, height: null, downvoterId })
  // The lws backfill resolves the scan account via findRewardsAccount — a
  // platform_rewards row with a view key. A fresh CI database never has one
  // (prisma seed creates no monero accounts), so the test provides its own;
  // the network mirrors findRewardsAccount's env-derived filter.
  await seedAccountWithViewKey({
    label: 'platform_rewards',
    network: (process.env.MONERO_NETWORK || 'STAGENET').toUpperCase()
  })
  const HEIGHT = 2186635
  const lws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ hash: downvote.txHash, height: HEIGHT, confirmations: 12, piconeros: 1_000_000_000n }],
      blockchain_height: HEIGHT + 10
    })
  }

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(HEIGHT + 10), lwsClient: lws })

  let after = await prisma.observedDownvote.findUnique({ where: { id: downvote.id } })
  expect(after.height).toBe(HEIGHT)
  expect(after.state).toBe('CONFIRMED')
  let item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.downPiconeros).toBe(1_000_000_000n)

  // Second run: the row is no longer height-NULL, so the transition CAS (and
  // the penalty) must not fire again.
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(HEIGHT + 10), lwsClient: lws })
  after = await prisma.observedDownvote.findUnique({ where: { id: downvote.id } })
  expect(after.state).toBe('CONFIRMED')
  item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.downPiconeros).toBe(1_000_000_000n)
})

// Seed a DETECTED ObservedSubFee directly (bypassing the webhook) so the test
// exercises ONLY the confirmFinalizer flip path. txHash/paymentId must be
// unique under the @@unique([txHash, paymentId]). owner_user_id carries no FK,
// so any user id is valid — a freshly created user keeps it realistic.
let subFeeSeq = 0
async function seedSubFee ({ subName, ownerUserId, piconeros, height }) {
  subFeeSeq += 1
  const subFee = await prisma.observedSubFee.create({
    data: {
      txHash: 'osf' + String(subFeeSeq),
      paymentId: 'osftest' + String(subFeeSeq).padStart(8, '0') + '00000000',
      subName,
      ownerUserId,
      piconeros,
      height,
      state: 'DETECTED'
    }
  })
  created.subFees.push(subFee.id)
  return subFee
}

// ObservedSubFee (turf-owner fee legs): the lws webhook N-conf callback is the
// primary maturer — the finalizer pass is the safety net for a missed callback
// (deploy restart, swept stragglers), mirroring the FeeObservation pass.
test('a DETECTED ObservedSubFee becomes CONFIRMED at 10 confirmations (missed webhook N-conf callback)', async () => {
  const ownerUserId = await createUser(); created.users.push(ownerUserId)
  const subFee = await seedSubFee({ subName: 'turf-conf', ownerUserId, piconeros: 1_000_000_000n, height: 991 })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(1000), lwsClient: emptyLws() })

  const after = await prisma.observedSubFee.findUnique({ where: { id: subFee.id } })
  expect(after.state).toBe('CONFIRMED')
  expect(after.confirmations).toBe(10)
  expect(after.confirmedAt).toBeInstanceOf(Date)
})

test('a DETECTED ObservedSubFee stays DETECTED below 10 confirmations', async () => {
  const ownerUserId = await createUser(); created.users.push(ownerUserId)
  const subFee = await seedSubFee({ subName: 'turf-not-yet', ownerUserId, piconeros: 1_000_000_000n, height: 999 })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(1000), lwsClient: emptyLws() })

  const after = await prisma.observedSubFee.findUnique({ where: { id: subFee.id } })
  expect(after.state).toBe('DETECTED')
  expect(after.confirmedAt).toBeNull()
})

test('a mempool ObservedSubFee (height null) is skipped even at high chain height', async () => {
  const ownerUserId = await createUser(); created.users.push(ownerUserId)
  const subFee = await seedSubFee({ subName: 'turf-mempool', ownerUserId, piconeros: 1_000_000_000n, height: null })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(9999), lwsClient: emptyLws() })

  const after = await prisma.observedSubFee.findUnique({ where: { id: subFee.id } })
  expect(after.state).toBe('DETECTED')
  expect(after.confirmations).toBe(0)
})

// Integrated platform fee receipts (PID-bound FeeObservation rows) get their
// height ONLY through the shared applier, which corrects the provisional
// amount and replays the gate; the finalizer's bare height backfill must
// leave them alone even when lws reports the tx mined.
test('a NULL-height PID-bound FeeObservation is never height-stamped by the backfill', async () => {
  const txHash = 'cfpidfee' + String(Date.now()).padStart(56, '0')
  const fee = await prisma.feeObservation.create({
    data: { txHash, paymentId: 'a1b2c3d4e5f60718', feeType: 'POSTING', recipientMajor: 0, recipientMinor: 0, piconeros: 9_000_000_000n, height: null, state: 'DETECTED' }
  })
  created.fees.push(fee.id)
  const lws = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [{ hash: txHash, height: 990, confirmations: 11, piconeros: 1_000_000_000n }], blockchain_height: 1000 }) }

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(1000), lwsClient: lws })

  const after = await prisma.feeObservation.findUnique({ where: { id: fee.id } })
  expect(after).toMatchObject({ height: null, piconeros: 9_000_000_000n, state: 'DETECTED' })
})

// Seed a DETECTED ObservedBounty directly (bypassing the webhook) so the test
// exercises ONLY the confirmFinalizer flip path. txHash/paymentId must be
// unique under the @@unique([txHash, paymentId]).
let bountySeq = 0
async function seedBounty ({ postId, piconeros, height, recipientAccountId }) {
  bountySeq += 1
  const bounty = await prisma.observedBounty.create({
    data: {
      txHash: 'obv' + String(bountySeq),
      postId,
      payerId: null,
      recipientAccountId,
      paymentId: 'obtest' + String(bountySeq).padStart(8, '0') + '00000000',
      piconeros,
      height,
      state: 'DETECTED'
    }
  })
  created.bounties.push(bounty.id)
  return bounty
}

// A bounty post with a DECLARED bounty amount — real fundings always carry one
// (the raw createRoot default of 0 would book a zero fee under the
// declared-amount fee rule). The funding-path fixtures pay the full declared +
// fee quote (the confirmation gate holds anything short), so the fee math
// stays exact and readable.
async function createBountyRoot (userId, title, bountyPiconeros) {
  const postId = await createRoot(userId, title)
  await prisma.item.update({
    where: { id: postId },
    data: { bountyPiconeros }
  })
  created.items.push(postId)
  return postId
}

test('a DETECTED ObservedBounty becomes CONFIRMED at 10 confirmations AND runs driveBountyFunding (Item FUNDED + fee frozen, no cash row) — true backstop for a missed webhook CONFIRMED callback', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-confirm-target', 5_000_000_000n)
  const account = await seedAccount()
  // The confirmation gate requires cumulative received >= declared + fee, so
  // the fixture pays the FULL quote (5e9 declared + fee; fee on the declared
  // 5e9 is cap-bound at 1e9 with the dev config's 0.01 floor).
  const config = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  const feePiconeros = bountyFeePiconeros(5_000_000_000n, config)
  const bounty = await seedBounty({ postId, piconeros: 5_000_000_000n + feePiconeros, height: 700, recipientAccountId: account.id })
  // Real fundings always carry the detection-time receipt (the webhook records
  // it at DETECTED); the funding pass self-computes its gate from these rows.
  await prisma.observedBountyReceipt.create({
    data: { bountyId: bounty.id, txHash: 'rcpt' + bounty.id, piconeros: 5_000_000_000n + feePiconeros, height: 700 }
  })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(709), lwsClient: emptyLws() })

  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.state).toBe('CONFIRMED')
  expect(after.confirmations).toBe(10)
  expect(after.confirmedAt).toBeInstanceOf(Date)

  // The finalizer is the BACKSTOP for a missed webhook CONFIRMED callback, so it
  // must run the same funding effects as the webhook — not just flip the row.
  // Item -> FUNDED with bountyPiconeros = observed − fee and the fee terms
  // FROZEN from the DECLARED bounty (observed = declared + fee here, so 6e9 →
  // 5e9 booked). Funding stays escrow-internal: no hot-wallet cash row.
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.bountyStatus).toBe('FUNDED')
  expect(item.bountyPiconeros).toBe(5_000_000_000n)
  expect(item.bountyFeePiconeros).toBe(feePiconeros)
  expect(item.bountyConfirmedAt).toBeInstanceOf(Date)
  expect(await prisma.feeObservation.count({ where: { postId, feeType: 'BOUNTY_FEE' } })).toBe(0)
})

test('a DETECTED ObservedBounty stays DETECTED below 10 confirmations', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-not-yet', 5_000_000_000n)
  const account = await seedAccount()
  const bounty = await seedBounty({ postId, piconeros: 5_000_000_000n, height: 700, recipientAccountId: account.id })

  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(708), lwsClient: emptyLws() })

  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.state).toBe('DETECTED')
  expect(after.confirmedAt).toBeNull()
  // No funding side effects below the threshold.
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.bountyStatus).toBe('UNFUNDED')
  const fee = await prisma.feeObservation.findFirst({ where: { postId, feeType: 'BOUNTY_FEE' } })
  expect(fee).toBeNull()
})

test('a NULL-height DETECTED bounty (webhook CONFIRMED callback missed at 0-conf) is resolved via lws and funded at N confirmations — item 2808 scenario', async () => {
  // The 0-conf webhook consumed the pid map and set height = NULL (mempool tx).
  // After the gate bug, every later callback was a 200 no-op, so no callback ever
  // backfilled height. The finalizer must resolve the tx height from lws (which
  // watches the escrow account), record the receipt (cumulative received), then
  // fund it once the total covers declared + fee.
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-null-height', 5_000_000_000n)
  const account = await seedAccountWithViewKey()
  const bounty = await seedBounty({ postId, piconeros: 5_000_000_000n, height: null, recipientAccountId: account.id })
  const config = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  const feePiconeros = bountyFeePiconeros(5_000_000_000n, config)

  // Mock lws reports the funding tx (matched by payment_id) now at height 700,
  // paying the full declared + fee quote.
  const lws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ payment_id: bounty.paymentId, hash: 'e2'.repeat(32), height: 700, piconeros: 5_000_000_000n + feePiconeros }],
      blockchain_height: 709
    })
  }
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(709), lwsClient: lws })
  // lws was scanned for the test bounty's escrow account. (It is also scanned
  // for any other NULL-height bounty in the live dev DB — e.g. the real item
  // 2808, which this same code path self-heals in production.)
  const scannedIds = lws.getAddressTxs.mock.calls.map(c => c[0].id)
  expect(scannedIds).toContain(account.id)

  // Height backfilled, then funded through the normal path.
  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.state).toBe('CONFIRMED')
  expect(after.height).toBe(700)
  expect(after.confirmations).toBe(10)
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.bountyStatus).toBe('FUNDED')
  expect(item.bountyFeePiconeros).toBe(feePiconeros)
  expect(await prisma.feeObservation.count({ where: { postId, feeType: 'BOUNTY_FEE' } })).toBe(0)
})

test('a NULL-height DETECTED bounty whose tx is still in mempool (lws reports height null) is left DETECTED, not funded', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-mempool-null', 5_000_000_000n)
  const account = await seedAccountWithViewKey()
  const bounty = await seedBounty({ postId, piconeros: 5_000_000_000n, height: null, recipientAccountId: account.id })

  // lws still sees the tx in the mempool (height null) — nothing to backfill.
  const lws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [{ payment_id: bounty.paymentId, height: null, piconeros: 5_000_000_000n }],
      blockchain_height: 9999
    })
  }
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(9999), lwsClient: lws })

  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.state).toBe('DETECTED')
  expect(after.height).toBeNull()
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.bountyStatus).toBe('UNFUNDED')
})

// Underpayment support: a funding paid in TWO txs whose webhook callbacks were
// all lost. The lws scan reports both txs carrying the bounty's payment id, so
// EVERY matching tx becomes a receipt (idempotent by txHash) and
// ObservedBounty.piconeros folds to the cumulative sum — recovering top-ups a
// single-tx resolver would have missed.
test('backfillNullBountyHeights records EVERY matching lws tx as a receipt: top-ups accumulate and height backfills to the max', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-receipt-backfill', 1_000_000_000_000n)
  const account = await seedAccountWithViewKey()
  const bounty = await seedBounty({ postId, piconeros: 0n, height: null, recipientAccountId: account.id })

  // Two partial payments (0.6 + 0.41 on a 1.0-declared bounty): cumulative
  // 1.01 = declared + fee, at heights 100 and 101.
  const lws = {
    getAddressTxs: async () => ({
      transactions: [
        { payment_id: bounty.paymentId, hash: 'ba'.repeat(31) + '1', height: 100, piconeros: 600_000_000_000n },
        { payment_id: bounty.paymentId, hash: 'ba'.repeat(31) + '2', height: 101, piconeros: 410_000_000_000n }
      ],
      blockchain_height: 150
    })
  }
  await backfillNullBountyHeights({ models: prisma, lws, bounties: [bounty] })

  const receipts = await prisma.observedBountyReceipt.findMany({ where: { bountyId: bounty.id } })
  expect(receipts).toHaveLength(2)
  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.piconeros).toBe(1_010_000_000_000n)
  expect(after.height).toBe(101)
})

// Fix-wave regression: a HEIGHT-SET but still-short DETECTED bounty. The first
// payment's 1-conf callback set the height (100), but the top-up's callbacks
// were ALL lost — and nothing else records it (the observer watches only the
// rewards wallet; reconcilePendingTips is tips-only). The reconcile pass must
// fold receipts for short DETECTED bounties REGARDLESS of height, or the gate
// never opens and the 7-day sweep abandons with refund < actually sent,
// silently (the payment predates the abandonment, so no alert fires either).
test('a HEIGHT-set short DETECTED bounty is reconciled too: both txs folded, height to max, idempotent', async () => {
  const before = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  feeConfigSnapshot = { bountyFeeMinPiconeros: before.bountyFeeMinPiconeros, bountyFeePct: before.bountyFeePct }
  await prisma.platformFeeConfig.update({ where: { id: 1 }, data: FEE_CONFIG })

  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-height-set-short', 1_000_000_000_000n)
  const account = await seedAccountWithViewKey()
  // 0.6 of the 1.01 quote received so far; height 100 came from the first
  // payment's own callback. lws still reports BOTH txs (0.6 at 100, 0.41 at 101).
  const bounty = await seedBounty({ postId, piconeros: 600_000_000_000n, height: 100, recipientAccountId: account.id })

  const lws = () => ({
    getAddressTxs: async () => ({
      transactions: [
        { payment_id: bounty.paymentId, hash: 'hs'.repeat(31) + '1', height: 100, piconeros: 600_000_000_000n },
        { payment_id: bounty.paymentId, hash: 'hs'.repeat(31) + '2', height: 101, piconeros: 410_000_000_000n }
      ],
      blockchain_height: 150
    })
  })
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(150), lwsClient: lws() })

  let receipts = await prisma.observedBountyReceipt.findMany({ where: { bountyId: bounty.id } })
  expect(receipts).toHaveLength(2)
  let after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.piconeros).toBe(1_010_000_000_000n)
  expect(after.height).toBe(101)

  // idempotent: a second pass records no duplicate rows and does not throw
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(150), lwsClient: lws() })
  receipts = await prisma.observedBountyReceipt.findMany({ where: { bountyId: bounty.id } })
  expect(receipts).toHaveLength(2)
  after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.piconeros).toBe(1_010_000_000_000n)
  expect(after.height).toBe(101)
})

// Fix round 1 regression (reconcile filter keys off the COUNT-ELIGIBLE sum, not
// the display fold): a MIXED funding — one height-verified receipt + one
// height-NULL receipt whose display fold crosses the quote while the counted sum
// does not — must still reach backfillNullBountyHeights. On the old display
// filter this bounty was excluded (display >= expected, height set), so the
// provisional receipt's height was never claimed from lws, PASS 2 refused to
// fund the counted-short sum, and at 7 days the sweep would abandon with the
// verified portion refunded and the top-up stranded in escrow.
test('a height-set bounty whose DISPLAY fold covers the quote but whose COUNTED sum is short is still reconciled (null-height receipt claimed via lws)', async () => {
  const authorId = await createUser(); created.users.push(authorId)
  const postId = await createBountyRoot(authorId, 'bounty-display-vs-counted', 1_000_000_000_000n)
  const account = await seedAccountWithViewKey()
  const config = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  const expected = 1_000_000_000_000n + bountyFeePiconeros(1_000_000_000_000n, config)
  // Split the quote across two receipts: verified (height 100) + provisional
  // (height NULL, its webhook callbacks all lost). Display fold = expected, so
  // the display-only filter skipped the reconcile; counted = verified only.
  const verified = expected / 2n
  const provisional = expected - verified
  const bounty = await seedBounty({ postId, piconeros: expected, height: 100, recipientAccountId: account.id })
  await prisma.observedBountyReceipt.create({
    data: { bountyId: bounty.id, txHash: 'dv'.repeat(31) + '1', piconeros: verified, height: 100 }
  })
  await prisma.observedBountyReceipt.create({
    data: { bountyId: bounty.id, txHash: 'dv'.repeat(31) + '2', piconeros: provisional, height: null }
  })

  // lws still sees both txs; the provisional one is now mined at height 101.
  const lws = {
    getAddressTxs: jest.fn().mockResolvedValue({
      transactions: [
        { payment_id: bounty.paymentId, hash: 'dv'.repeat(31) + '1', height: 100, piconeros: verified },
        { payment_id: bounty.paymentId, hash: 'dv'.repeat(31) + '2', height: 101, piconeros: provisional }
      ],
      blockchain_height: 150
    })
  }
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(150), lwsClient: lws })

  // The bounty reached the reconcile set: its escrow account was scanned and
  // the provisional receipt's height was claimed from lws. (Old filter: no scan
  // for this account, receipt stayed NULL, bounty stayed DETECTED.)
  const scannedIds = lws.getAddressTxs.mock.calls.map(c => c[0].id)
  expect(scannedIds).toContain(account.id)
  const receipts = await prisma.observedBountyReceipt.findMany({ where: { bountyId: bounty.id }, orderBy: { id: 'asc' } })
  expect(receipts.map(r => r.height)).toEqual([100, 101])

  // Counted now covers the quote, so the same run's funding pass funds it.
  const after = await prisma.observedBounty.findUnique({ where: { id: bounty.id } })
  expect(after.state).toBe('CONFIRMED')
  expect(after.height).toBe(101)
  const item = await prisma.item.findUnique({ where: { id: postId } })
  expect(item.bountyStatus).toBe('FUNDED')
})

test('invokes the reorg detector with the current chain height (Task D5 wiring)', async () => {
  const detectReorg = jest.fn()
  await runConfirmFinalizerOnce({ models: prisma, daemonClient: mockClient(210), detectReorg, lwsClient: emptyLws() })
  expect(detectReorg).toHaveBeenCalledWith(210)
})

// backfillNullBountyHeights: mocked-models unit tests for the lws height
// resolution (the path that unsticks a NULL-height bounty whose N-conf webhook
// callback was missed). Mirrors the reconcilePendingTips test style.
describe('backfillNullBountyHeights', () => {
  test('resolves a NULL-height bounty tx via lws (matched by payment_id) and backfills the row height', async () => {
    const bounty = { id: 1n, paymentId: 'bnabc', recipientAccountId: 7, height: null }
    const account = { id: 7, address: 'ESCROW', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
    const models = {
      moneroAccount: { findMany: async () => [account] },
      observedBounty: { update: jest.fn() }
    }
    const lws = { getAddressTxs: async () => ({ transactions: [{ payment_id: 'BNABC', height: 12345 }], blockchain_height: 9999 }) }
    await backfillNullBountyHeights({ models, lws, bounties: [bounty] })
    expect(models.observedBounty.update).toHaveBeenCalledWith({
      where: { id: 1n },
      data: expect.objectContaining({ height: 12345 })
    })
  })

  test('skips an account with no view key (unscannable) and never calls lws', async () => {
    const bounty = { id: 2n, paymentId: 'bndef', recipientAccountId: 8, height: null }
    const account = { id: 8, address: 'ESCROW', status: 'ACTIVE', viewKey: null }
    const models = { moneroAccount: { findMany: async () => [account] }, observedBounty: { update: jest.fn() } }
    const lws = { getAddressTxs: jest.fn() }
    await backfillNullBountyHeights({ models, lws, bounties: [bounty] })
    expect(lws.getAddressTxs).not.toHaveBeenCalled()
    expect(models.observedBounty.update).not.toHaveBeenCalled()
  })

  test('is robust to an lws error (skips that account, does not throw, retries next run)', async () => {
    const bounty = { id: 3n, paymentId: 'bnerr', recipientAccountId: 9, height: null }
    const account = { id: 9, address: 'ESCROW', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
    const models = { moneroAccount: { findMany: async () => [account] }, observedBounty: { update: jest.fn() } }
    const lws = { getAddressTxs: jest.fn().mockRejectedValue(new Error('lws down')) }
    await expect(backfillNullBountyHeights({ models, lws, bounties: [bounty] })).resolves.toBeUndefined()
    expect(models.observedBounty.update).not.toHaveBeenCalled()
  })

  test('does not backfill when lws has no matching payment_id (foreign/unknown tx)', async () => {
    const bounty = { id: 4n, paymentId: 'bnnope', recipientAccountId: 10, height: null }
    const account = { id: 10, address: 'ESCROW', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) } }
    const models = { moneroAccount: { findMany: async () => [account] }, observedBounty: { update: jest.fn() } }
    const lws = { getAddressTxs: async () => ({ transactions: [{ payment_id: 'other', height: 999 }], blockchain_height: 9999 }) }
    await backfillNullBountyHeights({ models, lws, bounties: [bounty] })
    expect(models.observedBounty.update).not.toHaveBeenCalled()
  })
})

// backfillNullObservationHeights: mocked-models unit tests for the NULL-height
// backfill of poll-detected DETECTED rows (ObservedDownvote, FeeObservation).
// NOTE: the plan's snippets mocked moneroAccount.findMany (mirroring
// backfillNullBountyHeights), but this backfill resolves the account via
// findRewardsAccount, which queries moneroAccount.findFirst — the mocks here
// match the actual interface. Everything else is verbatim from the plan.
describe('backfillNullObservationHeights', () => {
  test('backfills NULL heights for DETECTED downvotes and fees from the lws rewards scan, keyed by txHash', async () => {
    const downvote = { id: 1n, txHash: 'aaa', postId: 572, downvoterId: 860, state: 'DETECTED', height: null }
    const fee = { id: 2n, txHash: 'bbb', feeType: 'POSTING', state: 'DETECTED', height: null }
    const account = { id: 2047, label: 'platform_rewards', status: 'ACTIVE', viewKey: { ciphertext: 'x' } }
    const models = {
      moneroAccount: { findFirst: jest.fn().mockResolvedValue(account) },
      observedDownvote: { update: jest.fn().mockResolvedValue({}) },
      feeObservation: { update: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      item: { findUnique: jest.fn().mockResolvedValue(null) }
    }
    const lws = {
      getAddressTxs: jest.fn().mockResolvedValue({
        transactions: [
          { hash: 'aaa', height: 2186635, confirmations: 12, piconeros: 1_000_000_000n, payment_id: 'bb82f32561ab78d1' },
          { hash: 'bbb', height: null }, // still mempool on lws — must stay NULL
          { hash: 'ccc', height: 2186640 } // unrelated tx — no row to update
        ]
      })
    }

    await backfillNullObservationHeights({ models, lws, downvotes: [downvote], fees: [fee] })

    // The downvote height is resolved through the shared transition CAS (which
    // owns the penalty) — never a bare observedDownvote.update.
    expect(models.observedDownvote.update).not.toHaveBeenCalled()
    const [strings, ...vals] = models.$queryRaw.mock.calls[0]
    const sql = strings.join(' ')
    expect(sql).toContain('UPDATE "ObservedDownvote"')
    expect(sql).toContain('height IS NULL')
    expect(vals).toEqual(expect.arrayContaining([2186635, 1_000_000_000n, 12, 1n]))
    expect(models.feeObservation.update).not.toHaveBeenCalled() // bbb still mempool
  })

  test('applies the penalty exactly once across two runs (the second run is a no-op)', async () => {
    const downvote = { id: 1n, txHash: 'aaa', postId: 572, downvoterId: 860, state: 'DETECTED', height: null }
    const account = { id: 2047, label: 'platform_rewards', status: 'ACTIVE', viewKey: { ciphertext: 'x' } }
    // The fake row state: the first CAS claims the transition (height now set);
    // every later CAS on the same row matches 0 rows.
    let heightSet = false
    const models = {
      moneroAccount: { findFirst: jest.fn().mockResolvedValue(account) },
      $queryRaw: jest.fn(async () => {
        if (heightSet) return []
        heightSet = true
        return [{ id: 1n }]
      }),
      item: { findUnique: jest.fn().mockResolvedValue({ id: 572, parentId: null }) },
      $executeRaw: jest.fn().mockResolvedValue(1)
    }
    const lws = {
      getAddressTxs: jest.fn().mockResolvedValue({
        transactions: [{ hash: 'aaa', height: 2186635, confirmations: 12, piconeros: 1_000_000_000n }]
      })
    }

    await backfillNullObservationHeights({ models, lws, downvotes: [downvote], fees: [] })
    await backfillNullObservationHeights({ models, lws, downvotes: [downvote], fees: [] })

    expect(models.$queryRaw).toHaveBeenCalledTimes(2) // both runs attempt the CAS
    expect(models.item.findUnique).toHaveBeenCalledTimes(1) // only the winner reaches the penalty
    expect(models.$executeRaw).toHaveBeenCalledTimes(1) // the ranking CTE ran exactly once
  })

  test('skips unscannable accounts (no view key) without throwing', async () => {
    const models = {
      moneroAccount: { findFirst: jest.fn().mockResolvedValue({ id: 2047, status: 'ACTIVE', viewKey: null }) },
      observedDownvote: { update: jest.fn() },
      feeObservation: { update: jest.fn() }
    }
    const lws = { getAddressTxs: jest.fn() }

    await expect(backfillNullObservationHeights({ models, lws, downvotes: [{ id: 1n, txHash: 'aaa' }], fees: [] })).resolves.toBeUndefined()
    expect(lws.getAddressTxs).not.toHaveBeenCalled()
  })
})
