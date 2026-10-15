/* eslint-env jest */

// Stubbed-wallet unit tests for sweepOpsEarmark (task B3 / spec §6.4, Task 9).
//
// These verify the ops-sweep state machine WITHOUT a real stagenet wallet or
// spend keys: the wallet is injected (a plain object exposing createTx /
// getUnlockedBalance / relayTx) and the Prisma client is an in-memory stub, so
// the suite never touches the network or spends real XMR. Mirrors the
// sendPayouts stubbed-wallet tests in test/api/monero/rewards.test.js.
//
// Task 9 wires the REAL accounting readers through this fake: the ledger and
// pool queries below feed readRewardsWalletLedger / readRewardsInflow /
// getNextRewardsPool exactly like Prisma would (never a production fixture
// bypass), the journal fake records real OPS_SWEEP facts (principal + actual
// fee), and the wallet fake debits on relay — so every protection assertion
// exercises the shipped spend bound.
//
// Run via the isolated runner:
//   docker exec stasher-rewards-repair-runner npm run test -- \
//     --runInBand --runTestsByPath test/worker/opsSweep.test.js

import { sweepOpsEarmark } from '@/api/monero/rewards'
import { logInfo, logWarn, logError } from '../../lib/logger'
import { alert } from '../../lib/alert'
import { paymentFixture, secretBundleHex } from '@/test/fixtures/payment-proof'
import { prepareWalletTransaction, relayWalletTransaction } from '@/api/monero/rewardsTransactions'

// D1 migrated rewards.js from console.* to the pino logger (lib/logger.js), so
// CRITICAL/relayed logs no longer hit console.error/console.log. Mock the logger
// with a relative path (next/jest gives jest.mock no `@/` alias) and assert on
// the logError stub — mirrors test/worker/deleteUnusedImages.test.js.
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logError: jest.fn(),
  logWarn: jest.fn()
}))
jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))

// The Task 6/7 accounting helpers bind every read and send to the configured
// rewards wallet scope: the environment must name the same primary address and
// network the fake wallet/DB rows report, or the sweep fails closed.
const savedProofEnv = Object.fromEntries([
  'PLATFORM_REWARDS_ADDRESS', 'MONERO_NETWORK', 'TXPROOF_MASTER_KEYS', 'TXPROOF_MASTER_KEY_CURRENT_VERSION'
].map(key => [key, process.env[key]]))
const payment = paymentFixture({ network: 'STAGENET' })
process.env.PLATFORM_REWARDS_ADDRESS = payment.scope.walletAddress
process.env.MONERO_NETWORK = 'stagenet'
process.env.TXPROOF_MASTER_KEYS = JSON.stringify({ 1: Buffer.alloc(32, 11).toString('base64') })
process.env.TXPROOF_MASTER_KEY_CURRENT_VERSION = '1'
const HOT = process.env.PLATFORM_REWARDS_ADDRESS
const NETWORK = String(process.env.MONERO_NETWORK).toUpperCase()
const NETWORK_TYPE = NETWORK === 'MAINNET' ? 0 : 2

const COLD_ADDRESS = payment.members[0].address
const MIN_FLOOR = 1_000_000_000n // default REWARDS_OPS_SWEEP_MIN_PICONEROS (0.001 XMR)
const TIME = new Date('2026-10-12T00:00:00.000Z')
const XMR = 1_000_000_000_000n
// A comfortably funded all-time inflow unless a test overrides it (the ledger
// balance refusal is exercised by its own test with an explicit small value).
const ALL_TIME_FUNDED = 1_000_000n * XMR

const CONFIG = {
  downvoteRewardsPct: 100,
  postingFeeRewardsPct: 70,
  territoryFeeRewardsPct: 30,
  boostRewardsPct: 30,
  walletlessTipRewardsPct: 70
}

const ZERO_ROW = {
  downvote: 0n,
  posting: 0n,
  territory: 0n,
  donate: 0n,
  donateRaw: 0n,
  boost: 0n,
  walletlesstip: 0n,
  bountyrollover: 0n,
  bountyrolloverRewards: 0n,
  bountyfee: 0n
}

const hex = prefix => prefix.repeat(32)

let savedCold, savedEnabled
beforeAll(() => {
  savedCold = process.env.REWARDS_COLD_STORAGE_ADDRESS
  savedEnabled = process.env.REWARDS_OPS_SWEEP_ENABLED
  process.env.REWARDS_COLD_STORAGE_ADDRESS = COLD_ADDRESS
  process.env.REWARDS_OPS_SWEEP_ENABLED = 'true'
})
afterAll(() => {
  for (const [key, value] of Object.entries(savedProofEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (savedCold === undefined) delete process.env.REWARDS_COLD_STORAGE_ADDRESS
  else process.env.REWARDS_COLD_STORAGE_ADDRESS = savedCold
  if (savedEnabled === undefined) delete process.env.REWARDS_OPS_SWEEP_ENABLED
  else process.env.REWARDS_OPS_SWEEP_ENABLED = savedEnabled
})

beforeEach(() => { jest.clearAllMocks() })

function makeDistribution (overrides = {}) {
  return {
    id: 1,
    opsAvailablePiconeros: 5_000_000_000_000n,
    opsNetworkFeesAccountedPiconeros: 0n,
    opsSweptPiconeros: 0n,
    opsSweepTxHash: null,
    opsSweepState: 'NOT_SWEEPED',
    ...overrides
  }
}

// A RELAYED consolidation is a pure fee fact (principal zero, self transfer).
const feeFact = (fee, txHash) => ({
  id: null,
  network: NETWORK,
  walletAddress: HOT,
  txHash,
  kind: 'CONSOLIDATION',
  accountIndex: 0,
  state: 'RELAYED',
  distributionId: null,
  principalPiconeros: 0n,
  networkFeePiconeros: fee,
  metadata: { destination: HOT, selfTransfer: true },
  preparedAt: null,
  relayAttemptedAt: null,
  relayedAt: null,
  relayProvenance: null,
  dispatchId: null,
  captureContractVersion: null,
  claimDigest: null,
  paymentClaims: null,
  proofId: null
})

// In-memory RewardsWalletTransaction model for the Task 6 journal helpers
// (prepareWalletTransaction / relayWalletTransaction /
// reconcileWalletTransactions). Same surface as the payout fake: findUnique
// resolves the (network, walletAddress, txHash) compound key, findMany filters
// (including `relayAttemptedAt: { not: null }`), create appends, updateMany
// performs the id/state CAS writes. `failCreates(n)` injects a pre-relay
// preparation failure.
function makeFakeJournal () {
  const rows = new Map()
  const proofs = new Map()
  let idSeq = 0
  let createFailures = 0
  let relayedPersistFailures = 0

  const matches = (row, where = {}) => {
    if (where.id !== undefined && String(row.id) !== String(where.id)) return false
    if (where.network !== undefined && row.network !== where.network) return false
    if (where.walletAddress !== undefined && row.walletAddress !== where.walletAddress) return false
    if (where.state !== undefined && row.state !== where.state) return false
    if (where.kind !== undefined && row.kind !== where.kind) return false
    if (where.dispatchId !== undefined) {
      if (where.dispatchId === null ? row.dispatchId != null : row.dispatchId == null) return false
    }
    if (where.relayAttemptedAt !== undefined) {
      const filter = where.relayAttemptedAt
      if (filter === null) {
        if (row.relayAttemptedAt !== null) return false
      } else if (filter && filter.not === null) {
        if (row.relayAttemptedAt == null) return false
      }
    }
    return true
  }
  const copy = row => (row ? { ...row } : row)

  return {
    rows,
    proofs,
    paymentTransactionProof: {
      async create ({ data }) {
        proofs.set(String(data.id), { ...data })
        return { ...data }
      },
      async findUnique ({ where }) {
        return copy(proofs.get(String(where.id))) ?? null
      }
    },
    async $executeRaw () { return 0 },
    async $queryRawUnsafe (sql, ...args) {
      if (/FROM "RewardsWalletTransaction"/.test(sql)) {
        const row = rows.get(Number(args[0]))
        return row ? [copy(row)] : []
      }
      if (/FROM "PaymentTransactionProof"/.test(sql)) {
        const proof = proofs.get(String(args[0]))
        if (!proof) return []
        return [sql.includes('revision') ? { revision: proof.revision } : { id: proof.id }]
      }
      throw new Error('unexpected proof-store query')
    },
    failCreates (n) { createFailures = n },
    failRelayedPersist (n) { relayedPersistFailures = n },
    matches,
    async findUnique ({ where }) {
      const key = where?.network_walletAddress_txHash
      if (key) {
        for (const row of rows.values()) {
          if (row.network === key.network && row.walletAddress === key.walletAddress && row.txHash === key.txHash) return copy(row)
        }
        return null
      }
      for (const row of rows.values()) if (matches(row, where)) return copy(row)
      return null
    },
    async create ({ data }) {
      if (createFailures > 0) {
        createFailures -= 1
        throw new Error('journal create down')
      }
      const id = ++idSeq
      const row = { id, state: 'PREPARED', preparedAt: new Date(), relayAttemptedAt: null, relayedAt: null, relayProvenance: null, ...data }
      rows.set(id, row)
      return copy(row)
    },
    async updateMany ({ where, data }) {
      if (data?.state === 'RELAYED' && relayedPersistFailures > 0) {
        relayedPersistFailures -= 1
        throw new Error('journal relayed-state persist down')
      }
      let count = 0
      for (const row of rows.values()) {
        if (!matches(row, where)) continue
        Object.assign(row, data)
        count += 1
      }
      return { count }
    }
  }
}

// In-memory Prisma surface for readRewardsWalletLedger / readRewardsInflow /
// getNextRewardsPool. `accountingFixture` shapes the DB facts (assign after
// makeFakeModels, exactly like a test seeds rows):
//   commitmentsPiconeros       outstanding QUEUED reward principal
//   nextPoolPiconeros          the next rewards pool (100%-reward donation row)
//   totalNetworkFeesPiconeros  one RELAYED consolidation fee fact
//   openCycleOpsPiconeros      this cycle's fresh ops inflow (never sweepable here)
//   transactions               extra explicit journal rows (RELAYED/attempted)
//   positiveDriftPiconeros     a stored positive-drift audit
//   allTimeInflowPiconeros     override the all-time confirmed inflow
function makeFakeModels (distribution) {
  const store = {
    id: 1,
    periodEnd: new Date('2026-10-05T00:00:00.000Z'),
    rolledOverPiconeros: 0n,
    opsNetworkFeesAccountedPiconeros: 0n,
    ...distribution
  }
  const journal = makeFakeJournal()
  const defaults = {
    commitmentsPiconeros: 0n,
    nextPoolPiconeros: 0n,
    totalNetworkFeesPiconeros: 0n,
    openCycleOpsPiconeros: 0n,
    transactions: [],
    positiveDriftPiconeros: 0n,
    allTimeInflowPiconeros: null
  }
  // A test may replace the fixture wholesale (the brief's verbatim test assigns
  // only the three core fields), so every query merges over the defaults.
  const fixture = () => ({ ...defaults, ...models.accountingFixture })
  // The audit snapshot's empty side groups: the money union reads only the
  // journal/payout/distribution facts below; the snapshot's other groups are
  // empty here and the registered platform identity matches the sweep scope.
  const snapshotGroups = {
    subaddressIndex: { findMany: async () => [] },
    feeObservation: { findMany: async () => [] },
    observedDownvote: { findMany: async () => [] },
    escrowWalletTransaction: { findMany: async () => [], findUnique: async () => null },
    bountyPayment: { findMany: async () => [] },
    observedBounty: { findMany: async () => [] },
    observedBountyReceipt: { findMany: async () => [] },
    item: { findMany: async () => [] },
    earn: { findMany: async () => [] },
    paymentTransactionProof: journal.paymentTransactionProof
  }
  const models = {
    store,
    journal,
    accountingFixture: { ...defaults },
    healthSnapshot: { upsert: jest.fn(async () => ({})) },
    platformFeeConfig: { upsert: async () => CONFIG, findUnique: async () => CONFIG },
    $executeRaw: journal.$executeRaw,
    $queryRawUnsafe: journal.$queryRawUnsafe,
    ...snapshotGroups,
    // The two readRewardsInflow windows are distinguished by the bound start
    // value, exactly as the real reader binds them.
    async $queryRaw (strings, ...values) {
      if (strings.join('').includes('synchronous_commit')) return [{ synchronous_commit: 'on' }]
      const f = fixture()
      const start = values[0]
      const row = { ...ZERO_ROW, time: TIME }
      if (start instanceof Date && start.getTime() === 0) {
        return [{ ...row, bountyfee: f.allTimeInflowPiconeros ?? ALL_TIME_FUNDED }]
      }
      const rewards = f.nextPoolPiconeros ?? 0n
      return [{ ...row, donate: rewards, donateRaw: rewards, bountyfee: f.openCycleOpsPiconeros ?? 0n }]
    },
    rewardDistribution: {
      async update ({ where, data }) {
        if (store.id !== where.id) throw new Error(`fake rewardDistribution.update: id ${where.id} not found`)
        Object.assign(store, data)
        return { ...store }
      },
      async findFirst () { return { ...store } },
      async findMany () {
        // Full closed distribution shape: the audit snapshot projects every
        // expected column; tests only vary the ops-sweep facts.
        return [{
          id: store.id,
          status: 'COMPLETE',
          periodStart: null,
          periodEnd: store.periodEnd,
          poolPiconeros: 0n,
          distributedPiconeros: 0n,
          rolledOverPiconeros: store.rolledOverPiconeros,
          payoutCount: 0,
          opsInflowPiconeros: 0n,
          opsRolledOverPiconeros: 0n,
          opsAvailablePiconeros: store.opsAvailablePiconeros,
          opsSweptPiconeros: store.opsSweptPiconeros,
          opsSweepState: store.opsSweepState ?? null,
          opsSweepTxHash: store.opsSweepTxHash ?? null,
          opsNetworkFeesAccountedPiconeros: store.opsNetworkFeesAccountedPiconeros
        }]
      }
    },
    rewardPayout: {
      async findMany () {
        const f = fixture()
        if (!(f.commitmentsPiconeros > 0n)) return []
        return [{
          id: 9001,
          distributionId: store.id,
          curatorId: 1,
          state: 'QUEUED',
          txHash: null,
          recipientAddress: '5REWARDED',
          piconeros: f.commitmentsPiconeros
        }]
      }
    },
    rewardsWalletTransaction: {
      // ONE combined view: fixture facts + journal rows the sweep itself
      // writes, so a later snapshot sees the sweep's own RELAYED rows.
      async findMany ({ where } = {}) {
        const f = fixture()
        const fixtureRows = []
        if (f.totalNetworkFeesPiconeros > 0n) fixtureRows.push(feeFact(f.totalNetworkFeesPiconeros, hex('f0')))
        for (const row of f.transactions) fixtureRows.push(row)
        return [...fixtureRows, ...journal.rows.values()]
          .filter(row => journal.matches(row, where))
          .map(row => ({ ...row }))
      },
      findUnique: journal.findUnique,
      create: journal.create,
      updateMany: journal.updateMany
    },
    rewardsWalletReconciliation: {
      async findMany () {
        const f = fixture()
        if (!(f.positiveDriftPiconeros > 0n)) return []
        // A stale fingerprint is deliberate: the drift must keep warning until
        // a check of exactly the current facts clears it.
        return [{ positiveDriftPiconeros: f.positiveDriftPiconeros, ledgerFingerprint: hex('ff') }]
      }
    },
    moneroAccount: {
      async findFirst ({ where }) {
        if (where?.label !== 'platform_rewards') return null
        return { id: 1, label: 'platform_rewards', address: HOT, network: NETWORK }
      }
    }
  }
  // Ruling: the production path must run its readers inside one transaction —
  // the mock provides $transaction rather than letting production weaken.
  models.$transaction = async fn => fn(models)
  return models
}

// Fake wallet. createTx records each request (and its relay flag) and returns
// a stub tx whose getHash() yields a unique 64-hex-char string; when relay is
// false it applies fee-aware balance validation mirroring the real wallet
// (build succeeds iff amount + that attempt's fee <= the account's CURRENT
// unlocked balance). On relay the account's unlocked funds are consumed and its
// change output is LOCKED, modelled conservatively as zero remaining unlocked
// for the rest of the run (a later build from the same account can never spend
// change that is not genuinely unlocked). throwsOn maps to every createTx,
// throwsOnAccount an account index -> Error, buildFailuresOn an account ->
// per-attempt error queue (retryable output-selection sequences),
// unlockedReadFailures `{ afterCalls, failures }` injects a transient
// getUnlockedBalance failure window starting at the given call index, and
// relayThrowsOn an account -> transport error on relay (outcome unknown).
// `feeSequence` changes the fee between rebuild attempts.
function makeFakeWallet ({
  unlocked = 10_000_000_000_000n,
  unlockedByAccount,
  unlockedAfterSync,
  totalsByAccount,
  throwsOn = false,
  throwErr = null,
  throwsOnAccount = {},
  buildFailuresOn = {},
  unlockedReadFailures = null,
  relayThrowsOn = {},
  fee = 0n,
  feeSequence = null
} = {}) {
  const calls = []
  const relayCalls = []
  const order = []
  const records = new Map()
  let byAccount = { ...(unlockedByAccount || { 0: unlocked }) }
  let n = 0
  let feeIndex = 0
  let unlockedReadCalls = 0

  const hash = () => 'ab' + String(++n).padStart(6, '0') + 'cd'.repeat(28) // 64 hex chars
  const balanceOf = idx => BigInt(byAccount[idx] ?? 0n)
  const nextFee = () => (feeSequence
    ? BigInt(feeSequence[Math.min(feeIndex++, feeSequence.length - 1)])
    : BigInt(fee))

  return {
    calls,
    relayCalls,
    order,
    records,
    async sync () {
      order.push('sync')
      if (unlockedAfterSync !== undefined) byAccount = { 0: unlockedAfterSync }
    },
    async getPrimaryAddress () { return HOT },
    async getNetworkType () { return NETWORK_TYPE },
    async getUnlockedBalance (idx) {
      order.push('getUnlockedBalance')
      const callIndex = unlockedReadCalls++
      if (unlockedReadFailures &&
        callIndex >= unlockedReadFailures.afterCalls &&
        callIndex < unlockedReadFailures.afterCalls + unlockedReadFailures.failures) {
        throw new Error('wallet rpc unavailable')
      }
      return balanceOf(idx)
    },
    async getBalance (idx) {
      return totalsByAccount ? BigInt(totalsByAccount[idx] ?? 0n) : balanceOf(idx)
    },
    async getOutgoingTransfers () {
      return [...records.values()].map(rec => ({
        getDestinations: () => rec.destinations.map(d => ({ getAddress: () => d.address, getAmount: () => d.amount })),
        getTx: () => ({
          getHash: () => rec.hash,
          getIsRelayed: () => rec.relayed,
          getIsConfirmed: () => false,
          getFee: () => rec.fee
        })
      }))
    },
    async createTx (req) {
      order.push('createTx')
      calls.push(req)
      const accountIndex = req.accountIndex ?? 0
      if (throwsOnAccount[accountIndex]) throw throwsOnAccount[accountIndex]
      if (throwsOn) throw throwErr
      const queued = buildFailuresOn[accountIndex]
      if (queued && queued.length > 0) throw queued.shift()
      const networkFee = nextFee()
      // fee-aware balance validation mirrors the real wallet on every build:
      // the fee is charged on top of the destination amount, from the source account.
      if (networkFee > 0n && balanceOf(accountIndex) < BigInt(req.amount) + networkFee) {
        throw new Error('not enough unlocked money')
      }
      const txHash = hash()
      records.set(txHash, {
        hash: txHash,
        accountIndex,
        destinations: [{ address: req.address, amount: BigInt(req.amount) }],
        fee: networkFee,
        relayed: false
      })
      return {
        getHash: () => txHash,
        getFee: async () => networkFee,
        getOutgoingTransfer: () => ({
          getDestinations: () => [{ getAddress: () => req.address, getAmount: () => BigInt(req.amount) }]
        }),
        getChangeAddress: () => null,
        getChangeAmount: async () => null,
        getKey: () => secretBundleHex(BigInt('0x' + txHash.slice(0, 12)), 2)
      }
    },
    async relayTx (tx) {
      order.push('relayTx')
      relayCalls.push(tx)
      const txHash = String(tx.getHash()).toLowerCase()
      const rec = records.get(txHash)
      if (rec && !rec.relayed) {
        if (relayThrowsOn[rec.accountIndex]) throw relayThrowsOn[rec.accountIndex] // transport failure: outcome unknown
        rec.relayed = true
        // Conservative change-locking: the send consumes the account's inputs
        // and its change output is locked, so NOTHING is unlocked/spendable
        // from this account again in the same run.
        byAccount[rec.accountIndex] = 0n
      }
      return txHash
    }
  }
}

const committedPayout = ({ id = 1, principal = 60_000_000_000n, recipient = '5A' } = {}) => ({
  id: null,
  network: NETWORK,
  walletAddress: HOT,
  txHash: hex('d1'),
  kind: 'PAYOUT',
  accountIndex: 0,
  state: 'PREPARED',
  relayAttemptedAt: new Date('2026-10-05T00:00:00.000Z'),
  distributionId: 1,
  principalPiconeros: principal,
  networkFeePiconeros: 1_000_000_000n,
  metadata: { payouts: [{ payoutId: id, recipientAddress: recipient, piconeros: principal.toString() }] },
  preparedAt: null,
  relayedAt: null,
  relayProvenance: null,
  dispatchId: null,
  captureContractVersion: null,
  claimDigest: null,
  paymentClaims: null,
  proofId: null
})

test('skips (SKIPPED_LOCKED) when the ops earmark is at/below the dust floor and never calls createTx', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: MIN_FLOOR })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(wallet.calls).toHaveLength(0)
  expect(models.store.opsSweepState).toBe('SKIPPED_LOCKED')
})

test('skips (SKIPPED_LOCKED) when unlocked balance minus the dust floor is negative', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 500_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(wallet.calls).toHaveLength(0)
})

test('sweeps the ops earmark (SWEPT) when it fits under unlocked minus the floor', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(res.swept).toBe(3_000_000_000_000n)
  expect(res.txHash).toMatch(/^[0-9a-f]{64}$/)
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0]).toEqual({
    accountIndex: 0,
    address: COLD_ADDRESS,
    amount: 3_000_000_000_000n,
    relay: false
  })
  expect(wallet.relayCalls).toHaveLength(1)
  expect(models.store.opsSweepState).toBe('SWEPT')
  expect(models.store.opsSweptPiconeros).toBe(3_000_000_000_000n)
  expect(models.store.opsSweepTxHash).toBe(res.txHash)
})

test('caps the swept amount at unlocked minus the dust floor when the earmark exceeds it', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 20_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(res.swept).toBe(10_000_000_000_000n - MIN_FLOOR)
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0].amount).toBe(10_000_000_000_000n - MIN_FLOOR)
})

test('skips (SKIPPED_LOCKED) on a balance error from createTx, not FAILED', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlocked: 10_000_000_000_000n,
    throwsOn: true,
    throwErr: new Error('not enough unlocked money')
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(models.store.opsSweepState).toBe('SKIPPED_LOCKED')
})

test('marks FAILED on a hard createTx error (funds stayed in the wallet)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlocked: 10_000_000_000_000n,
    throwsOn: true,
    throwErr: new Error('invalid recipient address')
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(models.store.opsSweepState).toBe('FAILED')
  expect(models.store.opsSweptPiconeros).toBe(0n)
  expect(models.store.opsSweepTxHash).toBeNull()
})

test('is idempotent on a distribution already SWEPT (no createTx call)', async () => {
  const dist = makeDistribution({
    opsSweepState: 'SWEPT',
    opsSweptPiconeros: 3_000_000_000_000n,
    opsSweepTxHash: 'ab'.repeat(32)
  })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SWEPT', txHash: 'ab'.repeat(32), swept: 3_000_000_000_000n })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.order).toEqual([])
})

test('returns DISABLED and never calls the wallet when REWARDS_COLD_STORAGE_ADDRESS is unset', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()
  const saved = process.env.REWARDS_COLD_STORAGE_ADDRESS
  process.env.REWARDS_COLD_STORAGE_ADDRESS = ''
  try {
    const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
    expect(res).toEqual({ state: 'DISABLED' })
    expect(wallet.calls).toHaveLength(0)
    expect(models.store.opsSweepState).toBe('NOT_SWEEPED')
  } finally {
    process.env.REWARDS_COLD_STORAGE_ADDRESS = saved
  }
})

test('returns DISABLED when REWARDS_OPS_SWEEP_ENABLED is false', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()
  const saved = process.env.REWARDS_OPS_SWEEP_ENABLED
  process.env.REWARDS_OPS_SWEEP_ENABLED = 'false'
  try {
    const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
    expect(res).toEqual({ state: 'DISABLED' })
    expect(wallet.calls).toHaveLength(0)
  } finally {
    process.env.REWARDS_OPS_SWEEP_ENABLED = saved
  }
})

test('persists SWEPT (not FAILED) when the first DB update throws but the retry succeeds', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const update = jest.fn()
    .mockRejectedValueOnce(new Error('transient db connection blip'))
    .mockResolvedValue({ id: dist.id })
  models.rewardDistribution.update = update
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  logError.mockClear()
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(update).toHaveBeenCalledTimes(2)
  const persisted = update.mock.calls[1][0].data
  expect(persisted.opsSweepState).toBe('SWEPT')
  expect(persisted.opsSweptPiconeros).toBe(3_000_000_000_000n)
  expect(persisted.opsSweepTxHash).toMatch(/^[0-9a-f]{64}$/)
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ distributionId: dist.id, txHash: persisted.opsSweepTxHash }),
    expect.stringContaining('CRITICAL')
  )
})

test('sweeps once the wallet is synced, even when the cached balance was stale', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  // Cached view stale: 500e6 - floor is negative -> would SKIPPED_LOCKED. The
  // sync refreshes it to cover the earmark.
  const wallet = makeFakeWallet({ unlocked: 500_000_000n, unlockedAfterSync: 10_000_000_000_000n })

  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })

  expect(res.state).toBe('SWEPT')
  expect(wallet.order[0]).toBe('sync')
  expect(wallet.order).toContain('createTx')
  expect(wallet.order.indexOf('sync')).toBeLessThan(wallet.order.indexOf('getUnlockedBalance'))
})

test('syncs the wallet exactly once before reading the balance when a sweep is attempted', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet()

  await sweepOpsEarmark({ distribution: dist, models, wallet })

  expect(wallet.order.filter(m => m === 'sync')).toHaveLength(1)
  expect(wallet.order.indexOf('sync')).toBeLessThan(wallet.order.indexOf('getUnlockedBalance'))
})

test('sweeps across multiple accounts when the earmark exceeds any single account (2026-08-24 fix)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 3_000_000_000_000n, 1: 2_500_000_000_000n } })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(res.swept).toBe(5_000_000_000_000n)
  expect(wallet.calls).toHaveLength(2)
  expect(wallet.calls[0]).toEqual({ accountIndex: 0, address: COLD_ADDRESS, amount: 3_000_000_000_000n, relay: false })
  expect(wallet.calls[1]).toEqual({ accountIndex: 1, address: COLD_ADDRESS, amount: 2_000_000_000_000n, relay: false })
  expect(wallet.relayCalls).toHaveLength(2)
  expect(models.store.opsSweptPiconeros).toBe(5_000_000_000_000n)
  expect(models.store.opsSweepTxHash).toMatch(/^[0-9a-f]{64},[0-9a-f]{64}$/)
  // Both sweeps are real journal facts (principal + exact fee = 0 here).
  const sweeps = [...models.journal.rows.values()].filter(r => r.kind === 'OPS_SWEEP')
  expect(sweeps).toHaveLength(2)
  expect(sweeps.every(r => r.state === 'RELAYED' && r.metadata.destination === COLD_ADDRESS)).toBe(true)
})

test('persists the partial sweep (relayed hashes + swept amount) when a later account hard-fails', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 3_000_000_000_000n, 1: 2_500_000_000_000n },
    throwsOnAccount: { 1: new Error('invalid recipient address') }
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('FAILED')
  expect(models.store.opsSweepState).toBe('FAILED')
  expect(models.store.opsSweptPiconeros).toBe(3_000_000_000_000n)
  expect(models.store.opsSweepTxHash).toMatch(/^[0-9a-f]{64}$/)
})

test('fee-aware sweeps: each account sends its full balance minus its real fee, inside the protected bound', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_500_000_000_000n })
  const models = makeFakeModels(dist)
  // Both sends are full-balance sends: the bound leaves two fee headrooms of
  // standing reserve (one per funded signer account).
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 3_000_000_000_000n, 1: 2_500_000_000_000n },
    fee: 400_000_000n // 0.0004 XMR — inside the 0.001 XMR headroom default
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  // Account 0: full-balance build fails twice on the 0.4e9 fee (1e9 headroom
  // steps), then sends 2.999e12. Account 1's budget is 5.498e12 - 2.9994e12,
  // so its principal is reduced to fit principal + its own 0.4e9 fee.
  expect(wallet.calls.map(c => c.amount)).toEqual([
    3_000_000_000_000n,
    2_999_000_000_000n,
    2_498_600_000_000n,
    2_498_200_000_000n
  ])
  expect(wallet.relayCalls).toHaveLength(2)
  expect(res.swept).toBe(2_999_000_000_000n + 2_498_200_000_000n)
  // principal + BOTH actual fees never exceeds needed room: unlocked minus one
  // fee headroom per funded account.
  expect(res.swept + 800_000_000n).toBe(5_500_000_000_000n - 2n * 1_000_000_000n)
  expect(models.store.opsSweptPiconeros).toBe(res.swept)
  expect(models.store.opsSweepTxHash).toMatch(/^[0-9a-f]{64},[0-9a-f]{64}$/)
})

test('defers (SKIPPED_LOCKED, not FAILED) when createTx throws "tx not possible" (retryable output-selection error)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlocked: 10_000_000_000_000n,
    throwsOn: true,
    throwErr: new Error('tx not possible')
  })
  logWarn.mockClear()
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(models.store.opsSweepState).toBe('SKIPPED_LOCKED')
  expect(wallet.calls).toHaveLength(3) // headroom-decrement retries before deferring
  expect(wallet.calls.map(c => c.amount)).toEqual([
    3_000_000_000_000n,
    3_000_000_000_000n - 1_000_000_000n,
    3_000_000_000_000n - 2_000_000_000n
  ])
  // A permanent non-lock deferral must not be silent (review finding).
  expect(logWarn).toHaveBeenCalledWith(
    expect.objectContaining({ distributionId: dist.id, target: '3000000000000' }),
    expect.stringContaining('deferred')
  )
})

test('refuses to re-drive a partially swept row (opsSwept > 0, not SWEPT) — no createTx', async () => {
  const dist = makeDistribution({
    opsAvailablePiconeros: 5_000_000_000_000n,
    opsSweptPiconeros: 3_000_000_000_000n,
    opsSweepState: 'FAILED'
  })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.calls).toHaveLength(0) // never re-targets opsAvailablePiconeros
  expect(models.store.opsSweptPiconeros).toBe(3_000_000_000_000n) // unchanged
})

test('logs the attempted amount and account unlocked balance before createTx (incident diagnosability)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  logInfo.mockClear()
  await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(logInfo).toHaveBeenCalledWith(
    expect.objectContaining({
      distributionId: dist.id,
      accountIndex: 0,
      amount: '3000000000000',
      unlocked: '10000000000000'
    }),
    'sweepOpsEarmark: attempting account sweep'
  )
})

// =============================================================================
// Task 9: protected funds — outstanding rewards, the next pool, the standing
// reserve and the sweep's own real fees all bind the spend; unresolved
// accounting refuses the sweep outright.
// =============================================================================

test('an older unpaid reward and the next pool cannot be swept for ops', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 70_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 100_000_000_000n, fee: 2_000_000_000n })
  models.accountingFixture = {
    commitmentsPiconeros: 20_000_000_000n,
    nextPoolPiconeros: 50_000_000_000n,
    totalNetworkFeesPiconeros: 0n
  }
  const result = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(result.state).toBe('SWEPT')
  expect(result.swept + 2_000_000_000n).toBeLessThanOrEqual(29_000_000_000n)
  expect(models.store.opsSweptPiconeros).toBe(result.swept)
})

test('a multiweek rewards rollover stays protected while ops sweeps more than one XMR', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 8n * XMR, rolledOverPiconeros: 4n * XMR })
  const models = makeFakeModels(dist)
  const fee = 2_000_000_000n
  const wallet = makeFakeWallet({ unlocked: 10n * XMR, fee })
  const result = await sweepOpsEarmark({ distribution: dist, models, wallet })
  // All 4 XMR held for later weeks remain protected, not just next week's cap.
  // Available debit room = 10 XMR - 4 XMR rewards - 0.001 XMR fee reserve.
  expect(result.state).toBe('SWEPT')
  expect(result.swept).toBe(5_997_000_000_000n)
  expect(result.swept + fee).toBe(6n * XMR - MIN_FLOOR)
  expect(models.store.rolledOverPiconeros).toBe(4n * XMR)
})

test('a negative ops carry is a deferral, never a spend', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 10_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  models.accountingFixture.totalNetworkFeesPiconeros = 15_000_000_000n
  const wallet = makeFakeWallet({ unlocked: 100_000_000_000n, fee: 2_000_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(wallet.calls).toHaveLength(0)
  expect(models.store.opsSweepState).toBe('SKIPPED_LOCKED')
})

test('fees incurred after the distribution checkpoint reduce the bound exactly once', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 100_000_000_000n, opsNetworkFeesAccountedPiconeros: 5_000_000_000n })
  const models = makeFakeModels(dist)
  models.accountingFixture.totalNetworkFeesPiconeros = 9_000_000_000n
  const wallet = makeFakeWallet({ unlocked: 1_000_000_000_000n, fee: 2_000_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  // corrected ops = 100 - (9 - 5) = 96; principal + actual fee = 94 + 2.
  expect(res.swept).toBe(94_000_000_000n)
  expect(res.swept + 2_000_000_000n).toBeLessThanOrEqual(96_000_000_000n)
  expect(models.store.opsSweptPiconeros).toBe(res.swept)
})

test("newly received current-cycle ops are not part of this distribution's old earmark", async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 10_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  models.accountingFixture.openCycleOpsPiconeros = 1_000_000_000_000n // 1000 XMR of fresh ops inflow
  const wallet = makeFakeWallet({ unlocked: 500_000_000_000n, fee: 0n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(res.swept).toBe(10_000_000_000n) // the old earmark only, never the fresh inflow
  expect(models.store.opsSweptPiconeros).toBe(res.swept)
})

test("two account sweeps count each account's actual fee against the protected bound", async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 40_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 20_000_000_000n, 1: 15_000_000_000n },
    fee: 2_000_000_000n
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(res.swept).toBe(29_000_000_000n) // 18 + 11: both principals fit after their fees
  expect(res.swept + 4_000_000_000n).toBe(35_000_000_000n - 2n * 1_000_000_000n) // 35 - the 2-account reserve
  expect(wallet.relayCalls).toHaveLength(2)
  const sweeps = [...models.journal.rows.values()].filter(r => r.kind === 'OPS_SWEEP')
  expect(sweeps).toHaveLength(2)
  expect(sweeps.map(r => r.networkFeePiconeros)).toEqual([2_000_000_000n, 2_000_000_000n])
  expect(models.store.opsSweptPiconeros).toBe(res.swept)
})

test('a journal-proven prior sweep (unpersisted distribution fact) cannot be swept again', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 70_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  models.accountingFixture.transactions = [{
    ...feeFact(2_000_000_000n, hex('c1')),
    network: NETWORK,
    walletAddress: HOT,
    txHash: hex('c1'),
    kind: 'OPS_SWEEP',
    state: 'RELAYED',
    distributionId: dist.id,
    principalPiconeros: 30_000_000_000n,
    networkFeePiconeros: 2_000_000_000n,
    metadata: { destination: COLD_ADDRESS },
    relayAttemptedAt: null
  }]
  const wallet = makeFakeWallet({ unlocked: 100_000_000_000n, fee: 2_000_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  // corrected ops = 70 - 30 proven swept - 2 fee = 38; this run sends 36 + 2 fee.
  expect(res.swept).toBe(36_000_000_000n)
  expect(res.swept + 30_000_000_000n + 2n * 2_000_000_000n).toBeLessThanOrEqual(70_000_000_000n)
  expect(models.store.opsSweptPiconeros).toBe(res.swept)
})

test('a directly proven payout whose journal could not persist blocks the sweep', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 50_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const principal = 60_000_000_000n
  const payout = {
    id: 7,
    distributionId: dist.id,
    curatorId: 1,
    state: 'QUEUED',
    txHash: null,
    piconeros: principal,
    recipientAddress: COLD_ADDRESS
  }
  models.rewardPayout.findMany = async () => [{ ...payout }]
  models.rewardPayout.findUnique = async ({ where }) => where.id === payout.id ? { ...payout } : null
  const wallet = makeFakeWallet({ unlocked: 100_000_000_000n, fee: 1_000_000_000n })
  const tx = await wallet.createTx({ accountIndex: 0, address: COLD_ADDRESS, amount: principal, relay: false })
  const journal = await prepareWalletTransaction({
    models,
    wallet,
    scope: { network: NETWORK, walletAddress: HOT },
    tx,
    kind: 'PAYOUT',
    accountIndex: 0,
    distributionId: dist.id,
    principalPiconeros: principal,
    metadata: { payouts: [{ payoutId: 7, recipientAddress: COLD_ADDRESS, piconeros: principal.toString() }] }
  })
  const updateMany = jest.spyOn(models.rewardsWalletTransaction, 'updateMany')
  models.journal.failRelayedPersist(2)
  const relay = await relayWalletTransaction({ models, wallet, journal, tx })
  expect(relay).toMatchObject({ relayed: true, uncertain: false, accountingUnpersisted: 1 })
  expect(updateMany.mock.calls.filter(([{ data }]) => data.state === 'RELAYED')).toHaveLength(2)
  expect(models.journal.rows.get(journal.id).state).toBe('PREPARED')
  expect(models.journal.proofs.size).toBe(1)

  // The direct broadcast is known, but its unpersisted accounting stays
  // unresolved without fresh confirmed verification. No further spend is safe.
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.calls).toHaveLength(1) // only the prior payout was built
  expect(wallet.relayCalls).toHaveLength(1) // only the prior payout was relayed
  expect(models.store.opsSweepState).toBe('NOT_SWEEPED')
  expect(alert).toHaveBeenCalledWith('critical', expect.stringContaining('accounting'), expect.any(String), expect.any(Object))
})

test('accounting becoming unsafe mid-sweep stops further relays and records the partial facts', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 30_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 20_000_000_000n, 1: 15_000_000_000n } })
  const relay = wallet.relayTx.bind(wallet)
  wallet.relayTx = async (tx) => {
    const hash = await relay(tx)
    // A concurrent reconciliation records positive drift before account 1.
    models.accountingFixture.positiveDriftPiconeros = 1n
    return hash
  }
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.relayCalls).toHaveLength(1) // account 1 is never built or relayed
  expect(models.store.opsSweepState).toBe('FAILED')
  expect(models.store.opsSweptPiconeros).toBe(20_000_000_000n)
  expect(models.store.opsSweepTxHash).toMatch(/^[0-9a-f]{64}$/)
  expect(alert).toHaveBeenCalledWith('critical', expect.stringContaining('accounting'), expect.any(String), expect.any(Object))
})

test('an uncertain relay stops further account sweeps and records the known partial facts', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 30_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 20_000_000_000n, 1: 15_000_000_000n },
    relayThrowsOn: { 1: new Error('socket hang up') }
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.relayCalls).toHaveLength(2) // account 0 relayed; account 1 attempted
  expect(models.store.opsSweepState).toBe('FAILED')
  expect(models.store.opsSweptPiconeros).toBe(20_000_000_000n) // only the proven prior relay
  expect(models.store.opsSweepTxHash).toMatch(/^[0-9a-f]{64}$/)
  // The unresolved attempt stays PREPARED+attempted (blocks the next sweep
  // until exact-hash history proves the outcome).
  const unresolved = [...models.journal.rows.values()].filter(r => r.state === 'PREPARED' && r.relayAttemptedAt)
  expect(unresolved).toHaveLength(1)
  expect(alert).toHaveBeenCalledWith('critical', expect.stringContaining('uncertain'), expect.any(String), expect.any(Object))
})

test('an unresolved journal attempt refuses the sweep with a specific alert and no wallet relay', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 50_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  models.accountingFixture.transactions = [{
    ...feeFact(1_000_000_000n, hex('d2')),
    network: NETWORK,
    walletAddress: HOT,
    txHash: hex('d2'),
    kind: 'OPS_SWEEP',
    state: 'PREPARED',
    relayAttemptedAt: new Date('2026-10-05T00:00:00.000Z'),
    distributionId: dist.id,
    principalPiconeros: 5_000_000_000n,
    networkFeePiconeros: 1_000_000_000n,
    metadata: { destination: COLD_ADDRESS }
  }]
  const wallet = makeFakeWallet({ unlocked: 100_000_000_000n, fee: 0n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.store.opsSweepState).toBe('NOT_SWEEPED') // no distribution-state mutation
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.stringContaining('accounting'),
    expect.stringContaining(`distribution ${dist.id}`),
    expect.objectContaining({ dedupeKey: expect.stringContaining(String(dist.id)) })
  )
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ distributionId: dist.id }),
    expect.stringContaining('CRITICAL')
  )
})

test('a ledger uncertainty (attempted payout facts) refuses the sweep without any state change', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 50_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  models.accountingFixture.transactions = [committedPayout({ id: 7, principal: 60_000_000_000n })]
  const wallet = makeFakeWallet({ unlocked: 100_000_000_000n, fee: 0n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.store.opsSweepState).toBe('NOT_SWEEPED')
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.stringContaining('accounting'),
    expect.stringContaining(`distribution ${dist.id}`),
    expect.any(Object)
  )
})

test('a wallet that cannot prove the configured rewards scope is refused before any build', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000n, fee: 0n })
  wallet.getPrimaryAddress = async () => '5SOMEBODYELSE'
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.store.opsSweepState).toBe('NOT_SWEEPED')
  expect(alert).toHaveBeenCalledWith('critical', expect.stringContaining('wallet'), expect.any(String), expect.any(Object))
})

test('a stored positive ledger drift refuses the sweep', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 50_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  models.accountingFixture.positiveDriftPiconeros = 7_000_000_000n
  const wallet = makeFakeWallet({ unlocked: 100_000_000_000n, fee: 0n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.store.opsSweepState).toBe('NOT_SWEEPED')
  expect(alert).toHaveBeenCalledWith('critical', expect.stringContaining('accounting'), expect.any(String), expect.any(Object))
})

test('a negative ledger balance (proven outflows exceed all-time inflow) refuses the sweep', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 50_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  models.accountingFixture.totalNetworkFeesPiconeros = 10_000_000_000n
  models.accountingFixture.allTimeInflowPiconeros = 5_000_000_000n
  const wallet = makeFakeWallet({ unlocked: 100_000_000_000n, fee: 0n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.store.opsSweepState).toBe('NOT_SWEEPED')
  expect(alert).toHaveBeenCalledWith('critical', expect.stringContaining('accounting'), expect.stringContaining('negative'), expect.any(Object))
})

test('the protected bound uses unlocked funds, never the wallet total (locked funds stay)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 100_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000n, totalsByAccount: { 0: 100_000_000_000n }, fee: 0n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(res.swept).toBe(10_000_000_000n - MIN_FLOOR)
  expect(models.store.opsSweptPiconeros).toBe(res.swept)
})

test('a fee that changes between rebuild attempts is revalidated and re-bounded', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 10_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlocked: 100_000_000_000n,
    feeSequence: [1_000_000_000n, 3_000_000_000n, 3_000_000_000n]
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(wallet.calls.map(c => c.amount)).toEqual([
    10_000_000_000n,
    9_000_000_000n,
    7_000_000_000n
  ])
  expect(res.swept).toBe(7_000_000_000n)
  expect(res.swept + 3_000_000_000n).toBeLessThanOrEqual(10_000_000_000n)
  const sweep = [...models.journal.rows.values()].find(r => r.kind === 'OPS_SWEEP')
  expect(sweep.networkFeePiconeros).toBe(3_000_000_000n)
  expect(sweep.principalPiconeros).toBe(res.swept)
})

test('exhausting the bounded build loop is a deferral, never an over-budget send', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 10_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlocked: 100_000_000_000n,
    feeSequence: [1_000_000_000n, 5_000_000_000n, 9_000_000_000n]
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(wallet.calls).toHaveLength(3)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.journal.rows.size).toBe(0)
  expect(models.store.opsSweepState).toBe('SKIPPED_LOCKED')
})

test('a journal preparation failure never relays and leaves the distribution state untouched', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  // Both the initial prepare and its fresh pair-resolution attempt fail.
  models.journal.failCreates(2)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000n, fee: 0n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.journal.rows.size).toBe(0)
  expect(models.store.opsSweepState).toBe('NOT_SWEEPED')
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ distributionId: dist.id }),
    expect.stringContaining('CRITICAL')
  )
})

// =============================================================================
// Review fix round 1: real liquidity caps, gauge coverage on every spending
// exit, and a guarded initial accounting read.
// =============================================================================

test('fresh caps use real unlocked liquidity: locked change cannot be swept twice', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 30_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  models.accountingFixture = {
    commitmentsPiconeros: 3_000_000_000n,
    nextPoolPiconeros: 4_000_000_000n,
    totalNetworkFeesPiconeros: 0n
  }
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 20_000_000_000n, 1: 15_000_000_000n },
    fee: 400_000_000n,
    buildFailuresOn: { 0: [new Error('tx not possible'), new Error('tx not possible')] }
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  // Account 0: two retryable failures (20 -> 19 -> 18), then 18 + 0.4 fee; its
  // 1.6 change is locked and NOT spendable again. Account 1's fresh cap is
  // 15 - 3 commitments - 4 pool - 1 (one funded-account reserve) = 7, so it
  // sends 6.6 + its own 0.4 fee — not the stale synthetic 7.6.
  expect(res.swept).toBe(24_600_000_000n)
  expect(wallet.calls.filter(c => c.accountIndex === 1).map(c => c.amount)).toEqual([
    7_000_000_000n,
    6_600_000_000n
  ])
  expect(wallet.relayCalls).toHaveLength(2)
  // Total principal + both actual fees never crosses the initial room
  // (35 unlocked - 3 - 4 - 2 reserve = 26).
  expect(res.swept + 800_000_000n).toBe(25_400_000_000n)
  expect(models.store.opsSweptPiconeros).toBe(res.swept)
})

test('a partial FAILED sweep still refreshes the balance gauge from the actual wallet', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 30_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 20_000_000_000n, 1: 15_000_000_000n },
    relayThrowsOn: { 1: new Error('socket hang up') }
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  // Account 0's send consumed its unlocked funds (change locked -> 0); account
  // 1's uncertain relay did not debit it, so the ACTUAL refreshed total is 15.
  expect(models.healthSnapshot.upsert).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 1 },
    update: expect.objectContaining({ balancePiconeros: 15_000_000_000n })
  }))
})

test('an uncertain relay with no prior send still refreshes the balance gauge', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000n, fee: 0n, relayThrowsOn: { 0: new Error('socket hang up') } })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(models.healthSnapshot.upsert).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 1 },
    update: expect.objectContaining({ balancePiconeros: 10_000_000_000n })
  }))
})

test('a gauge refresh failure never changes the sweep result (isolated metric)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 3_000_000_000_000n })
  const models = makeFakeModels(dist)
  models.healthSnapshot.upsert = jest.fn().mockRejectedValue(new Error('metrics pipeline down'))
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000_000n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res.state).toBe('SWEPT')
  expect(res.swept).toBe(3_000_000_000_000n)
  expect(models.store.opsSweptPiconeros).toBe(3_000_000_000_000n)
})

test('an initial accounting-read failure is refused (FAILED + alert), never thrown', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 5_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  // The registered platform_rewards row disagrees with the configured scope:
  // readRewardsWalletLedger throws an identity mismatch inside the snapshot.
  models.moneroAccount.findFirst = async () => ({ address: '5DIFFERENTWALLET', network: NETWORK })
  const wallet = makeFakeWallet({ unlocked: 10_000_000_000n, fee: 0n })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.store.opsSweepState).toBe('NOT_SWEEPED')
  expect(alert).toHaveBeenCalledWith(
    'critical',
    expect.stringContaining('accounting'),
    expect.stringContaining(`distribution ${dist.id}`),
    expect.objectContaining({ dedupeKey: expect.stringContaining(String(dist.id)) })
  )
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ distributionId: dist.id }),
    expect.stringContaining('CRITICAL')
  )
})

// =============================================================================
// Review fix round 2: a post-relay wallet read failure can never reject the
// run past a proven relay — it finalizes the known partial facts.
// =============================================================================

test('a post-relay balance-read failure finalizes the known partial facts (never a bare rejection)', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 30_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 20_000_000_000n, 1: 15_000_000_000n },
    unlockedReadFailures: { afterCalls: 12, failures: 1 } // the second account's refresh read fails transiently
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.relayCalls).toHaveLength(1) // account 1 is never built or relayed
  expect(models.store.opsSweepState).toBe('FAILED')
  expect(models.store.opsSweptPiconeros).toBe(20_000_000_000n)
  expect(models.store.opsSweepTxHash).toMatch(/^[0-9a-f]{64}$/)
  expect(alert).toHaveBeenCalledWith('critical', expect.stringContaining('partial'), expect.any(String), expect.any(Object))
  // The gauge refresh is attempted from the actual wallet after finalization
  // (account 0 was drained by its relay; account 1 holds 15).
  expect(models.healthSnapshot.upsert).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 1 },
    update: expect.objectContaining({ balancePiconeros: 15_000_000_000n })
  }))
})

test('a post-relay balance-read failure with a failing metric still persists the partial facts', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 30_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  models.healthSnapshot.upsert = jest.fn().mockRejectedValue(new Error('metrics pipeline down'))
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 20_000_000_000n, 1: 15_000_000_000n },
    unlockedReadFailures: { afterCalls: 12, failures: 1 }
  })
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'FAILED' })
  expect(wallet.relayCalls).toHaveLength(1)
  expect(models.store.opsSweepState).toBe('FAILED')
  expect(models.store.opsSweptPiconeros).toBe(20_000_000_000n)
  expect(models.store.opsSweepTxHash).toMatch(/^[0-9a-f]{64}$/)
  expect(alert).toHaveBeenCalledWith('critical', expect.stringContaining('partial'), expect.any(String), expect.any(Object))
})

test('a balance-read failure before any relay defers safely with a diagnostic', async () => {
  const dist = makeDistribution({ opsAvailablePiconeros: 20_000_000_000n, opsNetworkFeesAccountedPiconeros: 0n })
  const models = makeFakeModels(dist)
  const wallet = makeFakeWallet({
    unlocked: 30_000_000_000n,
    fee: 0n,
    unlockedReadFailures: { afterCalls: 6, failures: 1 } // the first loop refresh fails, before any relay
  })
  logWarn.mockClear()
  const res = await sweepOpsEarmark({ distribution: dist, models, wallet })
  expect(res).toEqual({ state: 'SKIPPED_LOCKED' })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.store.opsSweepState).toBe('SKIPPED_LOCKED')
  expect(logWarn).toHaveBeenCalledWith(
    expect.objectContaining({ distributionId: dist.id }),
    expect.stringContaining('deferring')
  )
})
