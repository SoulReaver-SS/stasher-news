/* eslint-env jest */

// Integration test for the weekly rewardsDistributor (Phase 4 Task 8 / spec §5).
//
// runDistributionOnce is the testable core: it tallies a week of CONFIRMED
// platform inflow (downvotes + posting/territory fees) by source, applies
// the PlatformFeeConfig allocation split, adds the prior period's rollover to
// form the pool, calls computeCuratorShares (Task 7) to apportion it to the
// curators of top content, and writes one RewardDistribution row + QUEUED
// RewardPayout rows (one per curator WITH a registered receiving address).
// Curators with no registered address are excluded — their share rolls over.
//
// Task 9 wires the hot-wallet signer: runDistributionOnce now calls sendPayouts
// (injected here as a stub so no real stagenet keys/wallet are needed) and flips
// the distribution PENDING -> SENDING -> COMPLETE, with payouts QUEUED -> SENT.
//
// Real DB integration test mirroring test/worker/curatorShares.test.js and
// test/worker/rewardsWalletObserver.fee.test.js (live migrated database, FK-safe
// teardown). Run via the app container:
//   docker exec -u apprunner app npx jest test/worker/rewardsDistributor.test.js
//
// The ops-earmark sweep is NOT part of finalization (2026-09-14 decoupling):
// worker/opsSweep.js owns it as a delayed one-shot enqueued by the shared
// completion path (completeAndEnqueue) once an eligible distribution is COMPLETE.

import { PrismaClient } from '@prisma/client'
import * as util from 'node:util'
import { runDistributionOnce, finalizeDistribution, recoverStaleDistributions, requeueFailedPayouts, warnUndeliveredDistributions } from '@/worker/rewardsDistributor'
import { applyTipDetected } from '@/api/monero/ranking'
import { getNextRewardsPool } from '@/lib/rewardsPool'
import { USER_ID } from '@/lib/constants'

// lib/alert is mocked so operator pages are assertable without a network side
// effect (same pattern as test/worker/reconcilePendingTips.test.js).
import { alert } from '@/lib/alert'
import { logError, logWarn } from '@/lib/logger'
jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))
// The shared logger is mocked so the secret-safe diagnostics can be asserted:
// no credential-shaped value may appear in any log call.
jest.mock(`${process.cwd()}/lib/logger`, () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

// The beforeAll hook seeds + runs a real distribution against the live dev DB;
// on a busy stack (residue purge, seeding, curator-share computation) it can
// exceed Jest's 5s default. Give the hooks headroom.
jest.setTimeout(30000)

const prisma = new PrismaClient()

// The Task 7 checkpoint fixtures + their tests run only against the dedicated
// isolated database (same conditional-skip convention as the other repair
// suites). On a shared dev DB nothing journal-related is seeded with the live
// wallet identity, and the inherited tests keep their original fixture shape.
const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

// Task 7 fee-journal fixtures. Every fixture hash carries the 'deadbead'
// prefix (8 hex chars — a real 64-hex hash collides ~2e-10) so an interrupted
// run's residue is purgeable without touching a real journal row.
const JOURNAL_TX_PREFIX = 'deadbead'
const testHash = suffix => (JOURNAL_TX_PREFIX + suffix).padEnd(64, '0')

// The exact checkpoint arithmetic (spec §5): prior opsAvailable20, opsSwept10,
// cost checkpoint4, cumulative fees7 (sweep 4 + consolidation 3) => carry 7.
const PRIOR_OPS_AVAILABLE_PICONEROS = 20n
const PRIOR_OPS_SWEPT_PICONEROS = 10n
const PRIOR_OPS_FEES_CHECKPOINT_PICONEROS = 4n
const PRIOR_SWEEP_HASH = testHash('1')
const LATE_FEE_HASH = testHash('3')
const PRIOR_SWEEP_FEE_PICONEROS = 4n
const CONSOLIDATION_FEE_PICONEROS = 3n
const LATE_FEE_PICONEROS = 2n

// Resolved in beforeAll from the DB's registered platform wallet (or a
// throwaway test address on a DB with none): the journal read is scoped by
// wallet/network, and the reader refuses a configured identity that disagrees
// with a registered platform_rewards account.
let TEST_NETWORK = 'STAGENET'
let TEST_WALLET_ADDRESS = '5' + '8888' + 'A'.repeat(90)
let expectedCumulativeFees = 0n
let expectedOpsRolledOver = 0n

// 95-char Monero address placeholder, made unique per call via a counter.
let addrSeq = 0
function makeAddress () {
  addrSeq += 1
  return '5' + String(addrSeq).padStart(4, '0') + 'A'.repeat(90)
}

// Seeds a distribution shaped like the 2026-09-28 incident: one SENT payout,
// one FAILED payout (optionally with a txHash — the refused double-pay class),
// and the Earn rows that were written at distribution time. periodEnd is 39
// days ago — outside the weekly idempotency window. Tracks rows in `created`
// for afterAll teardown (Earns by distributionId first — existing order).
async function seedStrandedDistribution ({ status = 'FAILED', failedTxHash = null } = {}) {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 40 * DAY),
      periodEnd: new Date(Date.now() - 39 * DAY),
      poolPiconeros: 3_000_000_000n,
      distributedPiconeros: 3_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 2,
      status,
      ...(status === 'SENDING' ? { startedAt: new Date(Date.now() - 5 * 60 * 1000) } : {}),
      ...(status === 'COMPLETE' ? { completedAt: new Date(Date.now() - DAY) } : {})
    }
  })
  created.distributions.push(dist.id)
  const sent = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'SENT', txHash: 'ab'.repeat(32) }
  })
  const failed = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 2_000_000_000n, state: 'FAILED', ...(failedTxHash ? { txHash: failedTxHash } : {}) }
  })
  await prisma.earn.createMany({
    data: [
      { userId: curatorId, piconeros: 1_000_000_000n, type: 'TIP_COMMENT', rank: 1, typeId: null, distributionId: dist.id, createdAt: new Date(Date.now() - 39 * DAY) },
      { userId: curatorId, piconeros: 2_000_000_000n, type: 'TIP_POST', rank: 2, typeId: null, distributionId: dist.id, createdAt: new Date(Date.now() - 39 * DAY) }
    ]
  })
  return { dist, sent, failed, curatorId }
}

const DAY = 24 * 60 * 60 * 1000

// Monday 00:00 UTC of the week containing `date` — the allocation boundary the
// distributor's idempotency guard uses.
function utcWeekStart (date) {
  const weekStart = new Date(date)
  weekStart.setUTCHours(0, 0, 0, 0)
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7))
  return weekStart
}

// Fixed UTC Tuesday for the two allocation-boundary tests. Freezing Date keeps
// fixture creation and the run in the same UTC week even if a test straddles a
// Sunday→Monday rollover. 2099 keeps the synthetic week clear of real dev
// distributions. Prisma's IO/timeout timers stay real.
const FIXED_NOW = new Date('2099-01-06T12:00:00.000Z')
const REAL_TIMER_APIS = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']

// Wednesday noon of the beforeAll distribution's UTC week. Freezing the two
// inherited same-week tests here keeps `result` in the guard's current week
// even when the suite crosses a Sunday→Monday boundary.
function resultWeekNoon () {
  const weekStart = utcWeekStart(result.periodEnd)
  return new Date(weekStart.getTime() + 2 * DAY + 12 * 60 * 60 * 1000)
}

// Tracks every row created across tests so afterAll can tear them down in
// FK-safe order.
const created = {
  users: [],
  items: [],
  accounts: [],
  tips: [],
  payIns: [],
  fees: [],
  downvotes: [],
  distributions: [],
  journals: []
}

let result // the distribution returned by runDistributionOnce (beforeAll)
let seededCurators // { c1, c2, c3 } — c3 has NO registered payout address
let genuineRewardsShare // rewards share of genuine (non-fixture) inflow in the period (beforeAll)
let genuineOpsShare // ops share of genuine (non-fixture) inflow in the period (beforeAll)
let priorTrustFloor = null
let priorRewardsAddress
let priorNetworkEnv

// Task 9 stub signer: records that it was invoked and marks each QUEUED payout
// SENT with a stable fake tx hash. Injected into runDistributionOnce so the
// wiring (SENDING -> COMPLETE, payouts -> SENT) is verified without real XMR.
let signerInvocations = 0
const fakeSigner = async (payouts, { models } = {}) => {
  signerInvocations += 1
  for (const p of payouts) {
    if (p.state === 'QUEUED') {
      await models.rewardPayout.update({ where: { id: p.id }, data: { state: 'SENT', txHash: 'ab'.repeat(32) } })
    }
  }
  return { sent: payouts.length, failed: 0, skipped: 0 }
}

// Seed amounts (piconeros). Picked so the allocation math is exact:
//   rewardsInflow = 5e12*100/100 + 4e12*70/100 + 2e12*30/100
//                 + 3e12 (DONATE @100%) + 1e12*50/100 (DONATE @50%)
//                 + 1e12*30/100 (BOOST @30%) + 2e12*70/100 (TIP_UNWALLETED @70%)
//                 + 2.5e12 (BOUNTY_ROLLOVER exact reward component)
//                 = 5e12 + 2.8e12 + 0.6e12 + 3e12 + 0.5e12 + 0.3e12 + 1.4e12 + 2.5e12 = 16.1e12
//   pool          = 16.1e12 + 1e12 (prior rollover) = 17.1e12
//   totalInflow   = rewardsInflow + 0.5e12 (BOUNTY_FEE @0% rewards, 100% ops)
//                 = 21e12
//   opsInflow     = totalInflow - rewardsInflow = 0.5e12 (BOUNTY_FEE) + 1.2e12 (posting)
//                   + 1.4e12 (territory) + 0.5e12 (half DONATE) + 0.7e12 (BOOST)
//                   + 0.6e12 (TIP_UNWALLETED) = 4.9e12
// The BOUNTY_FEE fixture is the GENUINE hot fallback receipt (walletReceipt
// true); an equal-nominal funding accrual with walletReceipt=false is seeded
// alongside it and must never enter settlement inflow. The BOUNTY_ROLLOVER row
// stores the full actual net receipt with its exact rewards component.
const DOWNVOTE_PICONEROS = 5_000_000_000_000n
const POSTING_FEE_PICONEROS = 4_000_000_000_000n
const TERRITORY_FEE_PICONEROS = 2_000_000_000_000n
const EXTRA_DONATE_PICONEROS = 3_000_000_000_000n
const HALF_DONATE_PICONEROS = 1_000_000_000_000n // 1e12, donationRewardsPct=50 -> 0.5e12 pool / 0.5e12 ops
const BOOST_FEE_PICONEROS = 1_000_000_000_000n
const PRIOR_ROLLOVER_PICONEROS = 1_000_000_000_000n
const WALLETLESS_TIP_PICONEROS = 2_000_000_000_000n
const BOUNTY_ROLLOVER_PICONEROS = 2_500_000_000_000n
const BOUNTY_FEE_PICONEROS = 500_000_000_000n
const EXPECTED_POOL_PICONEROS = 17_100_000_000_000n
// Ops earmark = totalInflow - rewardsInflow.
//   downvote (100% rewards -> 0 ops) + posting 4e12*30% + territory 2e12*70% + donate 1e12*50% (half) + boost 1e12*70% + walletless 2e12*30% + bounty rollover (100% rewards -> 0 ops) + bounty fee (100% ops) = 1.2e12 + 1.4e12 + 0.5e12 + 0.7e12 + 0.6e12 + 0.5e12 = 4.9e12
const EXPECTED_OPS_INFLOW_PICONEROS = 4_900_000_000_000n

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

async function createRootPost (userId, weightedVotes, createdAt) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "weightedVotes", "created_at")
    VALUES (${userId}::int, ${'rewards test post'}, ${weightedVotes}::float, ${createdAt})
    RETURNING id::int AS id`
  const id = rows[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(id)}::ltree WHERE id = ${id}::int`
  created.items.push(id)
  return id
}

async function createRecipientAccount () {
  const account = await prisma.moneroAccount.create({
    data: { ownerUserId: null, address: makeAddress(), label: 'author', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(account.id)
  return account
}

// A curator's RECEIVING account (ownerUserId set) so rewardsDistributor can pay
// them. Curators created WITHOUT this are excluded from payouts.
async function createPayoutAccount (ownerUserId) {
  const account = await prisma.moneroAccount.create({
    data: { ownerUserId, address: makeAddress(), label: 'curator-payout', network: 'STAGENET', status: 'ACTIVE' }
  })
  created.accounts.push(account.id)
  return account
}

// FK-safe removal of distribution fixtures created inside a test. Used by the
// fixed-week boundary tests so a 2099 fixture cannot remain the global latest
// and shadow the real-now fixtures of later tests.
async function deleteDistributionRows (ids) {
  if (!ids.length) return
  await prisma.earn.deleteMany({ where: { distributionId: { in: ids } } })
  await prisma.rewardPayout.deleteMany({ where: { distributionId: { in: ids } } })
  await prisma.rewardDistribution.deleteMany({ where: { id: { in: ids } } })
}

let tipSeq = 0
async function seedTip ({ postId, tipperId, piconeros, confirmedAt, recipientAccountId }) {
  tipSeq += 1
  const tip = await prisma.observedTip.create({
    data: {
      txHash: 'rdtip' + String(tipSeq),
      postId,
      tipperId,
      recipientAccountId,
      recipientMajor: 0,
      recipientMinor: 0,
      paymentId: 'rdtest' + String(tipSeq).padStart(6, '0') + '0000000000',
      piconeros,
      height: 3000,
      confirmations: 10,
      state: 'CONFIRMED',
      proofType: 'INDEXED',
      confirmedAt
    }
  })
  created.tips.push(tip.id)
  return tip
}

async function seedPayIn (userId, payInType, major, minor) {
  const payIn = await prisma.payIn.create({
    data: { userId, payInType, payInState: 'PAID', piconeros: 0n, moneroSubaddressMajor: major, moneroSubaddressMinor: minor }
  })
  created.payIns.push(payIn.id)
  return payIn
}

let feeSeq = 0
async function seedFee (payInId, feeType, major, piconeros, confirmedAt, { donationRewardsPct, walletReceipt = true, rewardsPiconeros } = {}) {
  feeSeq += 1
  const fee = await prisma.feeObservation.create({
    data: {
      txHash: 'rdfee' + String(feeSeq),
      payInId,
      feeType,
      recipientMajor: major,
      recipientMinor: feeSeq,
      piconeros,
      donationRewardsPct,
      walletReceipt,
      rewardsPiconeros,
      height: 3000,
      confirmations: 10,
      state: 'CONFIRMED',
      confirmedAt
    }
  })
  created.fees.push(fee.id)
  return fee
}

// A hot-wallet journal fact (Task 7): scoped to the suite's configured
// wallet, torn down by id and by the hash prefix. `relayAttemptedAt` marks an
// attempted-but-unproven PREPARED row (Task 10 completion-readiness fixtures).
async function seedJournalTransaction ({ txHash, kind, state = 'RELAYED', distributionId = null, principalPiconeros = 0n, networkFeePiconeros = 0n, metadata, relayAttemptedAt = null }) {
  const row = await prisma.rewardsWalletTransaction.create({
    data: {
      network: TEST_NETWORK,
      walletAddress: TEST_WALLET_ADDRESS,
      txHash,
      kind,
      accountIndex: 0,
      distributionId,
      principalPiconeros,
      networkFeePiconeros,
      metadata,
      state,
      relayAttemptedAt
    }
  })
  created.journals.push(row.id)
  return row
}

let downvoteSeq = 0
async function seedDownvote (postId, piconeros, confirmedAt) {
  downvoteSeq += 1
  const downvote = await prisma.observedDownvote.create({
    data: {
      txHash: 'rddv' + String(downvoteSeq),
      postId,
      paymentId: 'rddv' + String(downvoteSeq).padStart(8, '0'),
      piconeros,
      height: 3000,
      confirmations: 10,
      state: 'CONFIRMED',
      confirmedAt
    }
  })
  created.downvotes.push(downvote.id)
  return downvote
}

// Self-healing purge of residue from a prior INTERRUPTED run of this test.
// afterAll's teardown deletes by the in-memory `created` lists, which are
// empty/incomplete if the process was killed, the app container restarted, or
// beforeAll threw after partial seeding. Those orphaned fixtures then flow into
// the dev DB's /rewards pool display (rdfee FeeObservations feed rewards.total)
// and accumulate across runs. This runs first in beforeAll and deletes by STABLE
// patterns (txHash prefixes, the test item title, the prior-distribution shape),
// chasing FK linkages, so every run starts from a clean slate. Idempotent:
// deletes nothing on a fresh DB.

async function purgePriorResidue () {
  // Capture linkages from prior-run fixtures BEFORE deleting them.
  const priorFees = await prisma.feeObservation.findMany({ where: { txHash: { startsWith: 'rdfee' } }, select: { payInId: true } })
  const feePayInIds = [...new Set(priorFees.map(f => f.payInId))]
  const priorTips = await prisma.observedTip.findMany({ where: { txHash: { startsWith: 'rdtip' } }, select: { tipperId: true, postId: true } })
  const tipperIds = [...new Set(priorTips.map(t => t.tipperId).filter(Boolean))]
  const testPostIds = [...new Set(priorTips.map(t => t.postId).filter(Boolean))]
  const priorAuthorIds = (await prisma.item.findMany({ where: { title: 'rewards test post' }, select: { userId: true } })).map(i => i.userId)
  // Never delete the migration-seeded founder account, even when a prior run's
  // rdtip fixtures name it as a tipper.
  const testUserIds = [...new Set([...tipperIds, ...priorAuthorIds])].filter(id => id !== USER_ID.stasher)

  // Prior-run "prior" distributions (8 days old, so missed by the 7-day stale
  // cleanup below) plus their payouts/earn.
  const staleDists = await prisma.rewardDistribution.findMany({
    where: { poolPiconeros: PRIOR_ROLLOVER_PICONEROS, distributedPiconeros: 0n, payoutCount: 0, status: 'COMPLETE' },
    select: { id: true }
  })
  const staleDistIds = staleDists.map(d => d.id)

  // FK-safe deletion (mirrors afterAll's proven cascade behavior). The journal
  // goes FIRST: a fixture journal row may reference a distribution being
  // deleted (the FK is SET NULL, but the row would survive as residue).
  await prisma.rewardsWalletTransaction.deleteMany({ where: { txHash: { startsWith: JOURNAL_TX_PREFIX } } })
  await prisma.earn.deleteMany({ where: { OR: [{ distributionId: null }, { distributionId: { in: staleDistIds } }] } })
  if (staleDistIds.length) {
    await prisma.rewardPayout.deleteMany({ where: { distributionId: { in: staleDistIds } } })
    await prisma.rewardDistribution.deleteMany({ where: { id: { in: staleDistIds } } })
  }
  // Fee/tip/downvote fixtures (clears Item/ObservedTip FK RESTRICTs first).
  await prisma.feeObservation.deleteMany({ where: { txHash: { startsWith: 'rdfee' } } })
  await prisma.observedTip.deleteMany({ where: { txHash: { startsWith: 'rdtip' } } })
  await prisma.observedDownvote.deleteMany({ where: { txHash: { startsWith: 'rddv' } } })
  // PayIns linked to the rdfee fees.
  if (feePayInIds.length) await prisma.payIn.deleteMany({ where: { id: { in: feePayInIds } } })
  // Test items (cascade-clears ItemUserAgg).
  if (testPostIds.length) await prisma.item.deleteMany({ where: { id: { in: testPostIds } } })
  await prisma.item.deleteMany({ where: { title: 'rewards test post' } })
  // Test MoneroAccounts (recipient accounts with ownerUserId NULL + payout
  // accounts owned by test users) all use makeAddress's deterministic throwaway
  // address: '5' + digits + 90 'A's. No real Monero address ends in 90 identical
  // chars, so the trailing-A signature is unambiguous AND reaches the NULL-owned
  // recipient accounts that testUserIds cannot.
  // Fee subaddresses before the accounts they lock: an interrupted fee-pool
  // test can leave SubaddressIndex rows on A{90}$ accounts, which would abort
  // the account delete below on SubaddressIndex_accountId_fkey.
  await prisma.$executeRaw`DELETE FROM "SubaddressIndex" WHERE "accountId" IN (SELECT id FROM "MoneroAccount" WHERE address ~ 'A{90}$')`
  await prisma.$executeRaw`DELETE FROM "MoneroAccount" WHERE address ~ 'A{90}$'`
  // Test users (safe now: their items/tips/earn/payins/accounts are gone).
  if (testUserIds.length) await prisma.user.deleteMany({ where: { id: { in: testUserIds } } })
}

beforeAll(async () => {
  // Self-heal any residue from a prior interrupted run before seeding anew.
  await purgePriorResidue()

  // Resolve the ledger scope before any seeding. The reader refuses a
  // configured identity that disagrees with a registered platform_rewards
  // account, so use that account's address when the DB has one (the dev DB)
  // and a throwaway address otherwise (the isolated DB). Env is restored in
  // afterAll.
  priorRewardsAddress = process.env.PLATFORM_REWARDS_ADDRESS
  priorNetworkEnv = process.env.MONERO_NETWORK
  const registeredPlatform = await prisma.moneroAccount.findFirst({
    where: { label: 'platform_rewards' },
    select: { address: true, network: true }
  })
  if (registeredPlatform) {
    TEST_NETWORK = registeredPlatform.network
    TEST_WALLET_ADDRESS = registeredPlatform.address
  } else {
    // The reader refuses an ABSENT registered platform_rewards identity (the
    // shared v2 audit snapshot proves it before any read), so this suite
    // registers the configured wallet itself and tears it down in afterAll.
    const account = await prisma.moneroAccount.create({
      data: { ownerUserId: null, address: TEST_WALLET_ADDRESS, label: 'platform_rewards', network: TEST_NETWORK, status: 'ACTIVE' }
    })
    created.accounts.push(account.id)
  }
  process.env.MONERO_NETWORK = TEST_NETWORK.toLowerCase()
  process.env.PLATFORM_REWARDS_ADDRESS = TEST_WALLET_ADDRESS

  // Snapshot the operator's floor so afterAll can restore it — this suite
  // runs against the shared dev DB and must leave no trace (AGENTS norm).
  const priorConfigRow = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  priorTrustFloor = priorConfigRow?.curatorTrustWeightFloor ?? null

  // Ensure the PlatformFeeConfig singleton exists with schema defaults
  // (downvoteRewardsPct=100, postingFeeRewardsPct=70, territoryFeeRewardsPct=30,
  //  distributionMinPayoutPiconeros=1e9, distributionTopN=10).
  // curatorTrustWeightFloor is PINNED to 1.0 for this suite: only c1 has a
  // seeded UserSubTrust row, so any other floor would discount c2/c3 and break
  // the exact-pool assertions regardless of operator config.
  await prisma.platformFeeConfig.upsert({ where: { id: 1 }, update: { curatorTrustWeightFloor: 1.0 }, create: { id: 1 } })

  // Clear any RESULT distribution left over from a prior run whose periodEnd
  // falls inside the coming week (otherwise runDistributionOnce's idempotency
  // guard would short-circuit and reuse a stale row). The 8-day-old "prior"
  // distribution shape is purged by purgePriorResidue above.
  const weekAgo = new Date(Date.now() - 7 * DAY)
  const stale = await prisma.rewardDistribution.findMany({ where: { periodEnd: { gte: weekAgo } } })
  for (const d of stale) {
    await prisma.rewardPayout.deleteMany({ where: { distributionId: d.id } })
    await prisma.rewardDistribution.deleteMany({ where: { id: d.id } })
  }

  // Prior period's distribution carrying a rollover into this week's pool.
  // On the isolated DB it also carries the Task 7 ops snapshot: opsAvailable20,
  // opsSwept10 (the sweep hash is represented in the journal), checkpoint4. The
  // fixture journal fees total 7 (sweep 4 + consolidation 3), so the
  // fee-adjusted carry is 7. On a shared DB the inherited shape (no ops
  // snapshot) is kept and no journal rows are seeded.
  const priorEnd = new Date(Date.now() - 8 * DAY)
  const priorStart = new Date(Date.now() - 15 * DAY)
  const priorData = {
    periodStart: priorStart,
    periodEnd: priorEnd,
    poolPiconeros: PRIOR_ROLLOVER_PICONEROS,
    distributedPiconeros: 0n,
    rolledOverPiconeros: PRIOR_ROLLOVER_PICONEROS,
    payoutCount: 0,
    status: 'COMPLETE'
  }
  if (ISOLATED_DB) {
    Object.assign(priorData, {
      opsAvailablePiconeros: PRIOR_OPS_AVAILABLE_PICONEROS,
      opsSweptPiconeros: PRIOR_OPS_SWEPT_PICONEROS,
      opsSweepTxHash: PRIOR_SWEEP_HASH,
      opsNetworkFeesAccountedPiconeros: PRIOR_OPS_FEES_CHECKPOINT_PICONEROS
    })
  }
  const prior = await prisma.rewardDistribution.create({ data: priorData })
  created.distributions.push(prior.id)
  if (ISOLATED_DB) {
    // Task 7 journal facts inside the configured wallet scope: a proven sweep
    // already represented by the recorded opsSweepTxHash (counted once), and a
    // consolidation fee (fee-only). Total RELAYED cost 7.
    await seedJournalTransaction({
      txHash: PRIOR_SWEEP_HASH,
      kind: 'OPS_SWEEP',
      distributionId: prior.id,
      principalPiconeros: PRIOR_OPS_SWEPT_PICONEROS,
      networkFeePiconeros: PRIOR_SWEEP_FEE_PICONEROS,
      metadata: { destination: '5COLDTEST' }
    })
    await seedJournalTransaction({
      txHash: testHash('2'),
      kind: 'CONSOLIDATION',
      principalPiconeros: 0n,
      networkFeePiconeros: CONSOLIDATION_FEE_PICONEROS,
      metadata: { destination: TEST_WALLET_ADDRESS, selfTransfer: true }
    })
  }

  // --- Inflow for THIS week (all CONFIRMED, confirmedAt inside the period) ---
  const inPeriod = new Date(Date.now() - 2 * DAY)

  // Author + ranked root post (the tipped content) + author receiving account.
  // weightedVotes starts at 0 — it is populated through the REAL path
  // (applyTipDetected below) rather than seeded directly, so this fixture no
  // longer masks the bug that nothing writes weightedVotes.
  const authorId = await createUser()
  const recipientAccount = await createRecipientAccount()
  const postId = await createRootPost(authorId, 0, new Date(Date.now() - 3 * DAY))

  // Downvote payment (platform rewards wallet inflow) attributed to the post.
  await seedDownvote(postId, DOWNVOTE_PICONEROS, inPeriod)

  // Posting fee + territory fee (need distinct PayIns for the FK).
  const postingPayIn = await seedPayIn(authorId, 'ITEM_CREATE', 1, 1)
  const territoryPayIn = await seedPayIn(authorId, 'TERRITORY_CREATE', 2, 1)
  await seedFee(postingPayIn.id, 'POSTING', 1, POSTING_FEE_PICONEROS, inPeriod)
  await seedFee(territoryPayIn.id, 'TERRITORY_CREATE', 2, TERRITORY_FEE_PICONEROS, inPeriod)

  // Donation (extra source: funds the pool 1:1, no allocation %). Lands on the
  // DONATE fee subaddress major (3) per the fee-subaddress convention.
  const donatePayIn = await seedPayIn(authorId, 'DONATE', 3, 1)
  await seedFee(donatePayIn.id, 'DONATE', 3, EXTRA_DONATE_PICONEROS, inPeriod)

  // A second donation with a payer-chosen 50% rewards split (fee-allocation v2).
  const halfDonatePayIn = await seedPayIn(authorId, 'DONATE', 3, 2)
  await seedFee(halfDonatePayIn.id, 'DONATE', 3, HALF_DONATE_PICONEROS, inPeriod, { donationRewardsPct: 50 })

  // Boost (boostRewardsPct, default 30): funds the pool at 30%, the other 70%
  // is ops. Lands on the BOOST fee subaddress major (5) per the fee-subaddress
  // convention.
  const boostPayIn = await seedPayIn(authorId, 'BOOST', 5, 1)
  await seedFee(boostPayIn.id, 'BOOST', 5, BOOST_FEE_PICONEROS, inPeriod)

  // Wallet-less-author tip (TIP_UNWALLETED): funds the pool at
  // walletlessTipRewardsPct (default 70). Lands on its dedicated major-4
  // subaddress; payInId is null because a wallet-less tip creates no PayIn.
  await seedFee(null, 'TIP_UNWALLETED', 4, WALLETLESS_TIP_PICONEROS, inPeriod)

  // Bounty rollover (BOUNTY_ROLLOVER): the escrow's bounty portion physically
  // arrived at the rewards wallet — stores the full actual net receipt in
  // `piconeros` and its exact rewards component in `rewardsPiconeros`.
  // payInId is null because a rollover creates no PayIn.
  await seedFee(null, 'BOUNTY_ROLLOVER', 0, BOUNTY_ROLLOVER_PICONEROS, inPeriod, { rewardsPiconeros: BOUNTY_ROLLOVER_PICONEROS })

  // Bounty fee (BOUNTY_FEE): the GENUINE hot fallback receipt (walletReceipt
  // defaults true) — it physically arrived at the wallet and is 100% ops
  // (0% pool). The equal-nominal funding-time accrual below never arrived and
  // must not count as settlement inflow.
  await seedFee(null, 'BOUNTY_FEE', 0, BOUNTY_FEE_PICONEROS, inPeriod)
  await seedFee(null, 'BOUNTY_FEE', 0, BOUNTY_FEE_PICONEROS, inPeriod, { walletReceipt: false })

  // --- Curators (tippers): c1, c2 get payout accounts; c3 does NOT ---
  const c1 = await createUser()
  const c2 = await createUser()
  const c3 = await createUser()
  seededCurators = { c1, c2, c3 }
  await createPayoutAccount(c1)
  await createPayoutAccount(c2)
  // c3: intentionally no MoneroAccount(ownerUserId: c3) -> excluded from payouts.

  // Real path (merged rewards plan Task 2): give c1 territory trust in 'stasher'
  // and apply a detected tip so Item.weightedVotes is bumped via
  // zapTrust × LOG(tipPiconeros) — exactly what the webhook receiver does on a
  // live tip. This is what makes the post qualify for curator rewards.
  await prisma.userSubTrust.create({
    data: { subName: 'stasher', userId: c1, zapPostTrust: 1.0, subZapPostTrust: 1.0 }
  })
  await applyTipDetected(postId, c1, 1_000_000_000n)

  // Equal-weight confirmed tips from each curator on the top post, inside the period.
  await seedTip({ postId, tipperId: c1, piconeros: 2_000_000_000_000n, confirmedAt: inPeriod, recipientAccountId: recipientAccount.id })
  await seedTip({ postId, tipperId: c2, piconeros: 2_000_000_000_000n, confirmedAt: new Date(inPeriod.getTime() + 60000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId, tipperId: c3, piconeros: 2_000_000_000_000n, confirmedAt: new Date(inPeriod.getTime() + 120000), recipientAccountId: recipientAccount.id })

  // --- Run the distribution (Task 9 signer stub injected) ---
  result = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, scheduleOpsSweep: false })
  created.distributions.push(result.id)

  // Task 7 drift-robust checkpoint expectations: the cumulative RELAYED fees in
  // the configured scope at the moment of the run (the 7 fixture piconeros on
  // the isolated DB, plus any real journal rows on a shared dev DB) and the
  // fee-adjusted carry they price into opsAvailable. On a shared DB the
  // inherited prior shape has no ops snapshot, so only the fees debit it:
  //   isolated: carry = 20 - 10 - (Fnow - 4)   shared: carry = 0 - 0 - (Fnow - 0)
  const feeAggregate = await prisma.rewardsWalletTransaction.aggregate({
    _sum: { networkFeePiconeros: true },
    where: { network: TEST_NETWORK, walletAddress: TEST_WALLET_ADDRESS, state: 'RELAYED' }
  })
  expectedCumulativeFees = feeAggregate._sum.networkFeePiconeros ?? 0n
  const priorOps = ISOLATED_DB
    ? {
        available: PRIOR_OPS_AVAILABLE_PICONEROS,
        swept: PRIOR_OPS_SWEPT_PICONEROS,
        checkpoint: PRIOR_OPS_FEES_CHECKPOINT_PICONEROS
      }
    : { available: 0n, swept: 0n, checkpoint: 0n }
  expectedOpsRolledOver = priorOps.available - priorOps.swept - (expectedCumulativeFees - priorOps.checkpoint)

  // Genuine (non-fixture) confirmed inflow inside the distribution's period:
  // the suite assumes it is the sole inflow source, but real
  // stagenet activity on the dev stack (posting fees, downvotes) lands in the
  // window and breaks the absolute pool constants. Recompute its rewards share
  // by source — excluding the rdfee/rddv fixture prefixes, grouping territory
  // types before the split exactly like the distributor — and fold it into the
  // expected-pool math below (the drift-robust pattern of the opsInflow test).
  // The seeded sources stay pinned exactly.
  const configRow = await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })
  // Mirror the shared reader's eligibility exactly: only walletReceipt=true
  // rows are hot-wallet receipts (funding-time accruals are historical
  // evidence, never cash).
  const genuineFeeGroups = await prisma.feeObservation.groupBy({
    by: ['feeType'],
    _sum: { piconeros: true },
    where: {
      state: 'CONFIRMED',
      walletReceipt: true,
      confirmedAt: { gte: result.periodStart, lt: result.periodEnd },
      txHash: { not: { startsWith: 'rdfee' } }
    }
  })
  const genuineFees = Object.fromEntries(genuineFeeGroups.map(g => [g.feeType, g._sum.piconeros ?? 0n]))
  const genuineDownvotes = (await prisma.observedDownvote.aggregate({
    _sum: { piconeros: true },
    where: {
      state: 'CONFIRMED',
      confirmedAt: { gte: result.periodStart, lt: result.periodEnd },
      txHash: { not: { startsWith: 'rddv' } }
    }
  }))._sum.piconeros ?? 0n
  // Genuine donations may carry their own per-donation pct (not the rdfee
  // prefix), so weight them like the distributor does.
  const genuineDonateRewards = (await prisma.$queryRaw`
    SELECT COALESCE(sum("piconeros" * COALESCE("donationRewardsPct", 100) / 100), 0)::bigint AS s
    FROM "FeeObservation"
    WHERE "feeType" = 'DONATE' AND state = 'CONFIRMED' AND "walletReceipt" = true
      AND "confirmedAt" >= ${result.periodStart} AND "confirmedAt" < ${result.periodEnd}
      AND "txHash" NOT LIKE 'rdfee%'`)[0].s ?? 0n
  const split = (feeType, pct) => (genuineFees[feeType] ?? 0n) * BigInt(pct) / 100n
  const territorySum = (genuineFees.TERRITORY_CREATE ?? 0n) + (genuineFees.TERRITORY_BILLING ?? 0n) + (genuineFees.TERRITORY_UNARCHIVE ?? 0n) + (genuineFees.TERRITORY_UPDATE ?? 0n)
  genuineRewardsShare =
    genuineDownvotes +
    split('POSTING', configRow.postingFeeRewardsPct) +
    territorySum * BigInt(configRow.territoryFeeRewardsPct) / 100n +
    genuineDonateRewards +
    split('BOOST', configRow.boostRewardsPct) +
    split('TIP_UNWALLETED', configRow.walletlessTipRewardsPct) +
    (genuineFees.BOUNTY_ROLLOVER ?? 0n)

  // Genuine ops share: totalInflow − rewardsInflow mirrors the distributor's
  // opsInflow = totalInflow − rewardsInflow definition, so genuine stagenet
  // activity on the dev DB (e.g. a real posting fee) doesn't break the
  // 50/50-split ops assertion (drift-robust pattern).
  const genuineFeesTotal = genuineFeeGroups.reduce((acc, g) => acc + (g._sum.piconeros ?? 0n), 0n)
  const genuineTotalInflow = genuineDownvotes + genuineFeesTotal
  genuineOpsShare = genuineTotalInflow - genuineRewardsShare
})

afterAll(async () => {
  // FK-safe teardown. Journal rows first: they reference distributions, and
  // the FK only SET NULLs, so they would otherwise survive as residue.
  await prisma.rewardsWalletTransaction.deleteMany({ where: { id: { in: created.journals } } })
  await prisma.earn.deleteMany({ where: { distributionId: { in: created.distributions } } })
  for (const id of created.distributions) {
    await prisma.rewardPayout.deleteMany({ where: { distributionId: id } })
  }
  await prisma.rewardDistribution.deleteMany({ where: { id: { in: created.distributions } } })
  await prisma.feeObservation.deleteMany({ where: { id: { in: created.fees } } })
  await prisma.observedTip.deleteMany({ where: { id: { in: created.tips } } })
  await prisma.observedDownvote.deleteMany({ where: { id: { in: created.downvotes } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })

  // Restore the operator's pre-suite floor (leave-no-trace on the shared dev
  // DB). If this suite's pin CREATED the singleton row, leave it with schema
  // defaults — semantically identical to the pre-suite world. A killed run
  // skips this restore (documented residue, same class as fixture residue).
  await prisma.platformFeeConfig.upsert({
    where: { id: 1 },
    update: { curatorTrustWeightFloor: priorTrustFloor ?? 1.0 },
    create: { id: 1 }
  })

  // Restore the wallet identity env this suite overrode.
  if (priorRewardsAddress === undefined) delete process.env.PLATFORM_REWARDS_ADDRESS
  else process.env.PLATFORM_REWARDS_ADDRESS = priorRewardsAddress
  if (priorNetworkEnv === undefined) delete process.env.MONERO_NETWORK
  else process.env.MONERO_NETWORK = priorNetworkEnv

  await prisma.$disconnect()
})

test('the rewards pool equals the exact allocation earmark + extra sources + prior rollover', async () => {
  expect(result.poolPiconeros.toString()).toBe((EXPECTED_POOL_PICONEROS + genuineRewardsShare).toString())
})

test('DONATE sources fund the pool at their per-donation rewards pct', async () => {
  // The 3e12 fixture donation (no pct -> 100% pool) plus the 1e12 fixture
  // donation at 50% (0.5e12 pool), on top of the 9.4e12 base pool.
  expect(result.poolPiconeros).toBe(9_400_000_000_000n + EXTRA_DONATE_PICONEROS + HALF_DONATE_PICONEROS * 50n / 100n + BOOST_FEE_PICONEROS * 30n / 100n + WALLETLESS_TIP_PICONEROS * 70n / 100n + BOUNTY_ROLLOVER_PICONEROS + genuineRewardsShare)
})

test('a donation with donationRewardsPct=50 splits 50/50 into pool and ops', async () => {
  const poolWithoutHalf = EXPECTED_POOL_PICONEROS + genuineRewardsShare - HALF_DONATE_PICONEROS * 50n / 100n
  expect(result.poolPiconeros - poolWithoutHalf).toBe(HALF_DONATE_PICONEROS * 50n / 100n)
  const opsWithoutHalf = EXPECTED_OPS_INFLOW_PICONEROS + genuineOpsShare - HALF_DONATE_PICONEROS * 50n / 100n
  expect(result.opsInflowPiconeros - opsWithoutHalf).toBe(HALF_DONATE_PICONEROS * 50n / 100n)
})

test('the BOUNTY_ROLLOVER source funds the pool 100% and BOUNTY_FEE funds it 0% (ops-only)', async () => {
  // The rollover's bounty portion arrives at the rewards wallet — 100% pool.
  const poolWithoutBountyRollover = EXPECTED_POOL_PICONEROS + genuineRewardsShare - BOUNTY_ROLLOVER_PICONEROS
  expect(result.poolPiconeros - poolWithoutBountyRollover).toBe(BOUNTY_ROLLOVER_PICONEROS)
  // The fee was booked at funding (BOUNTY_FEE, 100% ops) and physically rides
  // along the rollover — it must NOT inflate the pool: the pool equals the
  // expected total WITHOUT the fee term (were the fee booked to the pool, the
  // pool would be BOUNTY_FEE_PICONEROS higher).
  expect(result.poolPiconeros).toBe(EXPECTED_POOL_PICONEROS + genuineRewardsShare)
})

test('the BOOST source funds the pool at boostRewardsPct (30%), not 100%', async () => {
  // If BOOST were lumped into the 100% extra bucket (the old behavior), the
  // pool would be EXPECTED_POOL_PICONEROS + BOOST_FEE_PICONEROS * 30n / 100n
  // higher than it should be. Pin the exact 30% contribution.
  const poolWithoutBoost = EXPECTED_POOL_PICONEROS + genuineRewardsShare - BOOST_FEE_PICONEROS * 30n / 100n
  expect(result.poolPiconeros - poolWithoutBoost).toBe(BOOST_FEE_PICONEROS * 30n / 100n)
  expect(BOOST_FEE_PICONEROS * 30n / 100n).toBe(300_000_000_000n)
})

test('the TIP_UNWALLETED source funds the pool at walletlessTipRewardsPct (70%), not 100%', async () => {
  // If TIP_UNWALLETED were lumped into the 100% extra bucket (the old behavior),
  // the pool would be EXPECTED_POOL_PICONEROS + WALLETLESS_TIP_PICONEROS * 70n / 100n
  // higher than it should be. Pin the exact 70% contribution.
  const poolWithoutWalletless = EXPECTED_POOL_PICONEROS + genuineRewardsShare - WALLETLESS_TIP_PICONEROS * 70n / 100n
  expect(result.poolPiconeros - poolWithoutWalletless).toBe(WALLETLESS_TIP_PICONEROS * 70n / 100n)
  expect(WALLETLESS_TIP_PICONEROS * 70n / 100n).toBe(1_400_000_000_000n)
})

test('distributedPiconeros + rolledOverPiconeros reconciles to the pool exactly', async () => {
  expect(result.distributedPiconeros + result.rolledOverPiconeros).toBe(result.poolPiconeros)
})

test('a pool above the weekly curator cap still allocates at most the cap to curators in the default suite', async () => {
  const curatorEarns = await prisma.earn.aggregate({
    where: { distributionId: result.id, type: { in: ['TIP_POST', 'TIP_COMMENT'] } },
    _sum: { piconeros: true }
  })
  expect(result.poolPiconeros).toBeGreaterThan(600_000_000_000n)
  expect(curatorEarns._sum.piconeros).toBeGreaterThan(0n)
  expect(curatorEarns._sum.piconeros).toBeLessThanOrEqual(600_000_000_000n)
})

test('opsInflowPiconeros is the exact complement of the rewards earmark (totalInflow - rewardsInflow)', async () => {
  // Drift-robust: recompute the period's actual confirmed inflow from the DB
  // (genuine stagenet activity may add to the pool on the live dev DB) with
  // the shared reader's eligibility (walletReceipt=true) so the funding-time
  // BOUNTY_FEE twin can never inflate the expected settlement inflow.
  const dv = await prisma.observedDownvote.aggregate({ _sum: { piconeros: true }, where: { state: 'CONFIRMED', confirmedAt: { gte: result.periodStart, lt: result.periodEnd } } })
  const fees = await prisma.feeObservation.aggregate({ _sum: { piconeros: true }, where: { state: 'CONFIRMED', walletReceipt: true, confirmedAt: { gte: result.periodStart, lt: result.periodEnd } } })
  const totalInflow = (dv._sum.piconeros ?? 0n) + (fees._sum.piconeros ?? 0n)
  // rewardsInflow is definitional: pool = rewardsInflow + priorRolledOver.
  const rewardsInflow = result.poolPiconeros - PRIOR_ROLLOVER_PICONEROS
  expect(result.opsInflowPiconeros).toBe(totalInflow - rewardsInflow)
  // Sanity: the walletless-tip ops share (30% of 2e12 = 0.6e12) is included.
  expect(result.opsInflowPiconeros).toBeGreaterThanOrEqual(EXPECTED_OPS_INFLOW_PICONEROS)
})

test('opsAvailablePiconeros equals opsInflow + opsRolledOver (prior had no ops, so rollover is 0)', async () => {
  // Shared DB: the prior carries no ops snapshot (the inherited fixture shape),
  // so the rollover is the negative of any real journal fees. Isolated DB: the
  // Task 7 fixture snapshot (20/10/checkpoint 4) applies.
  expect(result.opsRolledOverPiconeros).toBe(ISOLATED_DB ? expectedOpsRolledOver : -expectedCumulativeFees)
  expect(result.opsAvailablePiconeros).toBe(result.opsInflowPiconeros + result.opsRolledOverPiconeros)
})

;(ISOLATED_DB ? describe : describe.skip)('fee-adjusted ops checkpoint (isolated DB only)', () => {
  test('the distribution records the cumulative RELAYED network cost as its ops checkpoint', async () => {
    expect(result.opsNetworkFeesAccountedPiconeros).toBe(expectedCumulativeFees)
    expect(expectedCumulativeFees).toBeGreaterThanOrEqual(PRIOR_SWEEP_FEE_PICONEROS + CONSOLIDATION_FEE_PICONEROS)
  })

  test('the fee-adjusted carry debits real network costs once: carry = 20 - 10 - (7-4)', async () => {
    expect(result.opsRolledOverPiconeros).toBe(expectedOpsRolledOver)
    // The old unfee'd carry (opsAvailable - opsSwept = 10) must NOT be reported:
    // the fees incurred after the checkpoint are debited here, once.
    expect(result.opsRolledOverPiconeros).toBe(10n - (expectedCumulativeFees - PRIOR_OPS_FEES_CHECKPOINT_PICONEROS))
  })

  test('a late journal fee inserted after creation debits the active carry now, exactly once', async () => {
    await seedJournalTransaction({
      txHash: LATE_FEE_HASH,
      kind: 'CONSOLIDATION',
      principalPiconeros: 0n,
      networkFeePiconeros: LATE_FEE_PICONEROS,
      metadata: { destination: TEST_WALLET_ADDRESS, selfTransfer: true }
    })
    const pool = await getNextRewardsPool(prisma)
    // The open cycle may hold genuine inflow even on the isolated DB: price it
    // from the same read instead of assuming zero.
    const openOps = pool.totalInflowPiconeros - pool.rewardsInflowPiconeros
    expect(pool.totalNetworkFeesPiconeros).toBe(expectedCumulativeFees + LATE_FEE_PICONEROS)
    expect(pool.pendingSweepPiconeros).toBe(result.opsAvailablePiconeros - LATE_FEE_PICONEROS + openOps)
    // Reading again does not debit it a second time.
    const again = await getNextRewardsPool(prisma)
    expect(again.pendingSweepPiconeros).toBe(pool.pendingSweepPiconeros)
  })
})

test('the distributor pays out (>0) when weightedVotes is populated through the real tip path', async () => {
  // End-to-end: weightedVotes on the top post was bumped by applyTipDetected
  // (above, via a UserSubTrust row) — NOT seeded directly — so this asserts the
  // real production path feeds computeCuratorShares and the pool is distributed.
  expect(result.distributedPiconeros).toBeGreaterThan(0n)
  expect(result.payoutCount).toBeGreaterThan(0)
})

test('the distribution is finalized COMPLETE (Task 9 signer wired) with completedAt set', async () => {
  expect(result.status).toBe('COMPLETE')
  expect(result.payoutCount).toBeGreaterThan(0)
  expect(result.completedAt).toBeTruthy()
})

test('RewardPayout rows are SENT with a tx hash, each with an address and at least minPayout', async () => {
  const payouts = await prisma.rewardPayout.findMany({ where: { distributionId: result.id } })
  expect(payouts.length).toBeGreaterThan(0)
  for (const p of payouts) {
    expect(p.state).toBe('SENT')
    expect(p.txHash).toMatch(/^[0-9a-f]{64}$/)
    expect(p.recipientAddress).toBeTruthy()
    expect(p.piconeros).toBeGreaterThanOrEqual(1_000_000_000n)
  }
})

test('the signer was invoked once with the created QUEUED payouts', async () => {
  expect(signerInvocations).toBe(1)
})

test('a curator WITHOUT a registered receiving address is excluded (their share rolls over)', async () => {
  const payouts = await prisma.rewardPayout.findMany({ where: { distributionId: result.id }, select: { curatorId: true } })
  const curatorIds = payouts.map(p => p.curatorId)
  expect(curatorIds).toContain(seededCurators.c1)
  expect(curatorIds).toContain(seededCurators.c2)
  expect(curatorIds).not.toContain(seededCurators.c3)
})

test('Earn rows are written for paid curators only, summing exactly to distributedPiconeros', async () => {
  const earns = await prisma.earn.findMany({ where: { distributionId: result.id } })
  expect(earns.length).toBeGreaterThan(0)

  const earnerIds = [...new Set(earns.map(e => e.userId))]
  expect(earnerIds).toContain(seededCurators.c1)
  expect(earnerIds).toContain(seededCurators.c2)
  expect(earnerIds).not.toContain(seededCurators.c3) // no payout address -> excluded

  for (const e of earns) {
    expect(['TIP_POST', 'TIP_COMMENT']).toContain(e.type)
    expect(e.rank).toBeGreaterThan(0)
    expect(e.typeId).toBeNull()
    expect(e.distributionId).toBe(result.id)
    expect(e.createdAt.toISOString()).toBe(result.periodEnd.toISOString())
  }
  const sum = earns.reduce((acc, e) => acc + e.piconeros, 0n)
  expect(sum).toBe(result.distributedPiconeros)
})

test('a zero-payout distribution skips SENDING and goes straight to COMPLETE', async () => {
  // period far in the past so this row never trips runDistributionOnce's
  // week-window idempotency check (this test calls finalizeDistribution directly).
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(Date.now() - 30 * DAY),
      poolPiconeros: 0n,
      distributedPiconeros: 0n,
      rolledOverPiconeros: 0n,
      payoutCount: 0,
      status: 'PENDING'
    }
  })
  created.distributions.push(dist.id)
  let called = false
  await finalizeDistribution(prisma, { ...dist, payouts: [] }, async () => { called = true; return { sent: 0, failed: 0, skipped: 0 } })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('COMPLETE')
  expect(updated.completedAt).toBeTruthy()
  expect(updated.startedAt).toBeNull() // never entered SENDING on an empty week
  expect(called).toBe(false) // signer not invoked
  expect(alert).not.toHaveBeenCalledWith('critical', 'rewards distribution completed with FAILED payouts — manual re-entry required', expect.any(String), expect.anything())
})

test('a catastrophic signer failure marks the distribution FAILED (payouts keep their state)', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(Date.now() - 30 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 1,
      status: 'PENDING'
    }
  })
  created.distributions.push(dist.id)
  const payout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  await finalizeDistribution(prisma, { ...dist, payouts: [payout] }, async () => { throw new Error('wallet unavailable') })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('FAILED')
  // the payout is untouched (signer threw before marking it) -> still retryable
  const payoutAfter = await prisma.rewardPayout.findUnique({ where: { id: payout.id } })
  expect(payoutAfter.state).toBe('QUEUED')
})

test('a FAILED distribution with QUEUED payouts is resumable to COMPLETE (Fix 2)', async () => {
  // The CAS accepts FAILED, and sendPayouts is idempotent on QUEUED, so a stuck
  // distribution can be re-driven to COMPLETE with no double-send. Driven here
  // with the module-level fakeSigner (marks QUEUED -> SENT).
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(Date.now() - 30 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 1,
      status: 'FAILED'
    }
  })
  created.distributions.push(dist.id)
  const payout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  await finalizeDistribution(prisma, { ...dist, payouts: [payout] }, fakeSigner)
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('COMPLETE')
  expect(updated.completedAt).toBeTruthy()
  const payoutAfter = await prisma.rewardPayout.findUnique({ where: { id: payout.id } })
  expect(payoutAfter.state).toBe('SENT')
  expect(payoutAfter.txHash).toMatch(/^[0-9a-f]{64}$/)
})

test('a signer SKIP (insufficient unlocked) leaves the distribution FAILED — never COMPLETE (2026-08-24 fix)', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(Date.now() - 30 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 1,
      status: 'PENDING'
    }
  })
  created.distributions.push(dist.id)
  const payout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  await finalizeDistribution(
    prisma,
    { ...dist, payouts: [payout] },
    async () => ({ sent: 0, failed: 0, skipped: 1 }))
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('FAILED')
  expect(updated.completedAt).toBeNull()
  const payoutAfter = await prisma.rewardPayout.findUnique({ where: { id: payout.id } })
  expect(payoutAfter.state).toBe('QUEUED') // resumable
})

test('a partial send (sent > 0, skipped > 0) also marks the distribution FAILED (resumable) and leaves Earn/allocations untouched', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 32 * DAY),
      periodEnd: new Date(Date.now() - 31 * DAY),
      poolPiconeros: 2_000_000_000n,
      distributedPiconeros: 2_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 2,
      status: 'PENDING'
    }
  })
  created.distributions.push(dist.id)
  const payouts = []
  for (let i = 0; i < 2; i++) {
    payouts.push(await prisma.rewardPayout.create({
      data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
    }))
  }
  // Earn records were written at distribution time and are IMMUTABLE: a
  // partial on-chain send must not touch them nor the allocated/rollover
  // amounts — the unpaid reward stays an explicit QUEUED debt.
  await prisma.earn.createMany({
    data: [
      { userId: curatorId, piconeros: 1_000_000_000n, type: 'TIP_POST', rank: 1, typeId: null, distributionId: dist.id, createdAt: dist.periodEnd },
      { userId: curatorId, piconeros: 1_000_000_000n, type: 'TIP_COMMENT', rank: 2, typeId: null, distributionId: dist.id, createdAt: dist.periodEnd }
    ]
  })
  const earnsBefore = await prisma.earn.findMany({ where: { distributionId: dist.id }, orderBy: { id: 'asc' } })
  await finalizeDistribution(
    prisma,
    { ...dist, payouts },
    async (rows, { models }) => {
      await models.rewardPayout.update({ where: { id: rows[0].id }, data: { state: 'SENT', txHash: 'ab'.repeat(32) } })
      return { sent: 1, failed: 0, skipped: 1 }
    })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('FAILED')
  expect(updated.distributedPiconeros).toBe(dist.distributedPiconeros)
  expect(updated.rolledOverPiconeros).toBe(dist.rolledOverPiconeros)
  const p0 = await prisma.rewardPayout.findUnique({ where: { id: payouts[0].id } })
  const p1 = await prisma.rewardPayout.findUnique({ where: { id: payouts[1].id } })
  expect(p0.state).toBe('SENT')
  expect(p1.state).toBe('QUEUED')
  const earnsAfter = await prisma.earn.findMany({ where: { distributionId: dist.id }, orderBy: { id: 'asc' } })
  expect(earnsAfter).toEqual(earnsBefore)
})

test('a signer hard-failure summary (failed > 0) marks the distribution FAILED too', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 33 * DAY),
      periodEnd: new Date(Date.now() - 32 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 1,
      status: 'PENDING'
    }
  })
  created.distributions.push(dist.id)
  const payout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  await finalizeDistribution(
    prisma,
    { ...dist, payouts: [payout] },
    async (rows, { models }) => {
      await models.rewardPayout.update({ where: { id: rows[0].id }, data: { state: 'FAILED' } })
      return { sent: 0, failed: 1, skipped: 0 }
    })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('FAILED')
})

test('an unpersisted relay (sent>0, unpersisted>0) marks the distribution FAILED — never COMPLETE (audit #6)', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 34 * DAY),
      periodEnd: new Date(Date.now() - 33 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 1,
      status: 'PENDING'
    }
  })
  created.distributions.push(dist.id)
  const payout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  await finalizeDistribution(
    prisma,
    { ...dist, payouts: [payout] },
    async () => ({ sent: 1, failed: 0, skipped: 0, unpersisted: 1 }))
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('FAILED')
  expect(updated.completedAt).toBeNull()
  const payoutAfter = await prisma.rewardPayout.findUnique({ where: { id: payout.id } })
  expect(payoutAfter.state).toBe('QUEUED')
})

// The Task 8 accounting-failure completion guard seeds users/distributions/
// payouts directly, so it is gated to the dedicated isolated DB (same
// conditional-skip convention as the other repair suites) and skipped on a
// shared dev DB.
;(ISOLATED_DB ? describe : describe.skip)('accounting-failure completion guard (isolated DB only)', () => {
  test('an unresolved accounting item (accountingUnpersisted>0) marks the distribution FAILED — never COMPLETE (Task 8)', async () => {
    const curatorId = await createUser()
    const dist = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(Date.now() - 36 * DAY),
        periodEnd: new Date(Date.now() - 35 * DAY),
        poolPiconeros: 1_000_000_000n,
        distributedPiconeros: 1_000_000_000n,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'PENDING'
      }
    })
    created.distributions.push(dist.id)
    const payout = await prisma.rewardPayout.create({
      data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
    })
    alert.mockClear()
    await finalizeDistribution(
      prisma,
      { ...dist, payouts: [payout] },
      async () => ({ sent: 1, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 1 }))
    const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
    expect(updated.status).toBe('FAILED') // never COMPLETE over an unresolved fee cost
    expect(updated.completedAt).toBeNull()
    const incompleteCall = alert.mock.calls.find(c => c[1] === 'rewards distribution send incomplete')
    expect(incompleteCall).toBeTruthy()
    expect(incompleteCall[2]).toContain('accountingUnpersisted 1')
    expect(incompleteCall[2]).toContain('unresolved rewards-wallet fee/journal accounting')
    // The alert distinguishes unresolved fee accounting from relayed-but-
    // unpersisted recipient principal (which was NOT the failure here).
    expect(incompleteCall[2]).not.toContain('unpersisted payouts WERE relayed')
  })
})

test('a FAILED distribution with all payouts SENT reconciles to COMPLETE on the next run (finalize is sweep-agnostic)', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(Date.now() - 30 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      opsAvailablePiconeros: 2_000_000_000n,
      payoutCount: 1,
      opsSweepState: 'FAILED',
      status: 'FAILED'
    }
  })
  created.distributions.push(dist.id)
  const payout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'SENT', txHash: 'ab'.repeat(32) }
  })
  let signerCalled = false
  await finalizeDistribution(
    prisma,
    { ...dist, payouts: [payout] },
    async () => { signerCalled = true; return { sent: 0, failed: 0, skipped: 0 } })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('COMPLETE')
  expect(updated.completedAt).toBeTruthy()
  expect(updated.opsSweepState).toBe('FAILED') // untouched — finalize never sweeps
  expect(signerCalled).toBe(false) // !hasQueued branch skips the signer
})

test('R03: a FAILED distribution with FAILED payouts + no QUEUED is completed WITH a critical stranded-funds alert', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 35 * DAY),
      periodEnd: new Date(Date.now() - 34 * DAY),
      poolPiconeros: 1_900_000_000n,
      distributedPiconeros: 1_900_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 2,
      status: 'FAILED'
    }
  })
  created.distributions.push(dist.id)
  const sentPayout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'SENT', txHash: 'ab'.repeat(32) }
  })
  const failedPayout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 900_000_000n, state: 'FAILED' }
  })
  alert.mockClear()
  await finalizeDistribution(prisma, { ...dist, payouts: [sentPayout, failedPayout] }, fakeSigner)
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('COMPLETE')
  expect(updated.completedAt).toBeTruthy()
  // the already-SENT payout is untouched by the terminal transition
  const sentAfter = await prisma.rewardPayout.findUnique({ where: { id: sentPayout.id } })
  expect(sentAfter.state).toBe('SENT')
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert).toHaveBeenCalledWith(
    'critical',
    'rewards distribution completed with FAILED payouts — manual re-entry required',
    expect.stringContaining(String(failedPayout.id)),
    expect.objectContaining({ dedupeKey: `dist-${dist.id}-complete-with-failures` }))
})

test('R03: a distribution with a pre-existing FAILED payout that sends its remaining QUEUED payout still alerts at COMPLETE', async () => {
  // The !hasQueued branch is not the only COMPLETE path: a FAILED payout can
  // coexist with a QUEUED one that a later run delivers successfully. The
  // terminal flip must still page — otherwise the stranded funds read clean.
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 37 * DAY),
      periodEnd: new Date(Date.now() - 36 * DAY),
      poolPiconeros: 1_900_000_000n,
      distributedPiconeros: 1_900_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 2,
      status: 'FAILED'
    }
  })
  created.distributions.push(dist.id)
  const queuedPayout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  const failedPayout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 900_000_000n, state: 'FAILED' }
  })
  alert.mockClear()
  await finalizeDistribution(prisma, { ...dist, payouts: [failedPayout, queuedPayout] }, async (rows, { models }) => {
    for (const p of rows) {
      if (p.state === 'QUEUED') {
        await models.rewardPayout.update({ where: { id: p.id }, data: { state: 'SENT', txHash: 'ab'.repeat(32) } })
      }
    }
    return { sent: 1, failed: 0, skipped: 0 }
  })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('COMPLETE')
  expect(updated.completedAt).toBeTruthy()
  const queuedAfter = await prisma.rewardPayout.findUnique({ where: { id: queuedPayout.id } })
  expect(queuedAfter.state).toBe('SENT')
  expect(alert).toHaveBeenCalledWith(
    'critical',
    'rewards distribution completed with FAILED payouts — manual re-entry required',
    expect.stringContaining(String(failedPayout.id)),
    expect.objectContaining({ dedupeKey: `dist-${dist.id}-complete-with-failures` }))
})

test('R02 hardening: terminal writes are CAS-guarded — a stale finalizer cannot clobber a newer owner', async () => {
  // A distribution currently SENDING (a live/newer owner) as seen by a STALE
  // process whose in-memory copy still says PENDING with nothing queued. The
  // !hasQueued terminal write must no-op instead of flipping it COMPLETE.
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 36 * DAY),
      periodEnd: new Date(Date.now() - 35 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 1,
      status: 'SENDING',
      startedAt: new Date()
    }
  })
  created.distributions.push(dist.id)
  await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  alert.mockClear()
  await finalizeDistribution(prisma, { ...dist, status: 'PENDING', payouts: [] }, fakeSigner)
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('SENDING') // not clobbered
  // A fresh SENDING fixture must not leak into later allocation tests; the
  // cross-week sender-serialization guard correctly treats it as in flight.
  await prisma.rewardPayout.deleteMany({ where: { distributionId: dist.id } })
  await prisma.rewardDistribution.delete({ where: { id: dist.id } })
})

test('R02: a stale SENDING distribution is watchdog-flipped FAILED, alerted, and re-driven to COMPLETE', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 31 * DAY),
      periodEnd: new Date(Date.now() - 30 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 1,
      status: 'SENDING',
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) // 48h stale > 24h threshold
    }
  })
  created.distributions.push(dist.id)
  const payout = await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  alert.mockClear()
  await recoverStaleDistributions(prisma, { sendPayouts: fakeSigner, scheduleOpsSweep: false })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('COMPLETE')
  const payoutAfter = await prisma.rewardPayout.findUnique({ where: { id: payout.id } })
  expect(payoutAfter.state).toBe('SENT')
  expect(alert).toHaveBeenCalledWith(
    'critical',
    'rewards distribution stuck SENDING — watchdog failed it',
    expect.stringContaining(String(dist.id)),
    expect.objectContaining({ dedupeKey: `dist-${dist.id}-stale-sending` }))
})

test('R02: a FRESH SENDING distribution is untouched by the watchdog', async () => {
  const curatorId = await createUser()
  const dist = await prisma.rewardDistribution.create({
    data: {
      periodStart: new Date(Date.now() - 32 * DAY),
      periodEnd: new Date(Date.now() - 31 * DAY),
      poolPiconeros: 1_000_000_000n,
      distributedPiconeros: 1_000_000_000n,
      rolledOverPiconeros: 0n,
      payoutCount: 1,
      status: 'SENDING',
      startedAt: new Date() // fresh: a live sender may own this row
    }
  })
  created.distributions.push(dist.id)
  await prisma.rewardPayout.create({
    data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
  })
  const invocationsBefore = signerInvocations
  await recoverStaleDistributions(prisma, { sendPayouts: fakeSigner, scheduleOpsSweep: false })
  const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
  expect(updated.status).toBe('SENDING')
  expect(signerInvocations).toBe(invocationsBefore)
  // A fresh SENDING fixture must not leak into later allocation tests; the
  // cross-week sender-serialization guard correctly treats it as in flight.
  await prisma.rewardPayout.deleteMany({ where: { distributionId: dist.id } })
  await prisma.rewardDistribution.delete({ where: { id: dist.id } })
})

test('R02: runDistributionOnce wires the watchdog — a stale row is recovered by a normal run', async () => {
  jest.useFakeTimers({ now: resultWeekNoon(), doNotFake: REAL_TIMER_APIS })
  try {
    const curatorId = await createUser()
    const dist = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(Date.now() - 33 * DAY),
        periodEnd: new Date(Date.now() - 32 * DAY),
        poolPiconeros: 1_000_000_000n,
        distributedPiconeros: 1_000_000_000n,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'SENDING',
        startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000)
      }
    })
    created.distributions.push(dist.id)
    await prisma.rewardPayout.create({
      data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
    })
    // The week's distribution (beforeAll result) occupies the idempotency
    // window, so this run only exercises the watchdog + a no-op finalize.
    await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, scheduleOpsSweep: false })
    const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
    expect(updated.status).toBe('COMPLETE')
  } finally {
    jest.useRealTimers()
  }
})

test('a second run within the same week is idempotent (returns the existing distribution)', async () => {
  jest.useFakeTimers({ now: resultWeekNoon(), doNotFake: REAL_TIMER_APIS })
  try {
    const before = await prisma.rewardPayout.count({ where: { distributionId: result.id } })
    const again = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, scheduleOpsSweep: false })
    expect(again.id).toBe(result.id)
    const after = await prisma.rewardPayout.count({ where: { distributionId: result.id } })
    expect(after).toBe(before)
  } finally {
    jest.useRealTimers()
  }
})

test('referred curators produce a FOREVER_REFERRAL payout + Earn row for the referrer', async () => {
  // The beforeAll distribution occupies this week's window, so
  // runDistributionOnce's idempotency guard would return it verbatim. Clear it
  // (Earn -> payout -> distribution, FK-safe) so this test's run writes a fresh
  // distribution for the same week. afterAll's deleteMany on the already-cleared
  // result.id is a harmless no-op.
  await prisma.earn.deleteMany({ where: { distributionId: result.id } })
  await prisma.rewardPayout.deleteMany({ where: { distributionId: result.id } })
  await prisma.rewardDistribution.deleteMany({ where: { id: result.id } })

  const referrer = await createUser()
  await createPayoutAccount(referrer) // referrer must be able to RECEIVE
  const curator = await createUser()
  await prisma.user.update({ where: { id: curator }, data: { referrerId: referrer } })
  await createPayoutAccount(curator)

  // Filler curator: NO payout account, tips the same post — their share rolls
  // over and funds the referral budget, making the 10% referral payout exact.
  const filler = await createUser()

  const recipientAccount = await createRecipientAccount()
  // weightedVotes 1e6 >> the beforeAll post (~20.7 from applyTipDetected) and
  // any dev posts, so competing curators land sub-minPayout shares and don't
  // erode the pool/referral budget.
  const post = await createRootPost(curator, 1_000_000, new Date(Date.now() - DAY))
  await seedTip({ postId: post, tipperId: curator, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 1000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId: post, tipperId: filler, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 61000), recipientAccountId: recipientAccount.id })

  // stub signer: marks QUEUED -> SENT; no sweep exists in the finalize path
  const dist = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, scheduleOpsSweep: false })
  created.distributions.push(dist.id)

  const curatorPayout = dist.payouts.find(p => p.curatorId === curator)
  expect(curatorPayout).toBeDefined()
  expect(curatorPayout.state).toBe('SENT')

  const referralPayout = dist.payouts.find(p => p.curatorId === referrer)
  expect(referralPayout).toBeDefined()
  // 10% of the curator's share
  expect(referralPayout.piconeros).toBe(curatorPayout.piconeros / 10n)

  const earn = await prisma.earn.findFirst({
    where: { userId: referrer, type: 'FOREVER_REFERRAL', distributionId: dist.id }
  })
  expect(earn).not.toBeNull()
  expect(earn.piconeros).toBe(referralPayout.piconeros)
  expect(earn.rank).toBeNull()
  expect(earn.typeId).toBeNull()
})

test('a referrer who is ALSO a paid curator gets exactly one FOREVER_REFERRAL Earn (no double-write, no self-inflation)', async () => {
  // The first dedicated referral test's distribution occupies this week's
  // window, so runDistributionOnce's idempotency guard would return it verbatim.
  // Clear it (Earn -> payout -> distribution, FK-safe) so this test's run writes
  // a fresh distribution for the same week. afterAll's deleteMany on the
  // already-cleared id is a harmless no-op.
  const current = await prisma.rewardDistribution.findFirst({ where: { periodEnd: { gte: new Date(Date.now() - 7 * DAY) } } })
  if (current) {
    await prisma.earn.deleteMany({ where: { distributionId: current.id } })
    await prisma.rewardPayout.deleteMany({ where: { distributionId: current.id } })
    await prisma.rewardDistribution.deleteMany({ where: { id: current.id } })
  }

  const author = await createUser()
  const referrer = await createUser() // BOTH a referrer AND a paid curator below
  await createPayoutAccount(referrer)
  const curator = await createUser()
  await prisma.user.update({ where: { id: curator }, data: { referrerId: referrer } })
  await createPayoutAccount(curator)
  // Filler curator: NO payout account, tips the same post — their share rolls
  // over and funds the referral budget (same pattern as the first dedicated
  // referral test), keeping the 10% referral payout exact.
  const filler = await createUser()

  const recipientAccount = await createRecipientAccount()
  // weightedVotes 2e6: strictly outranks the first dedicated referral test's
  // post (1e6) and the beforeAll post, so the NTILE(100) cutoff can't split the
  // two sibling test posts arbitrarily — this post is unambiguously the top
  // post and the only one whose curators clear minPayout, and it dwarfs any dev
  // post so competing curators roll over rather than eroding the budget.
  const post = await createRootPost(author, 2_000_000, new Date(Date.now() - DAY))
  // Equal tips from referrer + curator + filler, staggered confirmedAt. The
  // referrer tipping makes them a PAID CURATOR too — that is the overlap under
  // test (same userId owning both a curator payout row and a referral payout row).
  await seedTip({ postId: post, tipperId: referrer, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 1000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId: post, tipperId: curator, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 61000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId: post, tipperId: filler, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 121000), recipientAccountId: recipientAccount.id })

  const dist = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, scheduleOpsSweep: false })
  created.distributions.push(dist.id)

  // --- Both payout-row kinds for the SAME user id: the overlap under test ---
  const curatorPayout = dist.payouts.find(p => p.curatorId === curator)
  expect(curatorPayout).toBeDefined()
  const referrerRows = dist.payouts.filter(p => p.curatorId === referrer)
  expect(referrerRows).toHaveLength(2) // curator share payout + referral payout
  const referralPayout = referrerRows.find(p => p.piconeros === curatorPayout.piconeros / 10n)
  expect(referralPayout).toBeDefined()
  const referrerCuratorPayout = referrerRows.find(p => p.piconeros !== curatorPayout.piconeros / 10n)
  expect(referrerCuratorPayout).toBeDefined()

  // 1. Exactly ONE FOREVER_REFERRAL Earn row, worth the referral payout (10% of
  //    the referred curator's share — NOT the referrer's own curator share).
  const referralEarns = await prisma.earn.findMany({
    where: { userId: referrer, type: 'FOREVER_REFERRAL', distributionId: dist.id }
  })
  expect(referralEarns).toHaveLength(1)
  expect(referralEarns[0].piconeros).toBe(referralPayout.piconeros)
  expect(referralEarns[0].piconeros).toBe(curatorPayout.piconeros / 10n)

  // 2. The inflation case is gone: no FOREVER_REFERRAL Earn row carries the
  //    referrer's own curator share (old Loop-2 emitted one at that piconeros).
  const inflated = await prisma.earn.findMany({
    where: { type: 'FOREVER_REFERRAL', distributionId: dist.id, piconeros: referrerCuratorPayout.piconeros }
  })
  expect(inflated).toHaveLength(0)

  // 3. Curator Earn rows (TIP_POST) are written EXACTLY ONCE per paid curator —
  //    the double-write (old Loop-1 re-matching the referral row via shares.find)
  //    would bump the referrer's count to 2.
  const referrerTipEarns = await prisma.earn.findMany({ where: { userId: referrer, type: 'TIP_POST', distributionId: dist.id } })
  expect(referrerTipEarns).toHaveLength(1)
  expect(referrerTipEarns[0].piconeros).toBe(referrerCuratorPayout.piconeros)
  const curatorTipEarns = await prisma.earn.findMany({ where: { userId: curator, type: 'TIP_POST', distributionId: dist.id } })
  expect(curatorTipEarns).toHaveLength(1)
  expect(curatorTipEarns[0].piconeros).toBe(curatorPayout.piconeros)

  // 4. The plan's invariant: sum(Earn) === distributedPiconeros.
  const allEarns = await prisma.earn.findMany({ where: { distributionId: dist.id } })
  const total = allEarns.reduce((acc, e) => acc + e.piconeros, 0n)
  expect(total).toBe(dist.distributedPiconeros)
})

test('R04: referral payouts are computed from PAID curators only (a wallet-less curator\'s share earns their referrer nothing)', async () => {
  // Same clearing pattern as the referral tests above: the week's window is
  // occupied by the previous test's distribution, so remove it (Earn ->
  // payout -> distribution, FK-safe) for a fresh run.
  const current = await prisma.rewardDistribution.findFirst({ where: { periodEnd: { gte: new Date(Date.now() - 7 * DAY) } } })
  if (current) {
    await prisma.earn.deleteMany({ where: { distributionId: current.id } })
    await prisma.rewardPayout.deleteMany({ where: { distributionId: current.id } })
    await prisma.rewardDistribution.deleteMany({ where: { id: current.id } })
  }

  const referrer = await createUser()
  await createPayoutAccount(referrer) // referrer must be able to RECEIVE
  const author = await createUser()
  const curatorPaid = await createUser()
  await prisma.user.update({ where: { id: curatorPaid }, data: { referrerId: referrer } })
  await createPayoutAccount(curatorPaid)
  // Wallet-less curator with the SAME referrer: their share rolls over and
  // must NOT generate referral income for the referrer (the R04 bug).
  const curatorWalletless = await createUser()
  await prisma.user.update({ where: { id: curatorWalletless }, data: { referrerId: referrer } })

  const recipientAccount = await createRecipientAccount()
  // weightedVotes 3e6 strictly outranks the prior referral tests' posts (2e6,
  // 1e6) and the beforeAll post, so this is unambiguously the top post and
  // only its curators clear minPayout.
  const post = await createRootPost(author, 3_000_000, new Date(Date.now() - DAY))
  await seedTip({ postId: post, tipperId: curatorPaid, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 1000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId: post, tipperId: curatorWalletless, piconeros: 1_000_000_000n, confirmedAt: new Date(Date.now() - DAY + 61000), recipientAccountId: recipientAccount.id })

  const dist = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, scheduleOpsSweep: false })
  created.distributions.push(dist.id)

  const paidPayout = dist.payouts.find(p => p.curatorId === curatorPaid)
  expect(paidPayout).toBeDefined()
  expect(paidPayout.state).toBe('SENT')
  // the wallet-less curator has no payout row — their share rolled over
  expect(dist.payouts.some(p => p.curatorId === curatorWalletless)).toBe(false)

  const referralPayout = dist.payouts.find(p => p.curatorId === referrer)
  expect(referralPayout).toBeDefined()
  // exactly 10% of the PAID curator's share — under the bug this was
  // 10% of BOTH shares (paid + rolled-over)
  expect(referralPayout.piconeros).toBe(paidPayout.piconeros / 10n)
})

test('stasher receives neither a curator payout nor a referral payout', async () => {
  // Same clearing pattern as the referral tests above: replace the previous
  // test's current-week distribution with this test's fresh run.
  const current = await prisma.rewardDistribution.findFirst({ where: { periodEnd: { gte: new Date(Date.now() - 7 * DAY) } } })
  if (current) {
    await prisma.earn.deleteMany({ where: { distributionId: current.id } })
    await prisma.rewardPayout.deleteMany({ where: { distributionId: current.id } })
    await prisma.rewardDistribution.deleteMany({ where: { id: current.id } })
  }

  // Give stasher a payout account so its absence is an ELIGIBILITY exclusion,
  // not the address filter. It is both the referrer here and a qualifying
  // tipper on the post below; neither role may produce a payout or Earn row.
  const referrer = USER_ID.stasher
  await createPayoutAccount(referrer)
  const curator = await createUser()
  await prisma.user.update({ where: { id: curator }, data: { referrerId: referrer } })
  await createPayoutAccount(curator)
  // Filler curator: NO payout account. Their share rolls over and funds the
  // referral budget, keeping the 10% referral calculation exact.
  const filler = await createUser()
  const author = await createUser()

  const recipientAccount = await createRecipientAccount()
  // weightedVotes 4e6 strictly outranks the prior referral tests' posts, so
  // this is unambiguously the top post and only its curators clear minPayout.
  const post = await createRootPost(author, 4_000_000, new Date(Date.now() - DAY))
  const at = new Date(Date.now() - DAY + 1000)
  await seedTip({ postId: post, tipperId: curator, piconeros: 1_000_000_000n, confirmedAt: at, recipientAccountId: recipientAccount.id })
  await seedTip({ postId: post, tipperId: filler, piconeros: 1_000_000_000n, confirmedAt: new Date(at.getTime() + 60000), recipientAccountId: recipientAccount.id })
  await seedTip({ postId: post, tipperId: referrer, piconeros: 1_000_000_000n, confirmedAt: new Date(at.getTime() + 120000), recipientAccountId: recipientAccount.id })

  const dist = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, scheduleOpsSweep: false })
  created.distributions.push(dist.id)

  const curatorPayout = dist.payouts.find(p => p.curatorId === curator)
  expect(curatorPayout).toBeDefined()
  expect(curatorPayout.state).toBe('SENT')
  // Exactly one payout for the referred curator: the 10% referral commission
  // was not redirected elsewhere when its stasher beneficiary was excluded.
  expect(dist.payouts.filter(p => p.curatorId === curator)).toHaveLength(1)
  // stasher is neither a paid curator nor a paid referrer.
  expect(dist.payouts.some(p => p.curatorId === referrer)).toBe(false)
  expect(await prisma.earn.count({ where: { userId: referrer, distributionId: dist.id } })).toBe(0)
  expect(await prisma.earn.count({ where: { userId: referrer, type: 'FOREVER_REFERRAL', distributionId: dist.id } })).toBe(0)

  // The Earn contract still closes: no orphaned rows from the excluded payout.
  const allEarns = await prisma.earn.findMany({ where: { distributionId: dist.id } })
  const total = allEarns.reduce((acc, e) => acc + e.piconeros, 0n)
  expect(total).toBe(dist.distributedPiconeros)
})

test('a prior-week allocation ending just before Monday does not block this week\'s allocation', async () => {
  // Regression: the old rolling seven-day guard compared periodEnd against
  // now - 7d (+ a 1h grace), so a prior allocation created later than the
  // current run suppressed the following Monday. Allocation eligibility is now
  // the UTC calendar week: anything before this Monday cannot block it.
  jest.useFakeTimers({ now: FIXED_NOW, doNotFake: REAL_TIMER_APIS })
  try {
    // Purge any current-week distribution first (the referral tests above left
    // one behind — same FK-safe pattern as the line-841 cleanup; afterAll's
    // deleteMany on already-deleted ids is a harmless no-op).
    const weekStart = utcWeekStart(FIXED_NOW)
    const current = await prisma.rewardDistribution.findMany({ where: { id: { in: created.distributions }, periodEnd: { gte: weekStart } } })
    for (const d of current) {
      await prisma.earn.deleteMany({ where: { distributionId: d.id } })
      await prisma.rewardPayout.deleteMany({ where: { distributionId: d.id } })
      await prisma.rewardDistribution.deleteMany({ where: { id: d.id } })
    }

    // Never delete an untracked row: the shared dev DB can hold real
    // distributions. If one occupies this fixed week, fail instead of purging it.
    expect(await prisma.rewardDistribution.count({ where: { periodEnd: { gte: weekStart } } })).toBe(0)

    // Prior week's final millisecond: the closest possible row to this Monday.
    const boundary = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(weekStart.getTime() - 7 * DAY - 1),
        periodEnd: new Date(weekStart.getTime() - 1),
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        status: 'COMPLETE'
      }
    })
    created.distributions.push(boundary.id)

    const dist = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, scheduleOpsSweep: false })
    created.distributions.push(dist.id)

    expect(dist.id).not.toBe(boundary.id)
    // The new period's inflow window starts exactly where the boundary row
    // ended — contiguous periods, so no confirmed inflow can fall into a gap
    // (late run) or be double-counted between distributions.
    expect(dist.periodStart.toISOString()).toBe(boundary.periodEnd.toISOString())
    const rows = await prisma.rewardDistribution.findMany({ where: { id: { in: [boundary.id, dist.id] } } })
    expect(rows).toHaveLength(2) // two consecutive weekly runs -> two rows

    await deleteDistributionRows([boundary.id, dist.id])
  } finally {
    jest.useRealTimers()
  }
})

test('a run later in the same UTC week still reuses the existing allocation', async () => {
  // The complement of the boundary test: a distribution created earlier this
  // UTC week must short-circuit the run, regardless of the weekday. Guards
  // against over-correcting the boundary bug in the other direction.
  jest.useFakeTimers({ now: FIXED_NOW, doNotFake: REAL_TIMER_APIS })
  try {
    const weekStart = utcWeekStart(FIXED_NOW)
    const current = await prisma.rewardDistribution.findMany({ where: { id: { in: created.distributions }, periodEnd: { gte: weekStart } } })
    for (const d of current) {
      await prisma.earn.deleteMany({ where: { distributionId: d.id } })
      await prisma.rewardPayout.deleteMany({ where: { distributionId: d.id } })
      await prisma.rewardDistribution.deleteMany({ where: { id: d.id } })
    }

    // Never delete an untracked row: the shared dev DB can hold real
    // distributions. If one occupies this fixed week, fail instead of purging it.
    expect(await prisma.rewardDistribution.count({ where: { periodEnd: { gte: weekStart } } })).toBe(0)

    const earlierThisWeek = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(weekStart.getTime() - 7 * DAY),
        periodEnd: new Date(weekStart.getTime() + 60 * 60 * 1000),
        poolPiconeros: 0n,
        distributedPiconeros: 0n,
        rolledOverPiconeros: 0n,
        payoutCount: 0,
        status: 'COMPLETE'
      }
    })
    created.distributions.push(earlierThisWeek.id)

    const again = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, scheduleOpsSweep: false })
    expect(again.id).toBe(earlierThisWeek.id) // found -> returned verbatim, no new row
    expect(again.status).toBe('COMPLETE') // finalizeDistribution early-returns on COMPLETE

    await deleteDistributionRows([earlierThisWeek.id])
  } finally {
    jest.useRealTimers()
  }
})

describe('requeueFailedPayouts (2026-09-28 recovery tool)', () => {
  test('dry-run reports candidates and mutates nothing', async () => {
    const { dist, failed } = await seedStrandedDistribution()
    const summary = await requeueFailedPayouts(prisma, dist.id, { confirm: false, scheduleOpsSweep: false })
    expect(summary.candidates.map(c => c.id)).toEqual([failed.id])
    expect(summary.candidatePiconeros).toBe(2_000_000_000n)
    expect(summary.requeued).toBe(0)
    expect(summary.drove).toBe(false)
    expect((await prisma.rewardPayout.findUnique({ where: { id: failed.id } })).state).toBe('FAILED')
    expect((await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })).status).toBe('FAILED')
  })

  test('confirm requeues only FAILED rows with NULL txHash; FAILED-with-hash and SENT rows are untouched', async () => {
    const { dist, failed, sent } = await seedStrandedDistribution({ failedTxHash: 'cd'.repeat(32) })
    const stranded = await prisma.rewardPayout.create({
      data: { distributionId: dist.id, curatorId: await createUser(), recipientAddress: makeAddress(), piconeros: 500_000_000n, state: 'FAILED' }
    })
    const summary = await requeueFailedPayouts(prisma, dist.id, { confirm: true, send: false, scheduleOpsSweep: false })
    expect(summary.refusedWithTxHash).toEqual([failed.id])
    expect(summary.requeued).toBe(1)
    expect((await prisma.rewardPayout.findUnique({ where: { id: stranded.id } })).state).toBe('QUEUED')
    expect((await prisma.rewardPayout.findUnique({ where: { id: failed.id } })).state).toBe('FAILED') // hash present: reconciliation path
    expect((await prisma.rewardPayout.findUnique({ where: { id: sent.id } })).state).toBe('SENT')
  })

  test('refuses when the distribution is SENDING (a sender may be live) and flips nothing', async () => {
    const { dist, failed } = await seedStrandedDistribution({ status: 'SENDING' })
    await expect(requeueFailedPayouts(prisma, dist.id, { confirm: true, scheduleOpsSweep: false })).rejects.toThrow(/SENDING/)
    expect((await prisma.rewardPayout.findUnique({ where: { id: failed.id } })).state).toBe('FAILED')
  })

  test('masked-COMPLETE distribution recovers end-to-end: un-masked, requeued, driven once, payout SENT, Earn untouched', async () => {
    const { dist, failed } = await seedStrandedDistribution({ status: 'COMPLETE' })
    let driveCount = 0
    const summary = await requeueFailedPayouts(prisma, dist.id, {
      confirm: true,
      scheduleOpsSweep: false,
      sendPayouts: async (rows, { models }) => {
        driveCount += 1
        for (const p of rows) {
          if (p.state === 'QUEUED') {
            await models.rewardPayout.update({ where: { id: p.id }, data: { state: 'SENT', txHash: 'ef'.repeat(32) } })
          }
        }
        return { sent: rows.filter(p => p.state === 'QUEUED').length, failed: 0, skipped: 0, unpersisted: 0 }
      }
    })
    expect(summary.requeued).toBe(1)
    expect(summary.drove).toBe(true)
    expect(summary.finalStatus).toBe('COMPLETE')
    expect(driveCount).toBe(1) // delivered exactly once
    expect((await prisma.rewardPayout.findUnique({ where: { id: failed.id } })).state).toBe('SENT')
    expect(await prisma.earn.count({ where: { distributionId: dist.id } })).toBe(2) // Earn rows never touched
  })

  test('a second run after delivery is a no-op and never drives finalize', async () => {
    const { dist } = await seedStrandedDistribution()
    const signer = jest.fn(async (rows, { models }) => {
      for (const p of rows) {
        if (p.state === 'QUEUED') {
          await models.rewardPayout.update({ where: { id: p.id }, data: { state: 'SENT', txHash: 'ef'.repeat(32) } })
        }
      }
      return { sent: 1, failed: 0, skipped: 0, unpersisted: 0 }
    })
    await requeueFailedPayouts(prisma, dist.id, { confirm: true, sendPayouts: signer, scheduleOpsSweep: false })
    const second = await requeueFailedPayouts(prisma, dist.id, { confirm: true, sendPayouts: signer, scheduleOpsSweep: false })
    expect(second.requeued).toBe(0)
    expect(second.drove).toBe(false)
    expect(signer).toHaveBeenCalledTimes(1)
  })

  test('pure-QUEUED stranding (classification-change shape): confirm drives delivery with no FAILED rows to requeue', async () => {
    const curatorId = await createUser()
    const dist = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(Date.now() - 40 * DAY),
        periodEnd: new Date(Date.now() - 39 * DAY),
        poolPiconeros: 1_000_000_000n,
        distributedPiconeros: 1_000_000_000n,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'FAILED'
      }
    })
    created.distributions.push(dist.id)
    const queued = await prisma.rewardPayout.create({
      data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
    })
    const signer = jest.fn(async (rows, { models }) => {
      for (const p of rows) {
        if (p.state === 'QUEUED') {
          await models.rewardPayout.update({ where: { id: p.id }, data: { state: 'SENT', txHash: 'ef'.repeat(32) } })
        }
      }
      return { sent: rows.filter(p => p.state === 'QUEUED').length, failed: 0, skipped: 0, unpersisted: 0 }
    })
    const summary = await requeueFailedPayouts(prisma, dist.id, { confirm: true, sendPayouts: signer, scheduleOpsSweep: false })
    expect(summary.candidates).toEqual([])
    expect(summary.queuedCount).toBe(1)
    expect(summary.requeued).toBe(0)
    expect(summary.drove).toBe(true)
    expect(summary.finalStatus).toBe('COMPLETE')
    expect((await prisma.rewardPayout.findUnique({ where: { id: queued.id } })).state).toBe('SENT')
    const second = await requeueFailedPayouts(prisma, dist.id, { confirm: true, sendPayouts: signer, scheduleOpsSweep: false })
    expect(second.drove).toBe(false) // all SENT: no-op, never re-drives
  })

  test('masked-COMPLETE + QUEUED-only distribution: un-masks and drives (the nag bug-state shape)', async () => {
    const curatorId = await createUser()
    const dist = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(Date.now() - 40 * DAY),
        periodEnd: new Date(Date.now() - 39 * DAY),
        poolPiconeros: 1_000_000_000n,
        distributedPiconeros: 1_000_000_000n,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'COMPLETE',
        completedAt: new Date(Date.now() - DAY)
      }
    })
    created.distributions.push(dist.id)
    const queued = await prisma.rewardPayout.create({
      data: { distributionId: dist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
    })
    await prisma.earn.create({ data: { userId: curatorId, piconeros: 1_000_000_000n, type: 'TIP_POST', rank: 1, typeId: null, distributionId: dist.id, createdAt: new Date(Date.now() - 39 * DAY) } })
    const summary = await requeueFailedPayouts(prisma, dist.id, {
      confirm: true,
      scheduleOpsSweep: false,
      sendPayouts: async (rows, { models }) => {
        for (const p of rows) {
          if (p.state === 'QUEUED') {
            await models.rewardPayout.update({ where: { id: p.id }, data: { state: 'SENT', txHash: 'ef'.repeat(32) } })
          }
        }
        return { sent: 1, failed: 0, skipped: 0, unpersisted: 0 }
      }
    })
    expect(summary.drove).toBe(true)
    expect(summary.finalStatus).toBe('COMPLETE')
    expect((await prisma.rewardPayout.findUnique({ where: { id: queued.id } })).state).toBe('SENT')
    expect(await prisma.earn.count({ where: { distributionId: dist.id } })).toBe(1)
  })
})

describe('warnUndeliveredDistributions (stranding visibility net)', () => {
  test('flags an out-of-window distribution holding FAILED-null or QUEUED payouts with the requeue runbook', async () => {
    const { dist } = await seedStrandedDistribution() // 39d old, FAILED + null txHash
    const curatorId = await createUser()
    const queuedDist = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(Date.now() - 40 * DAY),
        periodEnd: new Date(Date.now() - 39 * DAY),
        poolPiconeros: 1_000_000_000n,
        distributedPiconeros: 1_000_000_000n,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'FAILED'
      }
    })
    created.distributions.push(queuedDist.id)
    await prisma.rewardPayout.create({
      data: { distributionId: queuedDist.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
    })
    alert.mockClear()
    await warnUndeliveredDistributions(prisma)
    expect(alert).toHaveBeenCalledWith('critical', 'rewards payouts undelivered (stranded)',
      expect.stringContaining(`distribution ${dist.id}`), expect.anything())
    expect(alert).toHaveBeenCalledWith('critical', 'rewards payouts undelivered (stranded)',
      expect.stringContaining(`distribution ${queuedDist.id}`), expect.anything())
    expect(alert).toHaveBeenCalledWith('critical', 'rewards payouts undelivered (stranded)',
      expect.stringContaining('requeue'), expect.anything())
  })

  test('does not flag in-window or fully-delivered distributions', async () => {
    const curatorId = await createUser()
    // in-window: periodEnd is NOW — the current run's idempotency window owns it
    const recent = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(Date.now() - 2 * DAY),
        periodEnd: new Date(),
        poolPiconeros: 1_000_000_000n,
        distributedPiconeros: 1_000_000_000n,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'FAILED'
      }
    })
    created.distributions.push(recent.id)
    await prisma.rewardPayout.create({
      data: { distributionId: recent.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'QUEUED' }
    })
    // fully delivered: old but every payout SENT
    const done = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(Date.now() - 40 * DAY),
        periodEnd: new Date(Date.now() - 39 * DAY),
        poolPiconeros: 1_000_000_000n,
        distributedPiconeros: 1_000_000_000n,
        rolledOverPiconeros: 0n,
        payoutCount: 1,
        status: 'COMPLETE',
        completedAt: new Date(Date.now() - 39 * DAY)
      }
    })
    created.distributions.push(done.id)
    await prisma.rewardPayout.create({
      data: { distributionId: done.id, curatorId, recipientAddress: makeAddress(), piconeros: 1_000_000_000n, state: 'SENT', txHash: 'ab'.repeat(32) }
    })
    alert.mockClear()
    await warnUndeliveredDistributions(prisma)
    expect(alert).not.toHaveBeenCalledWith('critical', 'rewards payouts undelivered (stranded)',
      expect.stringContaining(`distribution ${recent.id}`), expect.anything())
    expect(alert).not.toHaveBeenCalledWith('critical', 'rewards payouts undelivered (stranded)',
      expect.stringContaining(`distribution ${done.id}`), expect.anything())
  })
})

// Task 10: shared completion enqueue + the all-SENT accounting readiness gate.
// Every case runs the production orchestration (runDistributionOnce /
// recoverStaleDistributions / requeueFailedPayouts) with a fake boss and
// injected signer/wallet against the dedicated isolated DB; the shared dev DB
// is skipped (same gating as the other repair suites).
;(ISOLATED_DB ? describe : describe.skip)('shared completion enqueue and readiness gate (isolated DB only)', () => {
  function fakeBoss () {
    return { send: jest.fn().mockResolvedValue('job-id') }
  }

  // The wallet seams reconcileCompletionAccounting may obtain. A wallet is only
  // EVER fetched when an attempted journal row exists, so most cases never
  // touch these.
  function fakeWallet ({ outgoing = [] } = {}) {
    return {
      getPrimaryAddress: async () => TEST_WALLET_ADDRESS,
      getNetworkType: async () => (TEST_NETWORK === 'MAINNET' ? 0 : 2),
      getOutgoingTransfers: async () => outgoing
    }
  }

  // One wallet outgoing-history observation as api/monero/rewardsTransactions
  // reads it (exact hash, relayed flag, real fee, destination multiset).
  function outgoingTransfer ({ txHash, feePiconeros, destinations }) {
    const tx = { getHash: () => txHash, getIsRelayed: () => true, getFee: () => feePiconeros }
    return {
      getTx: () => tx,
      getDestinations: () => destinations.map(d => ({ getAddress: () => d.address, getAmount: () => d.amount }))
    }
  }

  // Seeds a distribution and its payouts. `periodEnd` defaults to NOW so the row
  // is the in-window (and global) latest — the shape runDistributionOnce's
  // idempotency guard returns and the sweep eligibility checks accept.
  async function seedDistribution ({ status = 'COMPLETE', periodEnd = new Date(), payouts = [], opsSweepState = 'NOT_SWEEPED', opsSweptPiconeros = 0n, opsAvailablePiconeros = 0n, startedAt } = {}) {
    const curatorId = await createUser()
    const total = payouts.reduce((acc, p) => acc + (p.piconeros ?? 1_000_000_000n), 0n)
    const dist = await prisma.rewardDistribution.create({
      data: {
        periodStart: new Date(periodEnd.getTime() - DAY),
        periodEnd,
        poolPiconeros: total,
        distributedPiconeros: total,
        rolledOverPiconeros: 0n,
        payoutCount: payouts.length,
        status,
        opsSweepState,
        opsSweptPiconeros,
        opsAvailablePiconeros,
        ...(status === 'COMPLETE' ? { completedAt: new Date(periodEnd.getTime() - 1000) } : {}),
        ...(status === 'SENDING' ? { startedAt: startedAt ?? new Date() } : {})
      }
    })
    created.distributions.push(dist.id)
    const rows = []
    for (const p of payouts) {
      rows.push(await prisma.rewardPayout.create({
        data: {
          distributionId: dist.id,
          curatorId,
          recipientAddress: p.address ?? makeAddress(),
          piconeros: p.piconeros ?? 1_000_000_000n,
          state: p.state,
          ...(p.txHash ? { txHash: p.txHash } : {})
        }
      }))
    }
    return { dist, payouts: rows, curatorId }
  }

  test('empty week: a settled zero-payout distribution completes and enqueues the delayed sweep', async () => {
    const { dist } = await seedDistribution({ status: 'PENDING', payouts: [] })
    const boss = fakeBoss()
    const signer = jest.fn()
    const result = await runDistributionOnce({ models: prisma, sendPayouts: signer, boss })
    expect(result.id).toBe(dist.id)
    expect(result.status).toBe('COMPLETE')
    expect(signer).not.toHaveBeenCalled()
    expect(boss.send).toHaveBeenCalledWith('opsSweep', { distributionId: dist.id },
      { startAfter: 3600, singletonKey: `opsSweep-${dist.id}` })
  })

  test('a same-week COMPLETE reread re-enqueues through the singleton (retry of an eligible completion)', async () => {
    const { dist } = await seedDistribution({ status: 'COMPLETE' })
    const boss = fakeBoss()
    const signer = jest.fn()
    const result = await runDistributionOnce({ models: prisma, sendPayouts: signer, boss })
    expect(result.id).toBe(dist.id)
    expect(result.status).toBe('COMPLETE')
    expect(signer).not.toHaveBeenCalled()
    expect(boss.send).toHaveBeenCalledWith('opsSweep', { distributionId: dist.id },
      { startAfter: 3600, singletonKey: `opsSweep-${dist.id}` })
  })

  test('a distribution with stranded FAILED recipients completes with the alert but never enqueues', async () => {
    const { dist } = await seedDistribution({ status: 'FAILED', payouts: [{ state: 'FAILED' }] })
    const boss = fakeBoss()
    alert.mockClear()
    const result = await runDistributionOnce({ models: prisma, sendPayouts: jest.fn(), boss })
    expect(result.id).toBe(dist.id)
    expect(result.status).toBe('COMPLETE')
    expect(boss.send).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('critical', 'rewards distribution completed with FAILED payouts — manual re-entry required',
      expect.stringContaining(String(dist.id)), expect.anything())
  })

  test('a SENDING distribution is left untouched and never enqueues', async () => {
    const { dist } = await seedDistribution({ status: 'SENDING', payouts: [{ state: 'QUEUED' }] })
    const boss = fakeBoss()
    const result = await runDistributionOnce({ models: prisma, sendPayouts: jest.fn(), boss })
    expect(result.id).toBe(dist.id)
    expect(result.status).toBe('SENDING')
    expect(boss.send).not.toHaveBeenCalled()
  })

  test('stale-SENDING recovery completes the latest row and enqueues the delayed sweep', async () => {
    const { dist } = await seedDistribution({
      status: 'SENDING',
      payouts: [{ state: 'QUEUED' }],
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000)
    })
    const boss = fakeBoss()
    await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, boss })
    const updated = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
    expect(updated.status).toBe('COMPLETE')
    expect(boss.send).toHaveBeenCalledWith('opsSweep', { distributionId: dist.id },
      { startAfter: 3600, singletonKey: `opsSweep-${dist.id}` })
  })

  test('a recovered stale row that is no longer the latest completes without enqueueing', async () => {
    await seedDistribution({ status: 'COMPLETE' }) // newer row owns the sweep
    const { dist: old } = await seedDistribution({
      status: 'SENDING',
      periodEnd: new Date(Date.now() - 30 * DAY),
      payouts: [{ state: 'QUEUED' }],
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000)
    })
    const boss = fakeBoss()
    await recoverStaleDistributions(prisma, { sendPayouts: fakeSigner, boss })
    expect((await prisma.rewardDistribution.findUnique({ where: { id: old.id } })).status).toBe('COMPLETE')
    expect(boss.send).not.toHaveBeenCalled()
  })

  test('an already-SWEPT distribution never re-enqueues a sweep', async () => {
    await seedDistribution({
      status: 'COMPLETE',
      opsSweepState: 'SWEPT',
      payouts: [{ state: 'SENT', txHash: 'ab'.repeat(32) }]
    })
    const boss = fakeBoss()
    await runDistributionOnce({ models: prisma, sendPayouts: jest.fn(), boss })
    expect(boss.send).not.toHaveBeenCalled()
  })

  test('a partially swept distribution (opsSweptPiconeros > 0) never re-enqueues a sweep', async () => {
    await seedDistribution({
      status: 'COMPLETE',
      opsSweepState: 'FAILED',
      opsSweptPiconeros: 7n,
      // A sweep can never exceed its snapshot; keep the recorded facts coherent
      // so this fixture does not (correctly) flag the ledger as corrupt.
      opsAvailablePiconeros: 10n,
      payouts: [{ state: 'SENT', txHash: 'ab'.repeat(32) }]
    })
    const boss = fakeBoss()
    await runDistributionOnce({ models: prisma, sendPayouts: jest.fn(), boss })
    expect(boss.send).not.toHaveBeenCalled()
  })

  test('a confirmed requeue drives delivery and enqueues the delayed sweep for the latest row', async () => {
    const { dist } = await seedDistribution({ status: 'FAILED', payouts: [{ state: 'FAILED' }] })
    const boss = fakeBoss()
    const summary = await requeueFailedPayouts(prisma, dist.id, { confirm: true, sendPayouts: fakeSigner, boss })
    expect(summary.drove).toBe(true)
    expect(summary.finalStatus).toBe('COMPLETE')
    expect(boss.send).toHaveBeenCalledWith('opsSweep', { distributionId: dist.id },
      { startAfter: 3600, singletonKey: `opsSweep-${dist.id}` })
  })

  test('dry-run and --no-send requeues never drive completion and never touch the queue', async () => {
    const { dist } = await seedDistribution({ status: 'FAILED', payouts: [{ state: 'FAILED' }] })
    const boss = fakeBoss()
    const dry = await requeueFailedPayouts(prisma, dist.id, { confirm: false, boss })
    expect(dry.drove).toBe(false)
    const ledgerOnly = await requeueFailedPayouts(prisma, dist.id, { confirm: true, send: false, boss })
    expect(ledgerOnly.drove).toBe(false)
    expect(boss.send).not.toHaveBeenCalled()
  })

  // The routed Task 8 finding: a proven payout relay persists the recipients
  // but the journal fee persist fails (drive 1 -> accountingUnpersisted). The
  // no-QUEUED path must not flip COMPLETE (or schedule a sweep) until the
  // attempted journal row is resolved from the wallet's exact-hash history.
  test('two-drive all-SENT regression: an attempted journal row blocks COMPLETE until a fresh confirmed verification proves it — wallet history alone never promotes', async () => {
    const { dist, payouts } = await seedDistribution({ status: 'PENDING', payouts: [{ state: 'QUEUED' }] })
    const payout = payouts[0]
    const txHash = testHash('a1')
    const journalFee = 4_000_000n
    await seedJournalTransaction({
      txHash,
      kind: 'PAYOUT',
      state: 'PREPARED',
      relayAttemptedAt: new Date(),
      distributionId: dist.id,
      principalPiconeros: payout.piconeros,
      networkFeePiconeros: journalFee,
      metadata: { payouts: [{ payoutId: payout.id, recipientAddress: payout.recipientAddress, piconeros: payout.piconeros.toString() }] }
    })
    const boss = fakeBoss()
    alert.mockClear()

    // Drive 1: relay proven + recipients persisted, journal fee state failed.
    const drive1 = jest.fn(async (rows, { models }) => {
      for (const p of rows) {
        if (p.state === 'QUEUED') {
          await models.rewardPayout.update({ where: { id: p.id }, data: { state: 'SENT', txHash } })
        }
      }
      return { sent: 1, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 1 }
    })
    const after1 = await runDistributionOnce({ models: prisma, sendPayouts: drive1, boss })
    expect(after1.id).toBe(dist.id)
    expect(after1.status).toBe('FAILED')
    expect(boss.send).not.toHaveBeenCalled()
    expect((await prisma.rewardPayout.findUnique({ where: { id: payout.id } })).state).toBe('SENT')
    const incomplete = alert.mock.calls.find(c => c[1] === 'rewards distribution send incomplete')
    expect(incomplete).toBeTruthy()
    expect(incomplete[2]).toContain('unresolved rewards-wallet fee/journal accounting')
    expect(incomplete[2]).toContain('distinct from relayed-but-unpersisted recipient principal')
    const journalKey = { network_walletAddress_txHash: { network: TEST_NETWORK, walletAddress: TEST_WALLET_ADDRESS, txHash } }
    expect((await prisma.rewardsWalletTransaction.findUnique({ where: journalKey })).state).toBe('PREPARED')

    // Drive 2: no QUEUED rows and the signer would return zero — the readiness
    // gate must reconcile first. History does NOT prove the attempt, so the
    // distribution stays FAILED and no sweep is enqueued.
    const drive2 = jest.fn()
    const unresolvedWallet = jest.fn().mockResolvedValue(fakeWallet({ outgoing: [] }))
    const after2 = await runDistributionOnce({ models: prisma, sendPayouts: drive2, boss, getWallet: unresolvedWallet })
    expect(after2.status).toBe('FAILED')
    expect(drive2).not.toHaveBeenCalled()
    expect(unresolvedWallet).toHaveBeenCalledTimes(1)
    expect(boss.send).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('critical', 'rewards distribution completion blocked by unresolved wallet accounting',
      expect.stringContaining(String(dist.id)), expect.anything())
    expect((await prisma.rewardsWalletTransaction.findUnique({ where: journalKey })).state).toBe('PREPARED')

    // Drive 3 (capture-era contract, Finding #1): an attempted PREPARED row is
    // promoted ONLY by a fresh confirmed complete-payment verification — the
    // wallet's own outgoing history (exact hash, fee and destinations) NEVER
    // proves a relay by itself. No verifier session is available here, so the
    // attempt retains uncertainty: the row stays PREPARED+attempted, the
    // distribution stays FAILED, and no sweep is enqueued.
    const outgoing = [outgoingTransfer({
      txHash,
      feePiconeros: journalFee,
      destinations: [{ address: payout.recipientAddress, amount: payout.piconeros }]
    })]
    const historyWallet = jest.fn().mockResolvedValue(fakeWallet({ outgoing }))
    const after3 = await runDistributionOnce({ models: prisma, sendPayouts: drive2, boss, getWallet: historyWallet })
    expect(after3.status).toBe('FAILED')
    expect(drive2).not.toHaveBeenCalled()
    const unresolved3 = await prisma.rewardsWalletTransaction.findUnique({ where: journalKey })
    expect(unresolved3.state).toBe('PREPARED')
    expect(unresolved3.relayAttemptedAt).not.toBeNull()
    expect(unresolved3.relayedAt).toBeNull()
    expect(boss.send).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('critical', 'rewards distribution completion blocked by unresolved wallet accounting',
      expect.stringContaining(String(dist.id)), expect.anything())
    // The recorded delivery stands (never FAILED, never re-sent), and no new
    // payout attempt or second journal row was manufactured: the same one
    // payout and one journal row are all that exist. (The positive promotion
    // path — a fresh confirmed complete verification stamping RELAYED with
    // chain-proof-observation provenance — is pinned end to end in
    // test/api/monero/rewardsTransactions.test.js.)
    expect((await prisma.rewardPayout.findUnique({ where: { id: payout.id } })).state).toBe('SENT')
    expect(await prisma.rewardPayout.count({ where: { distributionId: dist.id } })).toBe(1)
    expect(await prisma.rewardsWalletTransaction.count({
      where: { network: TEST_NETWORK, walletAddress: TEST_WALLET_ADDRESS, distributionId: dist.id }
    })).toBe(1)
  })

  test('a rejected enqueue leaves persisted SENT recipients and the COMPLETE write untouched', async () => {
    // Required committed-state regression: drive a real send through the shared
    // completion path (recipients persist SENT), reject the queue send, and
    // prove nothing reverts — the enqueue failure is alerted, never a rollback.
    const { dist, payouts } = await seedDistribution({ status: 'PENDING', payouts: [{ state: 'QUEUED' }] })
    const payout = payouts[0]
    const boss = { send: jest.fn().mockRejectedValue(new Error('queue unavailable')) }
    alert.mockClear()
    const result = await runDistributionOnce({ models: prisma, sendPayouts: fakeSigner, boss })
    expect(result.id).toBe(dist.id)
    expect(result.status).toBe('COMPLETE')
    const payoutAfter = await prisma.rewardPayout.findUnique({ where: { id: payout.id } })
    expect(payoutAfter.state).toBe('SENT')
    expect(payoutAfter.txHash).toMatch(/^[0-9a-f]{64}$/)
    const distAfter = await prisma.rewardDistribution.findUnique({ where: { id: dist.id } })
    expect(distAfter.status).toBe('COMPLETE')
    expect(distAfter.completedAt).toBeTruthy()
    expect(boss.send).toHaveBeenCalledWith('opsSweep', { distributionId: dist.id },
      { startAfter: 3600, singletonKey: `opsSweep-${dist.id}` })
    expect(alert).toHaveBeenCalledWith('critical', 'ops sweep follow-up enqueue failed',
      expect.stringContaining(String(dist.id)), expect.objectContaining({ dedupeKey: `dist-${dist.id}-enqueue-failed` }))
  })

  // Final-review Important regression: readiness failures are wallet/RPC/SDK
  // exceptions that can carry credentials; only fixed diagnostics may reach
  // logs or alert transport — never the raw exception or its message.
  test('a credential-shaped wallet failure in readiness reaches neither logs nor alerts', async () => {
    const { dist } = await seedDistribution({
      status: 'FAILED',
      payouts: [{ state: 'SENT', txHash: testHash('c9') }]
    })
    await seedJournalTransaction({
      txHash: testHash('d9'),
      kind: 'PAYOUT',
      state: 'PREPARED',
      relayAttemptedAt: new Date(),
      distributionId: dist.id,
      principalPiconeros: 1_000_000_000n,
      networkFeePiconeros: 1_000_000n,
      metadata: { payouts: [{ payoutId: 999999, recipientAddress: '5UNKNOWNPAYOUT', piconeros: '1000000000' }] }
    })
    const sensitive = Object.assign(new Error('seed absorb abandon ability'), {
      name: 'a'.repeat(64),
      code: 'cr_live_1a2b3c4d5e6f',
      privateSpendKey: 'f'.repeat(64),
      signedTxBlob: 'deadbeef'.repeat(8)
    })
    const getWallet = jest.fn().mockRejectedValue(sensitive)
    logError.mockClear()
    logWarn.mockClear()
    alert.mockClear()
    const result = await runDistributionOnce({ models: prisma, sendPayouts: jest.fn(), boss: fakeBoss(), getWallet })
    expect(result.id).toBe(dist.id)
    expect(result.status).toBe('FAILED')
    expect(getWallet).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith('critical', 'rewards distribution completion blocked by unresolved wallet accounting',
      expect.stringContaining(String(dist.id)), expect.anything())
    const logged = util.inspect([...logError.mock.calls, ...logWarn.mock.calls, ...alert.mock.calls], { depth: 8, maxStringLength: Infinity })
    expect(logged).not.toContain('seed absorb abandon')
    expect(logged).not.toContain('cr_live_1a2b3c4d5e6f')
    expect(logged).not.toContain('f'.repeat(64))
    expect(logged).not.toContain('deadbeef'.repeat(8))
    const readinessLog = logError.mock.calls.find(args => String(args[1]).includes('completion accounting reconciliation failed'))
    expect(readinessLog[0]).toMatchObject({ errorClass: 'unknown' })
    const blocked = alert.mock.calls.find(args => args[1] === 'rewards distribution completion blocked by unresolved wallet accounting')
    expect(blocked[2]).toContain('diagnostic withheld')
    expect(blocked[2]).not.toContain('seed absorb abandon')
  })

  // Last in the block: this fixture's RELAYED conflict makes the scoped ledger
  // uncertain until removed, so it must not poison later readiness reads.
  test('a RELAYED journal conflicting with a recorded payout blocks completion with no unresolved attempt', async () => {
    const conflictHash = testHash('b1')
    const { dist, payouts } = await seedDistribution({ status: 'FAILED', payouts: [{ state: 'SENT', txHash: conflictHash }] })
    const payout = payouts[0]
    // Same hash, but the journal's member amount disagrees with the recorded
    // payout: a conflicting proven fact, not an unresolved attempt.
    await seedJournalTransaction({
      txHash: conflictHash,
      kind: 'PAYOUT',
      distributionId: dist.id,
      principalPiconeros: payout.piconeros - 1n,
      networkFeePiconeros: 4_000_000n,
      metadata: { payouts: [{ payoutId: payout.id, recipientAddress: payout.recipientAddress, piconeros: (payout.piconeros - 1n).toString() }] }
    })
    const boss = fakeBoss()
    const getWallet = jest.fn()
    alert.mockClear()
    const result = await runDistributionOnce({ models: prisma, sendPayouts: jest.fn(), boss, getWallet })
    expect(result.id).toBe(dist.id)
    expect(result.status).toBe('FAILED') // never completed over conflicting proven facts
    expect(getWallet).not.toHaveBeenCalled() // no attempt -> no wallet, but the ledger is still validated
    expect(boss.send).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('critical', 'rewards distribution completion blocked by unresolved wallet accounting',
      expect.stringContaining(String(dist.id)), expect.anything())
    // Keep the conflict from poisoning any later readiness read in this suite.
    await prisma.rewardsWalletTransaction.deleteMany({
      where: { network: TEST_NETWORK, walletAddress: TEST_WALLET_ADDRESS, txHash: conflictHash }
    })
  })
})
