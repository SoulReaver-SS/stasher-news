/* eslint-env jest */

// Stubbed-wallet unit tests for the rewards hot-wallet signer (Task 9 / spec §6.2).
//
// These verify the sendPAYOUTS LOGIC + state machine WITHOUT a real stagenet
// wallet or spend keys: the wallet is injected (a plain object exposing
// createTx / getUnlockedBalance) and the Prisma client is an in-memory stub, so
// the suite never touches the network or spends real XMR. This is the Task-9
// primary gate; a real stagenet send is exercised end-to-end in Task 10.
//
// Run via the app container:
//   docker exec -u apprunner app npx jest test/api/monero/rewards.test.js

import { sendPayouts, resolveRewardsRestoreHeight, ensureFeeAccounts, planAccountSends } from '@/api/monero/rewards'
import { prepareWalletTransaction } from '@/api/monero/rewardsTransactions'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { alert } from '../../../lib/alert'
import * as util from 'node:util'
import { ed25519 } from '@noble/curves/ed25519'
import { base58xmr } from '@scure/base'
import { keccak256 } from 'js-sha3'
import { logInfo, logError, logWarn } from '../../../lib/logger'
import { secretBundleHex } from '@/test/fixtures/payment-proof'

// The capture barrier (Task 6/Finding #1) authenticates every send against
// the configured wallet scope and encodes every receiving address, so the
// environment must name a REAL decodable primary address the fake wallet
// reports, and every recipient label maps to a deterministic decodable
// address. The TX-proof registry gets a synthetic throwaway master key (real
// Task 2 crypto, never a real secret). Set once for the suite.
const point = scalar => Buffer.from(ed25519.ExtendedPoint.BASE.multiply(BigInt(scalar)).toRawBytes()).toString('hex')
function encodeStagenetPrimaryAddress ({ spendKey, viewKey }) {
  const body = new Uint8Array(65)
  body[0] = 24 // stagenet primary prefix
  body.set(Buffer.from(spendKey, 'hex'), 1)
  body.set(Buffer.from(viewKey, 'hex'), 33)
  const checksum = Buffer.from(keccak256(body), 'hex').subarray(0, 4)
  return base58xmr.encode(new Uint8Array([...body, ...checksum]))
}
const makeAddress = n => encodeStagenetPrimaryAddress({ spendKey: point(2n * BigInt(n)), viewKey: point(2n * BigInt(n) + 1n) })

process.env.PLATFORM_REWARDS_ADDRESS = makeAddress(99)
process.env.MONERO_NETWORK = process.env.MONERO_NETWORK || 'stagenet'
process.env.TXPROOF_MASTER_KEYS = process.env.TXPROOF_MASTER_KEYS ||
  JSON.stringify({ 1: Buffer.alloc(32, 11).toString('base64') })
process.env.TXPROOF_MASTER_KEY_CURRENT_VERSION = process.env.TXPROOF_MASTER_KEY_CURRENT_VERSION || '1'
const REWARDS_ADDRESS = process.env.PLATFORM_REWARDS_ADDRESS

// Every payout recipient label maps to one deterministic decodable stagenet
// address for the whole run, so test literals stay stable labels while the
// journal claims always carry valid receiving identities.
const payoutAddressMemo = new Map()
const payoutAddress = label => {
  if (!payoutAddressMemo.has(label)) payoutAddressMemo.set(label, makeAddress(200 + payoutAddressMemo.size))
  return payoutAddressMemo.get(label)
}
// Installed monero-ts MoneroNetworkType: MAINNET=0, STAGENET=2.
const REWARDS_NETWORK_TYPE = String(process.env.MONERO_NETWORK).toUpperCase() === 'MAINNET' ? 0 : 2

// D1 migrated rewards.js from console.* to the pino logger (lib/logger.js), so
// CRITICAL/relayed logs no longer hit console.error/console.log. Mock the logger
// with a relative path (next/jest gives jest.mock no `@/` alias) and assert on
// the logInfo/logError stubs — mirrors test/worker/deleteUnusedImages.test.js.
jest.mock('../../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logError: jest.fn(),
  logWarn: jest.fn()
}))
// Operator pages are assertable without a network side effect (same pattern as
// test/worker/rewardsDistributor.test.js) — the capture barrier's reservation
// alert is part of its contract.
jest.mock('../../../lib/alert', () => ({
  __esModule: true,
  alert: jest.fn()
}))

// The build-failure state dump reads the daemon height; mock the client so
// unit tests never touch the network (the dump guards every read, but a real
// HTTP attempt could hang the suite).
jest.mock('../../../api/monero/daemonClient', () => ({
  daemonClient: { getHeight: jest.fn().mockResolvedValue(2345) }
}))

// Build a QUEUED RewardPayout-shaped row (BigInt piconeros, like the schema).
let idSeq = 1000
function makePayout (overrides = {}) {
  idSeq += 1
  const { recipientAddress, ...rest } = overrides
  return {
    id: idSeq,
    distributionId: 1,
    curatorId: 1,
    // Distinct decodable addresses by default: a capture pair's members must
    // have distinct receiving addresses within one transaction.
    recipientAddress: payoutAddress(recipientAddress ?? `payout-${idSeq}`),
    piconeros: 1_000_000_000n,
    txHash: null,
    state: 'QUEUED',
    ...rest
  }
}

// Outgoing-transfer fixture shaped like monero-ts MoneroOutgoingTransfer.
const makeOutgoing = (hash, address, amount) => ({
  getDestinations: () => [{ getAddress: () => address, getAmount: () => amount }],
  getTx: () => ({ getHash: () => hash })
})

// In-memory RewardsWalletTransaction model for the Task 6 journal helpers
// (prepareWalletTransaction / relayWalletTransaction /
// reconcileWalletTransactions). Implements the exact surface those helpers
// use — $transaction passes a client exposing this model, findUnique resolves
// the (network, walletAddress, txHash) compound key, findMany filters, create
// appends, and updateMany performs the id/l-state CAS writes. `failJournalCreate`
// injects a pre-relay preparation failure, `failRelayedPersist` a post-relay
// journal-state persist failure, and `failJournalRead` an unreadable journal.
function makeFakeJournalModel ({ failJournalCreate = 0, failRelayedPersist = 0, failJournalRead = 0 } = {}) {
  const rows = new Map()
  let idSeq = 0
  let createFailures = failJournalCreate
  let relayedPersistFailures = failRelayedPersist
  let readFailures = failJournalRead

  const matches = (row, where = {}) => {
    // The store queries with BigInt ids; the in-memory rows hold Numbers.
    if (where.id !== undefined && String(row.id) !== String(where.id)) return false
    if (where.network !== undefined && row.network !== where.network) return false
    if (where.walletAddress !== undefined && row.walletAddress !== where.walletAddress) return false
    if (where.kind !== undefined && row.kind !== where.kind) return false
    if (where.accountIndex !== undefined && row.accountIndex !== where.accountIndex) return false
    if (where.distributionId !== undefined && row.distributionId !== where.distributionId) return false
    if (where.state !== undefined && row.state !== where.state) return false
    if ('relayAttemptedAt' in where) {
      if (where.relayAttemptedAt === null ? row.relayAttemptedAt !== null : row.relayAttemptedAt === null) return false
    }
    if (where.dispatchId !== undefined) {
      // Prisma shape: an object means { not: null } (proof-era pairs only).
      const wantsPresent = where.dispatchId !== null
      if (wantsPresent ? row.dispatchId == null : row.dispatchId != null) return false
    }
    return true
  }
  const copy = row => (row ? { ...row } : row)

  // The encrypted-proof half of every captured pair, keyed by proof id (the
  // atomic pair store writes and re-reads it through the same client).
  const proofs = new Map()
  const proofModel = {
    async create ({ data }) {
      const row = { ...data }
      proofs.set(String(data.id), row)
      return { ...row }
    },
    async findUnique ({ where }) {
      const row = proofs.get(String(where?.id))
      return row ? { ...row } : null
    }
  }

  return {
    rows,
    proofs,
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
    async findMany ({ where } = {}) {
      if (readFailures > 0) {
        readFailures -= 1
        throw new Error('journal read down')
      }
      return [...rows.values()].filter(r => matches(r, where)).sort((a, b) => a.id - b.id).map(copy)
    },
    async create ({ data }) {
      if (createFailures > 0) {
        createFailures -= 1
        throw new Error('journal create down')
      }
      const id = ++idSeq
      // Prisma applies the schema default (PREPARED) for a create that omits it.
      const row = { id, state: 'PREPARED', relayAttemptedAt: null, relayedAt: null, ...data }
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
    },
    // The pair store's durability check + locked-claim SQL over the in-memory
    // rows ($transaction passes this object as the transactional client).
    async $executeRaw () { return 0 },
    async $queryRaw () { return [{ synchronous_commit: 'on' }] },
    async $queryRawUnsafe (sql, ...args) {
      if (/FROM "RewardsWalletTransaction"/.test(sql)) {
        const row = rows.get(Number(args[0]))
        return row ? [copy(row)] : []
      }
      if (/FROM "PaymentTransactionProof"/.test(sql)) {
        const proof = proofs.get(String(args[0]))
        if (!proof) return []
        return [{ ...(sql.includes('revision') ? { revision: proof.revision } : { id: proof.id }) }]
      }
      return []
    },
    paymentTransactionProof: proofModel
  }
}

// In-memory rewardPayout store: update() mutates + returns the row, mirroring
// Prisma's shape so sendPayouts can be driven without a database. The
// healthSnapshot upsert is a jest.fn so tests can assert the balance bridge
// write (and make it reject to prove the payout flow swallows persist errors).
// `journalOptions` feeds makeFakeJournalModel; `models.journal` exposes the
// in-memory rows to assertions.
function makeFakeModels (rows, journalOptions = {}) {
  const store = new Map(rows.map(r => [r.id, { ...r }]))
  const healthUpsert = jest.fn().mockResolvedValue({})
  const journal = makeFakeJournalModel(journalOptions)
  const models = {
    store,
    healthUpsert,
    journal,
    rewardsWalletTransaction: journal,
    paymentTransactionProof: journal.paymentTransactionProof,
    // The fake $transaction passes this object as the transactional client,
    // so the pair store's durability/locked-claim SQL lives here too.
    $executeRaw: journal.$executeRaw,
    $queryRaw: journal.$queryRaw,
    $queryRawUnsafe: (...args) => journal.$queryRawUnsafe(...args),
    rewardPayout: {
      async findUnique ({ where }) {
        const row = store.get(where?.id)
        return row ? { ...row } : null
      },
      async findMany ({ where } = {}) {
        return [...store.values()].filter(r =>
          (typeof where?.id !== 'number' || r.id === where.id) &&
          (!where?.id?.in || where.id.in.includes(r.id)) &&
          (!where?.recipientAddress || r.recipientAddress === where.recipientAddress) &&
          (!where?.piconeros || r.piconeros === where.piconeros) &&
          (!where?.state?.in || where.state.in.includes(r.state))).map(r => ({ ...r }))
      },
      async updateMany ({ where, data }) {
        let count = 0
        for (const row of store.values()) {
          if (where?.id !== undefined && row.id !== where.id) continue
          if (where?.state !== undefined && row.state !== where.state) continue
          if (where?.recipientAddress !== undefined && row.recipientAddress !== where.recipientAddress) continue
          if (where?.piconeros !== undefined && row.piconeros !== where.piconeros) continue
          if (where?.OR && !where.OR.some(clause => row.txHash === clause.txHash)) continue
          Object.assign(row, data)
          count += 1
        }
        return { count }
      },
      async update ({ where, data }) {
        const row = store.get(where.id)
        if (!row) throw new Error(`fake rewardPayout.update: id ${where.id} not found`)
        Object.assign(row, data)
        return { ...row }
      }
    },
    healthSnapshot: { upsert: healthUpsert },
    async $transaction (fn) { return fn(models) }
  }
  return models
}

// Fake wallet. createTx records each request (and its relay flag) and returns
// a stub tx whose getHash() yields a unique 64-hex-char string (the real
// monero-ts wallet returns a hex string too); when relay is false it applies
// fee-aware balance validation mirroring the real wallet (build succeeds iff
// destination sum + fee <= the account's CURRENT balance). Balance is deducted
// ONLY on relay, never on build, and a relayed tx then appears in outgoing
// history with its explicit relayed flag (a built-but-unrelayed one with
// false). throwsOn maps a destination address -> Error, throwsOnAccount an
// account index -> Error, to simulate hard failures. `feeByAccount` overrides
// the flat per-tx `fee`; `outgoing` prepends fixed history fixtures.
let txHashSeq = 0
const nextTxHash = () => 'ab' + String(++txHashSeq).padStart(6, '0') + 'cd'.repeat(28) // 64 hex chars

function makeFakeWallet ({ unlocked = 1_000_000_000_000_000n, unlockedByAccount, unlockedAfterSync, throwsOn = {}, throwsOnAccount = {}, fee = 0n, feeByAccount = {}, lockedByAccount = {}, lockRemainderAfterRelay = false, sweepTxCount = 1, outgoing = [], sizeErrorWhen = () => false } = {}) {
  const calls = [] // createTx requests only
  const relayCalls = [] // relayTx requests
  const sweepCalls = []
  const order = []
  const records = new Map() // txHash -> { accountIndex, destinations, fee, relayed }
  let byAccount = { ...(unlockedByAccount || { 0: unlocked }) }
  const lockedBy = { ...(lockedByAccount || {}) }

  const balanceOf = idx => BigInt(byAccount[idx] ?? 0n)
  const lockedOf = idx => BigInt(lockedBy[idx] ?? 0n)
  const feeOf = idx => BigInt(feeByAccount[idx] ?? fee)

  const recordTx = (accountIndex, destinations, networkFee) => {
    const hash = nextTxHash()
    records.set(hash, {
      hash,
      accountIndex,
      destinations: (destinations || []).map(d => ({ address: d.address, amount: BigInt(d.amount) })),
      fee: BigInt(networkFee),
      relayed: false
    })
    // Capture-grade built tx: the pair store reads the real fee, the actual
    // destinations, the change fields and the exact key bundle (synthetic
    // 64-hex key material — never real keys).
    const keySeed = BigInt('0x' + hash.slice(0, 12))
    return {
      getHash: () => hash,
      getFee: async () => BigInt(networkFee),
      getOutgoingTransfer: () => ({
        getDestinations: () => (destinations || []).map(d => ({ getAddress: () => d.address, getAmount: () => BigInt(d.amount) }))
      }),
      getChangeAddress: () => null,
      getChangeAmount: async () => null,
      // The SDK captures the SECRET-bundle STRING (final-review C1).
      getKey: () => secretBundleHex(keySeed, 2)
    }
  }

  const relayTx = async (tx) => {
    order.push('relayTx')
    relayCalls.push(tx)
    const hash = String(tx.getHash()).toLowerCase()
    const rec = records.get(hash)
    if (rec && !rec.relayed) {
      rec.relayed = true
      const spend = rec.destinations.reduce((acc, d) => acc + d.amount, 0n) + rec.fee
      byAccount[rec.accountIndex] = balanceOf(rec.accountIndex) - spend
      if (lockRemainderAfterRelay) {
        // The post-relay remainder is still a real output but is now locked:
        // total balance stays positive while unlocked funds are zero.
        lockedBy[rec.accountIndex] = lockedOf(rec.accountIndex) + balanceOf(rec.accountIndex)
        byAccount[rec.accountIndex] = 0n
      }
    }
    return hash // the real wallet returns the relayed tx hash
  }

  return {
    calls,
    relayCalls,
    sweepCalls,
    order,
    async sync () {
      order.push('sync')
      if (unlockedAfterSync !== undefined) byAccount = { 0: unlockedAfterSync }
    },
    async getPrimaryAddress () { return REWARDS_ADDRESS },
    async getNetworkType () { return REWARDS_NETWORK_TYPE },
    async getUnlockedBalance (idx) {
      order.push('getUnlockedBalance')
      return balanceOf(idx)
    },
    async getBalance (idx) { return balanceOf(idx) + lockedOf(idx) },
    async getOutgoingTransfers () {
      const built = [...records.values()].map(rec => ({
        getDestinations: () => rec.destinations.map(d => ({ getAddress: () => d.address, getAmount: () => d.amount })),
        getTx: () => ({
          getHash: () => rec.hash,
          getIsRelayed: () => rec.relayed,
          getIsConfirmed: () => false,
          getFee: () => rec.fee
        })
      }))
      return [...outgoing, ...built]
    },
    async createTx (req) {
      order.push('createTx')
      calls.push(req)
      const accountIndex = req.accountIndex ?? 0
      const hardThrown = throwsOnAccount[accountIndex] ||
        (req.destinations || []).map(d => throwsOn[d.address]).find(Boolean)
      if (hardThrown) throw hardThrown
      if (sizeErrorWhen(req)) {
        throw new Error('Transaction would be too large.  Try create_txs()')
      }
      // fee-aware balance validation mirrors the real wallet: fee is charged
      // on top of the destination sum, from the source account.
      if (req.relay === false) {
        const sum = (req.destinations || []).reduce((a, d) => a + BigInt(d.amount), 0n)
        if (sum + feeOf(accountIndex) > balanceOf(accountIndex)) {
          throw new Error('not enough unlocked money')
        }
      }
      return recordTx(accountIndex, req.destinations, feeOf(accountIndex))
    },
    relayTx,
    async sweepUnlocked ({ accountIndex, address, relay, sweepEachSubaddress }) {
      order.push('sweepUnlocked')
      const call = { accountIndex, address, relay }
      if (sweepEachSubaddress !== undefined) call.sweepEachSubaddress = sweepEachSubaddress
      sweepCalls.push(call)
      const networkFee = feeOf(accountIndex)
      const bal = balanceOf(accountIndex)
      // The count models the SDK returning several disjoint sweep txs for one
      // account-wide combine. Split the spendable value minus the REAL total
      // fees across them; never let each tx claim the whole source balance.
      const count = Math.max(1, Number(sweepTxCount))
      const totalFee = networkFee * BigInt(count)
      if (bal <= totalFee) return []
      const distributable = bal - totalFee
      const base = distributable / BigInt(count)
      const remainder = distributable % BigInt(count)
      const txs = []
      for (let i = 0; i < count; i += 1) {
        const amount = base + (i === count - 1 ? remainder : 0n)
        txs.push(recordTx(accountIndex, [{ address, amount }], networkFee))
      }
      if (relay === true) {
        for (const tx of txs) await relayTx(tx) // the real wallet relays immediately when relay is true
      }
      return txs
    }
  }
}

test('sends all QUEUED payouts in a single createTx with destinations', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5AAA' })
  const p2 = makePayout({ id: 2, recipientAddress: '5BBB' })
  const p3 = makePayout({ id: 3, recipientAddress: '5CCC' })
  const models = makeFakeModels([p1, p2, p3])
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([p1, p2, p3], { models, wallet })
  expect(summary).toEqual({ sent: 3, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0]).toEqual({
    accountIndex: 0,
    destinations: [
      { address: payoutAddress('5AAA'), amount: 1_000_000_000n },
      { address: payoutAddress('5BBB'), amount: 1_000_000_000n },
      { address: payoutAddress('5CCC'), amount: 1_000_000_000n }
    ],
    relay: false
  })
  expect(wallet.relayCalls).toHaveLength(1)
  for (const p of [p1, p2, p3]) {
    const row = models.store.get(p.id)
    expect(row.state).toBe('SENT')
    expect(row.txHash).toMatch(/^[0-9a-f]{64}$/)
  }
  const hashes = new Set([p1, p2, p3].map(p => models.store.get(p.id).txHash))
  expect(hashes.size).toBe(1) // one tx, one shared hash
})

test('a roughly ten-percent-short wallet sends the largest whole reward now', async () => {
  const a = makePayout({ id: 1, recipientAddress: '5A', piconeros: 6_000_000_000n })
  const b = makePayout({ id: 2, recipientAddress: '5B', piconeros: 4_000_000_000n })
  const models = makeFakeModels([a, b])
  const wallet = makeFakeWallet({ unlocked: 9_000_000_000n, fee: 100_000_000n })
  const summary = await sendPayouts([a, b], { models, wallet })
  expect(summary).toMatchObject({ sent: 1, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  expect(models.store.get(a.id).state).toBe('SENT')
  expect(models.store.get(b.id)).toMatchObject({ state: 'QUEUED', txHash: null, piconeros: 4_000_000_000n })
  expect(wallet.sweepCalls).toHaveLength(0)
})

test('marks every payout FAILED when createTx throws a hard error', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5BADADDR' })
  const p2 = makePayout({ id: 2, recipientAddress: '5GOOD' })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({ throwsOn: { [payoutAddress('5BADADDR')]: new Error('invalid recipient address') } })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 2, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(p1.id).state).toBe('FAILED')
  expect(models.store.get(p2.id).state).toBe('FAILED')
  expect(models.store.get(p1.id).txHash).toBeNull() // funds stayed in the wallet
})

test('treats a not-enough-money createTx error as a SKIP for the whole batch', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5LOCKED' })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ throwsOn: { [payoutAddress('5LOCKED')]: new Error('not enough unlocked money') } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(p.id).state).toBe('QUEUED')
})

test('treats a "tx not possible" createTx error as a retryable pre-relay SKIP: whole bucket stays QUEUED (2026-09-28 incident)', async () => {
  const p1 = makePayout({ id: 1 })
  const p2 = makePayout({ id: 2 })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({ throwsOnAccount: { 0: new Error('tx not possible') } })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 2, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(p1.id).state).toBe('QUEUED')
  expect(models.store.get(p2.id).state).toBe('QUEUED')
  expect(models.store.get(p1.id).txHash).toBeNull() // provably pre-relay: no tx ever existed
  expect(models.store.get(p2.id).txHash).toBeNull()
})

test('a "tx not possible" on one account skips only that bucket; the healthy account still sends, and consolidation self-heals', async () => {
  const pBig = makePayout({ id: 1, piconeros: 4_000_000_000n }) // packs onto account 0
  const pSmall = makePayout({ id: 2, piconeros: 1_000_000_000n }) // packs onto account 1
  const models = makeFakeModels([pBig, pSmall])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 5_000_000_000n, 1: 2_000_000_000n },
    throwsOnAccount: { 0: new Error('tx not possible') }
  })
  const summary = await sendPayouts([pBig, pSmall], { models, wallet })
  expect(summary.sent).toBe(1)
  expect(summary.skipped).toBe(1)
  expect(summary.failed).toBe(0)
  expect(models.store.get(pBig.id).state).toBe('QUEUED') // the failed-account bucket stays QUEUED
  expect(models.store.get(pSmall.id).state).toBe('SENT') // the healthy account delivered
  // skipped > 0 triggers the consolidation self-heal (fresh output set for the next run)
  expect(wallet.sweepCalls.length).toBeGreaterThan(0)
})

test('a retryable build failure logs the guarded state dump (pre-build vs failure-time unlocked, heights) with stringified BigInts', async () => {
  const p = makePayout({ id: 1 })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 3_000_000_000n },
    throwsOnAccount: { 0: new Error('tx not possible') }
  })
  wallet.getHeight = async () => 1234
  await sendPayouts([p], { models, wallet })
  expect(logWarn).toHaveBeenCalledWith(
    expect.objectContaining({
      accountIndex: 0,
      payoutCount: 1,
      dump: expect.objectContaining({
        unlockedBeforeBuild: '3000000000',
        unlockedNow: '3000000000',
        walletHeight: 1234,
        daemonHeight: 2345
      })
    }),
    expect.stringContaining('retryable'))
})

test('the state dump never breaks the send flow when wallet diagnostics are absent or throw', async () => {
  const p = makePayout({ id: 1 })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ throwsOnAccount: { 0: new Error('transaction not possible') } })
  wallet.getHeight = () => { throw new Error('height unavailable') } // hostile diagnostics
  // note: getBalance / getOutputs are absent from the fake wallet entirely
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(p.id).state).toBe('QUEUED')
})

test('is a no-op when there are no QUEUED payouts', async () => {
  const alreadySent = makePayout({ id: 1, state: 'SENT', txHash: 'ab'.repeat(32) })
  const models = makeFakeModels([alreadySent])
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([alreadySent], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls).toHaveLength(0)
})

test('handles an empty payout list', async () => {
  const models = makeFakeModels([])
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls).toHaveLength(0)
})

test('persists the shared tx hash (SENT) when a DB update throws then retry succeeds', async () => {
  const p1 = makePayout({ id: 1 })
  const p2 = makePayout({ id: 2 })
  const models = makeFakeModels([p1, p2])
  const update = jest.fn()
    .mockRejectedValueOnce(new Error('transient db connection blip')) // first p1 persist blips
    .mockResolvedValue({ id: p1.id, state: 'SENT' })
    .mockResolvedValue({ id: p2.id, state: 'SENT' })
  models.rewardPayout.update = update
  const wallet = makeFakeWallet()
  logInfo.mockClear()
  logError.mockClear()
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(update).toHaveBeenCalledTimes(3) // p1: fail + retry, p2: once
  const persisted = update.mock.calls[1][0].data
  expect(persisted.state).toBe('SENT')
  expect(persisted.txHash).toMatch(/^[0-9a-f]{64}$/)
  expect(update.mock.calls[2][0].data.txHash).toBe(persisted.txHash) // same batch hash
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ payoutId: p1.id, txHash: persisted.txHash }),
    expect.stringContaining('CRITICAL')
  )
  expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ payoutCount: 2, txHash: persisted.txHash }), expect.stringContaining('batch created'))
})

test('sends the batch once the wallet is synced, even when the cached balance was stale (weekly-critical-path regression)', async () => {
  const p1 = makePayout({ id: 1, piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, piconeros: 3_000_000_000n })
  const models = makeFakeModels([p1, p2])
  // Cached view stale (funds arrived after open): 5e9 < 6e9 total -> would skip
  // the whole batch. The sync refreshes it to cover the sum.
  const wallet = makeFakeWallet({ unlocked: 5_000_000_000n, unlockedAfterSync: 10_000_000_000n })

  const summary = await sendPayouts([p1, p2], { models, wallet })

  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.order[0]).toBe('sync')
  expect(wallet.order.filter(m => m === 'sync')).toHaveLength(1)
  expect(wallet.order.lastIndexOf('getUnlockedBalance')).toBeLessThan(wallet.order.indexOf('createTx'))
  expect(models.store.get(p1.id).state).toBe('SENT')
  expect(models.store.get(p2.id).state).toBe('SENT')
})

test('syncs the wallet exactly once before reading the balance when there are QUEUED payouts', async () => {
  const p = makePayout({ id: 1 })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet()

  await sendPayouts([p], { models, wallet })

  expect(wallet.order.filter(m => m === 'sync')).toHaveLength(1)
  expect(wallet.order.indexOf('sync')).toBeLessThan(wallet.order.indexOf('getUnlockedBalance'))
})

test('does not touch the wallet when there are no QUEUED payouts', async () => {
  const alreadySent = makePayout({ id: 1, state: 'SENT', txHash: 'ab'.repeat(32) })
  const models = makeFakeModels([alreadySent])
  const wallet = makeFakeWallet()

  const summary = await sendPayouts([alreadySent], { models, wallet })

  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.order).toEqual([])
})

test('spends from MULTIPLE accounts when the batch spans fee-pool balances (2026-08-24 fix)', async () => {
  const p1 = makePayout({ id: 1, piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1, p2])
  // total 5e9 >= batch 5e9, but no single account covers both — aggregation is the fix
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 2_500_000_000n, 3: 3_000_000_000n } })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls).toHaveLength(2)
  // largest account first: account 3 hosts the 3e9 payout, account 0 the 2e9
  expect(wallet.calls[0].accountIndex).toBe(3)
  expect(wallet.calls[0].destinations).toEqual([{ address: p1.recipientAddress, amount: 3_000_000_000n }])
  expect(wallet.calls[1].accountIndex).toBe(0)
  expect(wallet.calls[1].destinations).toEqual([{ address: p2.recipientAddress, amount: 2_000_000_000n }])
  expect(models.store.get(1).txHash).not.toBe(models.store.get(2).txHash) // distinct txs
})

test('consolidates fee accounts into the primary when no single account can host a payout', async () => {
  const p = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  // aggregate 8e9 - the 2x1e9 conservative consolidation+payout headroom still
  // covers the 5e9 payout, so the sweep is useful recovery for the next run.
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 4_000_000_000n, 3: 4_000_000_000n } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 }) // FAILED-resumable path
  expect(wallet.calls).toHaveLength(0) // no payout sends this run
  expect(wallet.sweepCalls).toEqual([{ accountIndex: 3, address: REWARDS_ADDRESS, relay: false }])
  // The consolidation is born with relay:false, journaled BEFORE the relay, and
  // journaled as a zero-principal self transfer (Task 6 consolidation boundary).
  const consolidation = [...models.journal.rows.values()].find(r => r.kind === 'CONSOLIDATION')
  expect(consolidation).toMatchObject({ state: 'RELAYED', accountIndex: 3, principalPiconeros: 0n })
  expect(consolidation.metadata).toEqual({ selfTransfer: true, destination: REWARDS_ADDRESS })
  expect(wallet.relayCalls).toHaveLength(1) // only the consolidation sweep was relayed
  expect(models.store.get(1).state).toBe('QUEUED')
})

test('a per-account balance error skips only that account and never sweeps funds that cannot cure it', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5AAA', piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5BBB', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 2_500_000_000n, 3: 3_000_000_000n },
    throwsOnAccount: { 3: new Error('not enough unlocked money') } // tx-fee margin bites account 3
  })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(2).state).toBe('SENT') // account 0 bucket delivered
  expect(models.store.get(1).state).toBe('QUEUED') // account 3 bucket stays retryable
  // Fresh post-payout funds (2.5e9 - 2e9 = 0.5e9 on account 0 + 3e9 on account
  // 3) cannot cover the 3e9 payout plus conservative consolidation/payout
  // fees: sweeping here would burn a fee and still fail, so it is not useful.
  expect(wallet.sweepCalls).toHaveLength(0)
})

test('drop-smallest: when the fee makes a bucket overflow, the smallest payout is skipped and the rest still send (2026-08-26 fix)', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5AAA', piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5BBB', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1, p2])
  // account 0 has exactly 5e9 and a 1e9 fee: both payouts (5e9) + fee overflows,
  // so the 2e9 payout is dropped and only the 3e9 is sent.
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 5_000_000_000n }, fee: 1_000_000_000n })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(1).state).toBe('SENT') // largest (3e9) fit under 5e9 - 1e9
  expect(models.store.get(2).state).toBe('QUEUED') // smallest dropped, stays resumable
  // two createTx attempts: first the full bucket (fails), then the reduced one
  expect(wallet.calls).toHaveLength(2)
  expect(wallet.calls[1].destinations).toEqual([{ address: payoutAddress('5AAA'), amount: 3_000_000_000n }])
  expect(wallet.relayCalls).toHaveLength(1)
})

test('packing leaves fee headroom: steady-state balances send with no drop, no CRITICAL (audit #3)', async () => {
  const p1 = makePayout({ id: 1, piconeros: 2_200_000_000n })
  const p2 = makePayout({ id: 2, piconeros: 1_500_000_000n })
  const models = makeFakeModels([p1, p2])
  // fee accounts hold their exact inflows {1: 3.4e9, 2: 2.6e9}; the fake wallet
  // charges a 0.4e9 fee per tx. Unreserved packing puts 1.5e9 on account 2's
  // tail or packs toward exact fits and the fee overflows a bucket; with the
  // 1e9 reserve both buckets keep fee room and everything sends in one run.
  const wallet = makeFakeWallet({ unlockedByAccount: { 1: 3_400_000_000n, 2: 2_600_000_000n }, fee: 400_000_000n })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(1).state).toBe('SENT')
  expect(models.store.get(2).state).toBe('SENT')
  expect(wallet.relayCalls).toHaveLength(2)
})

test('a payout that cannot cover its own fee stays QUEUED and skips consolidation it cannot benefit from', async () => {
  const p = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 5_000_000_000n, 3: 1_000_000_000n }, fee: 1_000_000_000n })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(1).state).toBe('QUEUED')
  expect(wallet.relayCalls).toHaveLength(0) // nothing relayed
  // aggregate 6e9 - 2x1e9 conservative headroom < 5e9: consolidation cannot
  // make this payout spendable, so it must not burn sweep fees (spec §6).
  expect(wallet.sweepCalls).toHaveLength(0)
})

test('a relay failure after a successful create leaves the bucket QUEUED and counts the unresolved journal attempt', async () => {
  const p = makePayout({ id: 1, piconeros: 1_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  wallet.relayTx = async () => { throw new Error('daemon unreachable') }
  const summary = await sendPayouts([p], { models, wallet })
  // accountingUnpersisted counts the attempted-but-unproven journal fee state;
  // the recipient principal stays QUEUED (never FAILED after a possible relay).
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(models.store.get(1).state).toBe('QUEUED')
  expect(models.store.get(1).txHash).toBeNull()
  expect(wallet.calls).toHaveLength(1) // built once, never blindly re-built this run
})

describe('planAccountSends', () => {
  const payout = (id, piconeros) => ({ id, piconeros: BigInt(piconeros) })

  test('packs greedily first-fit-decreasing: largest account hosts the largest payouts (deterministic)', () => {
    const plan = planAccountSends([payout(1, 3e9), payout(2, 2e9), payout(3, 1e9)], { 0: 4e9, 3: 3e9 })
    expect(plan).toEqual([
      { accountIndex: 0, payouts: [payout(1, 3e9), payout(3, 1e9)] },
      { accountIndex: 3, payouts: [payout(2, 2e9)] }
    ])
  })

  test('returns null when a payout exceeds every account (only then)', () => {
    expect(planAccountSends([payout(1, 5e9)], { 0: 3e9, 3: 2e9 })).toBeNull()
    expect(planAccountSends([payout(1, 5e9), payout(2, 1e9)], { 0: 5e9, 3: 1e9 })).not.toBeNull()
  })

  test('reserves fee headroom per account when packing (audit #3)', () => {
    // the 3e9 payout lands on the 4e9 account (1e9 reserve leaves 3e9), NOT on
    // the 3e9-exact account whose reserved capacity is only 2e9
    const plan = planAccountSends([payout(1, 3e9)], { 0: 3e9, 3: 4e9 }, 1e9)
    expect(plan).toEqual([{ accountIndex: 3, payouts: [payout(1, 3e9)] }])
  })

  test('reserve floors at zero — a sub-reserve account hosts nothing, never a negative capacity', () => {
    expect(planAccountSends([payout(1, 2e9)], { 0: 3e9 }, 1e9)).toEqual([{ accountIndex: 0, payouts: [payout(1, 2e9)] }])
    expect(planAccountSends([payout(1, 3e9)], { 0: 3e9 }, 1e9)).toBeNull()
    expect(planAccountSends([payout(1, 1e9)], { 0: 5e8 }, 1e9)).toBeNull()
  })
})

// Restore-height resolver (2026-08-24 fix): env wins, then earliest inflow,
// then daemon-margin, then genesis — mirroring resolveBountyEscrowRestoreHeight.
describe('resolveRewardsRestoreHeight', () => {
  test('env height wins when set (no DB/daemon calls)', () => {
    expect(resolveRewardsRestoreHeight({ envHeight: 2187815, earliestInflowHeight: 100, daemonHeight: 5000 }))
      .toEqual({ restoreHeight: 2187815, source: 'env' })
  })

  test('earliest inflow minus margin when env is unset and inflow heights exist', () => {
    expect(resolveRewardsRestoreHeight({ envHeight: 0, earliestInflowHeight: 1500, daemonHeight: 5000 }))
      .toEqual({ restoreHeight: 500, source: 'earliest-inflow' })
  })

  test('daemon height minus margin when env and inflow are unavailable', () => {
    expect(resolveRewardsRestoreHeight({ envHeight: 0, earliestInflowHeight: null, daemonHeight: 2500 }))
      .toEqual({ restoreHeight: 1500, source: 'daemon-margin' })
  })

  test('genesis when everything is unavailable', () => {
    expect(resolveRewardsRestoreHeight({ envHeight: 0, earliestInflowHeight: null, daemonHeight: null }))
      .toEqual({ restoreHeight: 0, source: 'genesis' })
  })

  test('floors at zero (inflow near genesis)', () => {
    expect(resolveRewardsRestoreHeight({ envHeight: 0, earliestInflowHeight: 100, daemonHeight: null }))
      .toEqual({ restoreHeight: 0, source: 'earliest-inflow' })
  })
})

// Fee-account mirroring (2026-08-24 fix): a keys-restored wallet only scans
// subaddresses it has derived, so the signer must create accounts 1-5 and each
// major's subaddresses up to the pool's max minor BEFORE syncing.
describe('ensureFeeAccounts', () => {
  function makeMirrorWallet () {
    const created = { accounts: 0, subaddresses: [] } // [major] -> count created
    const accounts = [{ index: 0 }]
    const subsByMajor = new Map([[0, 1]]) // account 0 always has minor 0
    return {
      created,
      async getAccounts () { return accounts },
      async createAccount () { const idx = accounts.length; accounts.push({ index: idx }); subsByMajor.set(idx, 1); return accounts[idx] },
      async getSubaddresses (major) { return Array.from({ length: subsByMajor.get(major) || 0 }) },
      async createSubaddress (major) {
        created.subaddresses.push(major)
        subsByMajor.set(major, (subsByMajor.get(major) || 0) + 1)
      }
    }
  }

  function makeMirrorModels (rows) {
    return { $queryRaw: async () => rows }
  }

  test('creates accounts 1-5 and extends each major to the pool max minor', async () => {
    const wallet = makeMirrorWallet()
    const models = makeMirrorModels([{ major: 1, maxMinor: 3 }, { major: 5, maxMinor: 1 }])
    await ensureFeeAccounts(wallet, models)
    expect((await wallet.getAccounts()).length).toBe(6) // 0-5
    expect(wallet.created.subaddresses).toEqual([1, 1, 1, 5]) // major 1 to minor 3, major 5 to minor 1
  })

  test('no-ops with a warning when models is unavailable', async () => {
    const wallet = makeMirrorWallet()
    await ensureFeeAccounts(wallet, undefined)
    expect((await wallet.getAccounts()).length).toBe(1)
  })

  test('still creates accounts 1-5 when SubaddressIndex has no rows (fresh dev pool)', async () => {
    const wallet = makeMirrorWallet()
    const models = makeMirrorModels([])
    await ensureFeeAccounts(wallet, models)
    expect((await wallet.getAccounts()).length).toBe(6)
    expect(wallet.created.subaddresses).toEqual([])
  })

  test('mirrors only non-AVAILABLE fee subaddresses (state predicate is an untyped SQL literal)', async () => {
    const wallet = makeMirrorWallet()
    let captured = null
    const models = {
      $queryRaw: async (sql, ...values) => {
        captured = sql.join('?')
        return []
      }
    }
    await ensureFeeAccounts(wallet, models)
    expect(captured).toMatch(/si\.state <> 'AVAILABLE'/)
  })

  // Audit variant (rewards accounting repair §8 / Task 12): the read-only
  // reconciliation must derive EVERY recorded SubaddressIndex minor, including
  // AVAILABLE rows, so the audit wallet can see and compare every address.
  // Send-time behavior above is unchanged.
  test('audit mode derives AVAILABLE minors as well', async () => {
    const wallet = makeMirrorWallet()
    let includeAvailable = null
    const models = {
      $queryRaw: async (sql, ...values) => {
        includeAvailable = values.includes(true)
        return includeAvailable ? [{ major: 1, maxMinor: 2 }] : [{ major: 1, maxMinor: 0 }]
      }
    }
    await ensureFeeAccounts(wallet, models, { includeAvailable: true })
    expect(includeAvailable).toBe(true)
    expect(wallet.created.subaddresses).toEqual([1, 1]) // major 1 to minor 2
  })

  test('send mode still excludes AVAILABLE minors when no audit option is passed', async () => {
    const wallet = makeMirrorWallet()
    let includeAvailable = null
    const models = {
      $queryRaw: async (sql, ...values) => {
        includeAvailable = values.includes(true)
        return [{ major: 1, maxMinor: 1 }]
      }
    }
    await ensureFeeAccounts(wallet, models)
    expect(includeAvailable).toBe(false)
    expect(wallet.created.subaddresses).toEqual([1])
  })
})

test('consolidation skips dust accounts below 0.0001 XMR (audit #4)', async () => {
  const p = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  // account 3 = 3e9 (consolidated); account 1 = 50_000_000n dust (skipped);
  // accounts 2/4/5 empty (skipped by the existing <= 0n guard). Aggregate 7.05e9
  // minus the 2x1e9 conservative headroom still covers the 5e9 payout.
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 4_000_000_000n, 1: 50_000_000n, 3: 3_000_000_000n } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls.map(c => c.accountIndex)).toEqual([3]) // dust account NOT swept
})

test('a payout relayed but unpersisted (both DB writes fail) counts as unpersisted, not silently sent (audit #6)', async () => {
  const p1 = makePayout({ id: 1, piconeros: 1_000_000_000n })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  const update = jest.fn().mockRejectedValue(new Error('db down'))
  models.rewardPayout.update = update
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 1, accountingUnpersisted: 0 })
  expect(update).toHaveBeenCalledTimes(2) // initial + one retry
  expect(wallet.relayCalls).toHaveLength(1) // the tx DID leave the wallet
})

test('reconciles a relayed-but-unpersisted payout from wallet history instead of re-sending (audit #6)', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5RECONCILE', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('ef'.repeat(32), p1.recipientAddress, 2_000_000_000n)]
  })
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(1).state).toBe('SENT')
  expect(models.store.get(1).txHash).toBe('ef'.repeat(32))
  expect(wallet.calls).toHaveLength(0) // never re-sent — no double pay
  expect(wallet.relayCalls).toHaveLength(0)
})

test('reconciliation persist failure (both writes) counts the row unpersisted — never re-sent, never silently complete (final-review fix #1)', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5RECONFAIL', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('ab'.repeat(32), p1.recipientAddress, 2_000_000_000n)]
  })
  // findMany stays healthy (it reads the store); only the persist fails — twice
  models.rewardPayout.update = jest.fn().mockRejectedValue(new Error('db down'))
  const summary = await sendPayouts([p1], { models, wallet })
  // sent: 1 because the money moved in the prior run (match WAS found); the
  // unpersisted count keeps the distribution FAILED-resumable, never COMPLETE
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 1, accountingUnpersisted: 0 })
  expect(models.rewardPayout.update).toHaveBeenCalledTimes(2) // persist + retry, both failed
  expect(wallet.calls).toHaveLength(0) // never re-sent — no double pay
  expect(wallet.relayCalls).toHaveLength(0)
})

test('findMany failure fails closed: the row is skipped and never re-sent this run (final-review fix #2)', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5UNPROVABLE', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('cd'.repeat(32), p1.recipientAddress, 2_000_000_000n)] // relayed last run
  })
  models.rewardPayout.findMany = jest.fn().mockRejectedValue(new Error('db down'))
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.rewardPayout.findMany).toHaveBeenCalledTimes(1)
  expect(wallet.calls).toHaveLength(0) // a blind re-send of the relayed tx would double-pay
  expect(wallet.relayCalls).toHaveLength(0)
})

test('mixed run: one row reconciles from wallet history, the unmatched one sends fresh', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5MIX', piconeros: 2_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5MIXB', piconeros: 3_000_000_000n })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('ef'.repeat(32), p1.recipientAddress, 2_000_000_000n)] // p1's lost relay only
  })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls).toHaveLength(1) // only the unmatched row sends
  expect(models.store.get(1).txHash).toBe('ef'.repeat(32)) // reconciled from history
  expect(models.store.get(2).txHash).not.toBe('ef'.repeat(32)) // fresh tx
})

test('reconciliation ignores outgoing txs already recorded on SENT payouts — no false SENT (audit #6)', async () => {
  // last week's payout to the same curator: same address, same amount, hash RECORDED
  const p1 = makePayout({ id: 1, recipientAddress: '5RECONCILE', piconeros: 2_000_000_000n })
  const prior = { id: 999, distributionId: 0, curatorId: 1, recipientAddress: p1.recipientAddress, piconeros: 2_000_000_000n, txHash: 'ef'.repeat(32), state: 'SENT' }
  const models = makeFakeModels([prior, p1])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('ef'.repeat(32), p1.recipientAddress, 2_000_000_000n)]
  })
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 }) // sent fresh
  expect(wallet.calls).toHaveLength(1) // actually sent this time
  expect(models.store.get(1).txHash).not.toBe('ef'.repeat(32))
})

// --- HealthSnapshot balance bridge: setBalanceGauge additionally persists the
// post-send unlocked balance to the single-row snapshot so the app process can
// serve monero_rewards_wallet_balance_piconeros from /api/metrics. ---

test('sendPayouts persists the post-send unlocked balance to the HealthSnapshot row', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5BRIDGE' })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet() // unlocked: 1_000_000_000_000_000n on account 0
  await sendPayouts([p1], { models, wallet })
  const expected = 1_000_000_000_000_000n - 1_000_000_000n
  expect(models.healthUpsert).toHaveBeenCalledWith({
    where: { id: 1 },
    create: { id: 1, balancePiconeros: expected, balanceUpdatedAt: expect.any(Date) },
    update: { balancePiconeros: expected, balanceUpdatedAt: expect.any(Date) }
  })
})

test('a HealthSnapshot balance persist failure never throws into the payout flow', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5BRIDGE' })
  const models = makeFakeModels([p1])
  models.healthUpsert.mockRejectedValue(new Error('db down'))
  const wallet = makeFakeWallet()
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 }) // payout flow unaffected
  await new Promise(resolve => setImmediate(resolve)) // flush the fire-and-forget catch
  expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('HealthSnapshot balance persist failed'), expect.any(Error))
})

// --- Task 8: largest-first whole payouts, journaled relays and useful-only
// consolidation. The fake journal/wallet above record real relay facts (fee,
// destinations, relayed flag) and deduct balances only on relay, so these
// tests exercise the full create -> prepare -> attempt -> relay -> persist
// boundary without any network or database. ---

test('a repeated shortage run never re-sends the paid row and never burns consolidation fees', async () => {
  const a = makePayout({ id: 1, recipientAddress: '5A', piconeros: 6_000_000_000n })
  const b = makePayout({ id: 2, recipientAddress: '5B', piconeros: 4_000_000_000n })
  const models = makeFakeModels([a, b])
  const wallet = makeFakeWallet({ unlocked: 9_000_000_000n, fee: 100_000_000n })
  const first = await sendPayouts([a, b], { models, wallet })
  expect(first).toMatchObject({ sent: 1, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  // Same-week re-drive against the same wallet view: only b is QUEUED, the
  // 6.1e9 spend already left the account, and no sweep can help b.
  const second = await sendPayouts([models.store.get(a.id), models.store.get(b.id)], { models, wallet })
  expect(second).toMatchObject({ sent: 0, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  expect(wallet.relayCalls).toHaveLength(1) // exactly one payout tx across both drives
  expect(wallet.sweepCalls).toHaveLength(0) // a true shortage never consolidates
  expect(models.store.get(a.id).state).toBe('SENT')
  expect(models.store.get(b.id).state).toBe('QUEUED')
})

test('a same-week re-drive sends only the QUEUED remainder and never re-sends the delivered row', async () => {
  const a = makePayout({ id: 1, recipientAddress: '5A', piconeros: 6_000_000_000n })
  const b = makePayout({ id: 2, recipientAddress: '5B', piconeros: 4_000_000_000n })
  const models = makeFakeModels([a, b])
  const firstWallet = makeFakeWallet({ unlocked: 9_000_000_000n, fee: 100_000_000n })
  await sendPayouts([a, b], { models, wallet: firstWallet })
  expect(models.store.get(a.id).state).toBe('SENT')
  expect(models.store.get(b.id).state).toBe('QUEUED')
  const firstHash = models.store.get(a.id).txHash

  // The re-drive (fresh same-identity wallet view with funds): only b is
  // QUEUED, so a is filtered before any build and relayed exactly once total.
  const secondWallet = makeFakeWallet({ unlocked: 9_000_000_000n, fee: 100_000_000n })
  const second = await sendPayouts([models.store.get(a.id), models.store.get(b.id)], { models, wallet: secondWallet })
  expect(second).toMatchObject({ sent: 1, skipped: 0, failed: 0, accountingUnpersisted: 0 })
  expect(secondWallet.calls).toHaveLength(1)
  expect(secondWallet.calls[0].destinations).toEqual([{ address: payoutAddress('5B'), amount: 4_000_000_000n }])
  expect(models.store.get(a.id).txHash).toBe(firstHash) // unchanged — no re-send
  expect(models.store.get(b.id).state).toBe('SENT')
})

test('equal rewards and equal account capacities assign deterministically by payout ID and account index', async () => {
  const a = makePayout({ id: 1, recipientAddress: '5A', piconeros: 1_000_000_000n })
  const b = makePayout({ id: 2, recipientAddress: '5B', piconeros: 1_000_000_000n })
  const models = makeFakeModels([a, b])
  const wallet = makeFakeWallet({ unlockedByAccount: { 2: 1_000_000_000n, 0: 1_000_000_000n } })
  const summary = await sendPayouts([b, a], { models, wallet })
  expect(summary).toMatchObject({ sent: 2, skipped: 0, failed: 0, accountingUnpersisted: 0 })
  expect(wallet.calls.map(c => c.accountIndex)).toEqual([0, 2])
  expect(wallet.calls[0].destinations).toEqual([{ address: payoutAddress('5A'), amount: 1_000_000_000n }])
  expect(wallet.calls[1].destinations).toEqual([{ address: payoutAddress('5B'), amount: 1_000_000_000n }])
})

test('a real fee that overflows one account drops that bucket while the other account still delivers (multi-account)', async () => {
  const pBig = makePayout({ id: 1, recipientAddress: '5BIG', piconeros: 3_600_000_000n })
  const pSmall = makePayout({ id: 2, recipientAddress: '5SMALL', piconeros: 1_500_000_000n })
  const models = makeFakeModels([pBig, pSmall])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 4_000_000_000n, 3: 2_000_000_000n }, fee: 500_000_000n })
  const summary = await sendPayouts([pBig, pSmall], { models, wallet })
  expect(summary).toMatchObject({ sent: 1, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  expect(models.store.get(pSmall.id).state).toBe('SENT') // 1.5e9 + 0.5e9 <= 2e9
  expect(models.store.get(pBig.id).state).toBe('QUEUED') // 3.6e9 + 0.5e9 > 4e9
  expect(wallet.calls).toHaveLength(2) // one build per account; the single-member overflow is not rebuilt
})

test('true-fee filling uses residual capacity after a drop for a smaller whole payout (never a split or double assignment)', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5A', piconeros: 5_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5B', piconeros: 4_000_000_000n })
  const p3 = makePayout({ id: 3, recipientAddress: '5C', piconeros: 3_000_000_000n })
  const models = makeFakeModels([p1, p2, p3])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n }, fee: 2_000_000_000n })
  const summary = await sendPayouts([p1, p2, p3], { models, wallet })
  expect(summary).toMatchObject({ sent: 2, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  expect(models.store.get(p1.id).state).toBe('SENT')
  expect(models.store.get(p2.id).state).toBe('QUEUED') // the dropped 4e9 stays queued
  expect(models.store.get(p3.id).state).toBe('SENT') // residual 10 - 5 - 2 = 3e9 fills it
  // Both sends share ONE tx hash: no split and no duplicate assignment.
  expect(models.store.get(p1.id).txHash).toBe(models.store.get(p3.id).txHash)
  expect(models.store.get(p2.id).txHash).toBeNull()
})

test('an affordable smaller reward still sends after the largest bucket drains on its fee', async () => {
  const pBig = makePayout({ id: 1, recipientAddress: '5A', piconeros: 5_000_000_000n })
  const pSmall = makePayout({ id: 2, recipientAddress: '5B', piconeros: 4_000_000_000n })
  const models = makeFakeModels([pBig, pSmall])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 5_000_000_000n }, fee: 500_000_000n })
  const summary = await sendPayouts([pBig, pSmall], { models, wallet })
  expect(summary).toMatchObject({ sent: 1, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  expect(models.store.get(pBig.id).state).toBe('QUEUED') // 5e9 + 0.5e9 > 5e9
  expect(models.store.get(pSmall.id).state).toBe('SENT') // 4e9 + 0.5e9 <= 5e9
  expect(wallet.calls.map(c => c.destinations)).toEqual([
    [{ address: payoutAddress('5A'), amount: 5_000_000_000n }], // the planned bucket overflows its fee
    [{ address: payoutAddress('5B'), amount: 4_000_000_000n }] // largest-first validation of the unassigned row
  ])
  expect(wallet.relayCalls).toHaveLength(1)
})

test('a retryable failure while validating an unassigned payout counts it exactly once', async () => {
  const pBig = makePayout({ id: 1, recipientAddress: '5A', piconeros: 5_000_000_000n })
  const pSmall = makePayout({ id: 2, recipientAddress: '5B', piconeros: 4_000_000_000n })
  const models = makeFakeModels([pBig, pSmall])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 5_000_000_000n },
    throwsOn: {
      [payoutAddress('5A')]: new Error('not enough unlocked money'), // the planned bucket drains
      [payoutAddress('5B')]: new Error('tx not possible') // then the unassigned build fails retryably
    }
  })
  const summary = await sendPayouts([pBig, pSmall], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 2, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(pBig.id).state).toBe('QUEUED')
  expect(models.store.get(pSmall.id).state).toBe('QUEUED')
  expect(wallet.relayCalls).toHaveLength(0)
})

test('consecutive successful fills never skip the next candidate', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5A', piconeros: 6_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5B', piconeros: 4_000_000_000n })
  const p3 = makePayout({ id: 3, recipientAddress: '5C', piconeros: 2_000_000_000n })
  const p4 = makePayout({ id: 4, recipientAddress: '5D', piconeros: 1_000_000_000n })
  const models = makeFakeModels([p1, p2, p3, p4])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n }, fee: 1_000_000_000n })
  const summary = await sendPayouts([p1, p2, p3, p4], { models, wallet })
  expect(summary).toMatchObject({ sent: 3, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  expect(models.store.get(p1.id).state).toBe('SENT')
  expect(models.store.get(p2.id).state).toBe('QUEUED') // dropped by the fee
  expect(models.store.get(p3.id).state).toBe('SENT') // first fill accepted...
  expect(models.store.get(p4.id).state).toBe('SENT') // ...must not shift this one behind the iterator
  expect(new Set([p1, p3, p4].map(p => models.store.get(p.id).txHash)).size).toBe(1)
})

test('a fee overflow drops the highest payout ID among equal smallest rewards', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5A', piconeros: 1_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5B', piconeros: 1_000_000_000n })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 2_000_000_000n }, fee: 500_000_000n })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toMatchObject({ sent: 1, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  expect(models.store.get(p1.id).state).toBe('SENT') // the lowest ID keeps the tie priority
  expect(models.store.get(p2.id).state).toBe('QUEUED')
  expect(wallet.calls[1].destinations).toEqual([{ address: payoutAddress('5A'), amount: 1_000_000_000n }])
})

test('consolidation usefulness uses fresh post-payout balances — a stale snapshot never authorizes a useless sweep', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5A', piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5B', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 2_500_000_000n, 3: 3_000_000_000n }, fee: 400_000_000n })
  const summary = await sendPayouts([p1, p2], { models, wallet })
  expect(summary).toMatchObject({ sent: 1, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  expect(models.store.get(p2.id).state).toBe('SENT') // 2e9 + 0.4e9 <= 2.5e9
  expect(models.store.get(p1.id).state).toBe('QUEUED') // 3e9 + 0.4e9 > 3e9
  // Fresh funds are 0.1e9 + 3e9 = 3.1e9, below the 3e9 payout plus the
  // conservative consolidation/payout fees: the pre-payout snapshot must not
  // authorize a sweep that cannot cure the remainder.
  expect(wallet.sweepCalls).toHaveLength(0)
})

test('retryable build omissions are logged with IDs, amounts and the retryable reason', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5A', piconeros: 3_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5B', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1, p2])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n }, throwsOnAccount: { 0: new Error('tx not possible') } })
  logInfo.mockClear()
  await sendPayouts([p1, p2], { models, wallet })
  expect(logInfo).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'retryable-build', payoutIds: [1, 2], piconeros: '5000000000' }),
    expect.stringContaining('retryable'))
})

test('unprovable accounting exclusions are logged with IDs, amounts and the reason', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5UNPROVABLE', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p1])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('cd'.repeat(32), p1.recipientAddress, 2_000_000_000n)] // relayed last run
  })
  models.rewardPayout.findMany = jest.fn().mockRejectedValue(new Error('db down'))
  logInfo.mockClear()
  const summary = await sendPayouts([p1], { models, wallet })
  expect(summary).toMatchObject({ sent: 0, skipped: 1, failed: 0 })
  expect(logInfo).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'unprovable-history', payoutIds: [1], piconeros: '2000000000' }),
    expect.stringContaining('could not prove safety'))
})

test('a fill candidate with a hard build error is FAILED while the base bucket still relays', async () => {
  const p1 = makePayout({ id: 1, recipientAddress: '5A', piconeros: 5_000_000_000n })
  const p2 = makePayout({ id: 2, recipientAddress: '5B', piconeros: 4_000_000_000n })
  const p3 = makePayout({ id: 3, recipientAddress: '5C', piconeros: 3_000_000_000n })
  const models = makeFakeModels([p1, p2, p3])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    fee: 2_000_000_000n,
    throwsOn: { [payoutAddress('5C')]: new Error('invalid recipient address') } // the fill rebuild fails hard
  })
  const summary = await sendPayouts([p1, p2, p3], { models, wallet })
  // p2 was dropped by fee fit (QUEUED, counted once); p3's hard fill error is
  // a FAILED classification (funds stayed), never a queued/retryable omission.
  expect(summary).toMatchObject({ sent: 1, skipped: 1, failed: 1, accountingUnpersisted: 0 })
  expect(models.store.get(p1.id).state).toBe('SENT') // the base bucket still relayed
  expect(models.store.get(p2.id).state).toBe('QUEUED')
  expect(models.store.get(p3.id).state).toBe('FAILED')
  expect(models.store.get(p3.id).txHash).toBeNull()
  expect(wallet.relayCalls).toHaveLength(1)
})

test('a singleton size rejection stays queued and never relays a payout', async () => {
  const p = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 20_000_000_000n },
    sizeErrorWhen: () => true
  })
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 1 })
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  expect([...models.journal.rows.values()].filter(r => r.kind === 'PAYOUT')).toHaveLength(0)
})

test('a size-rejected fill preserves the valid base', async () => {
  const a = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const b = makePayout({ id: 2, piconeros: 4_000_000_000n })
  const c = makePayout({ id: 3, piconeros: 3_000_000_000n })
  const models = makeFakeModels([a, b, c])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    fee: 2_000_000_000n,
    sizeErrorWhen: req => req.destinations.some(d => d.address === c.recipientAddress)
  })
  const result = await sendPayouts([a, b, c], { models, wallet })
  expect(result).toMatchObject({ sent: 1, failed: 0, skipped: 2 })
  expect(models.store.get(a.id).state).toBe('SENT')
  expect(models.store.get(c.id).state).toBe('QUEUED')
  expect(wallet.sweepCalls).toHaveLength(0)
})

test('a standalone fill size rejection is counted once', async () => {
  const a = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const b = makePayout({ id: 2, piconeros: 4_000_000_000n })
  const models = makeFakeModels([a, b])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 5_000_000_000n },
    fee: 500_000_000n,
    sizeErrorWhen: req => req.destinations[0].address === b.recipientAddress
  })
  const result = await sendPayouts([a, b], { models, wallet })
  expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 2 })
  expect([...models.store.values()].every(p => p.state === 'QUEUED')).toBe(true)
  // Its source cannot leave a whole payout plus headroom after the real fee:
  // the targeted cycle is attempted but refuses before journaling or relaying.
  expect(wallet.sweepCalls).toHaveLength(1)
  expect(wallet.relayCalls).toHaveLength(0)
  expect([...models.journal.rows.values()].filter(r => r.kind === 'CONSOLIDATION')).toHaveLength(0)
})

test('18 rewards use disjoint chunks with one authentic journal per transaction', async () => {
  const rows = Array.from({ length: 18 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 100_000_000_000n },
    fee: 10_000_000n,
    sizeErrorWhen: req => req.destinations.length > 15
  })
  expect(await sendPayouts(rows, { models, wallet })).toEqual({
    sent: 18, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0
  })
  expect(wallet.calls.map(c => c.destinations.length)).toEqual([15, 3])
  const journals = [...models.journal.rows.values()].filter(r => r.kind === 'PAYOUT')
  expect(journals).toHaveLength(2)
  expect(journals.every(r => r.state === 'RELAYED' && r.proofId)).toBe(true)
  const ids = journals.flatMap(r => r.metadata.payouts.map(p => p.payoutId))
  expect(ids.sort((a, b) => a - b)).toEqual(rows.map(p => p.id))
  expect(new Set(ids).size).toBe(18)
  expect(journals.reduce((n, r) => n + r.networkFeePiconeros, 0n)).toBe(20_000_000n)
})

test('smaller input-weight limits bisect without repeating a parent', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({ sizeErrorWhen: req => req.destinations.length > 2 })
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toMatchObject({ sent: 8, failed: 0, skipped: 0 })
  expect(wallet.calls.map(c => c.destinations.length)).toEqual([8, 4, 2, 2, 4, 2, 2])
  expect(wallet.calls.length).toBeLessThanOrEqual(2 * rows.length - 1)
  expect(wallet.relayCalls).toHaveLength(4)
})

test('fee exhaustion between chunks leaves the final chunk queued without inventing capacity', async () => {
  const rows = Array.from({ length: 16 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 16_000_000_000n },
    fee: 1_000_000_000n
  })
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 15, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls.map(c => c.destinations.length)).toEqual([15, 1])
  expect(wallet.relayCalls).toHaveLength(1)
  expect(models.store.get(16)).toMatchObject({ state: 'QUEUED', txHash: null })
  expect(wallet.sweepCalls).toHaveLength(0)
})

test('a positive post-relay remainder that becomes locked stops the next chunk and never authorizes a sweep', async () => {
  const rows = Array.from({ length: 16 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows)
  // 16e9 initially covers the 15e9 principal + 1e9 fee and leaves a POSITIVE
  // 4e9 remainder. The fake then moves exactly that remainder to LOCKED after
  // the first relay, so only a fresh UNLOCKED read (0) can stop chunk two —
  // fee exhaustion alone would also have stopped it. createTx/sweepUnlocked
  // are constrained to the unlocked side, and the sweep gate must not treat
  // the locked 4e9 as recovery capacity.
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    fee: 1_000_000_000n,
    lockRemainderAfterRelay: true
  })
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 15, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls.map(c => c.destinations.length)).toEqual([15, 1])
  expect(models.store.get(16)).toMatchObject({ state: 'QUEUED', txHash: null })
  expect(await wallet.getBalance(1)).toBe(4_000_000_000n) // positive post-fee remainder...
  expect(await wallet.getUnlockedBalance(1)).toBe(0n) // ...but it locked after the relay
  expect(wallet.sweepCalls).toHaveLength(0) // locked funds never authorize a fee-burning sweep

  // Fresh pre-build read: after relay #1 the second chunk reads unlocked funds
  // BEFORE it attempts a build, and that build sees the locked remainder.
  const firstRelay = wallet.order.indexOf('relayTx')
  const secondBuild = wallet.order.indexOf('createTx', firstRelay + 1)
  const secondUnlocked = wallet.order.indexOf('getUnlockedBalance', firstRelay + 1)
  expect(firstRelay).toBeGreaterThanOrEqual(0)
  expect(secondUnlocked).toBeGreaterThan(firstRelay)
  expect(secondBuild).toBeGreaterThan(secondUnlocked)
  // The sweep seam is unlocked-only too: the positive locked remainder cannot
  // produce a sweep transaction.
  expect(await wallet.sweepUnlocked({
    accountIndex: 1, address: REWARDS_ADDRESS, relay: false
  })).toEqual([])
})

// Durable CONSOLIDATION history fixtures for the targeted size-recovery gate.
// The source query is scoped by network/wallet/account and the pure policy also
// looks at distributionId, so the fake journal matcher must honor both filters.
const seedConsolidationHistory = (models, {
  id = 900,
  accountIndex = 1,
  distributionId = 7,
  state = 'RELAYED',
  network,
  walletAddress,
  relayAttemptedAt
} = {}) => {
  models.journal.rows.set(id, {
    id,
    network: network ?? String(process.env.MONERO_NETWORK || 'stagenet').toUpperCase(),
    walletAddress: walletAddress ?? REWARDS_ADDRESS,
    txHash: (String(id) + 'c0').padEnd(64, 'a').slice(0, 64),
    kind: 'CONSOLIDATION',
    state,
    accountIndex,
    distributionId,
    principalPiconeros: 0n,
    networkFeePiconeros: 1_000_000n,
    metadata: { selfTransfer: true, destination: REWARDS_ADDRESS },
    proofId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    relayAttemptedAt: relayAttemptedAt === undefined
      ? (state === 'RELAYED' ? new Date() : null)
      : relayAttemptedAt,
    relayedAt: state === 'RELAYED' ? new Date() : null
  })
  return models
}

const consolidationsOf = models => [...models.journal.rows.values()].filter(r => r.kind === 'CONSOLIDATION')

// An authentic captured-but-unattempted CONSOLIDATION pair through the real
// journal/proof store: the exact prepare->claim interruption a restart leaves
// behind. Kept local to this suite; the fake wallet never relays it.
const prepareUnattemptedConsolidation = async (models, { accountIndex = 1, distributionId = 7 } = {}) => {
  const scope = {
    network: String(process.env.MONERO_NETWORK || 'stagenet').toUpperCase(),
    walletAddress: REWARDS_ADDRESS
  }
  const pairWallet = makeFakeWallet({ unlockedByAccount: { [accountIndex]: 20_000_000_000n } })
  const [tx] = await pairWallet.sweepUnlocked({
    accountIndex,
    address: REWARDS_ADDRESS,
    relay: false,
    sweepEachSubaddress: false
  })
  await prepareWalletTransaction({
    models,
    wallet: pairWallet,
    scope,
    tx,
    kind: 'CONSOLIDATION',
    accountIndex,
    distributionId,
    principalPiconeros: 0n,
    metadata: { selfTransfer: true, destination: REWARDS_ADDRESS },
    keyProvider: createPaymentProofKeyProvider(process.env)
  })
  const row = consolidationsOf(models).find(candidate =>
    candidate.accountIndex === accountIndex && candidate.distributionId === distributionId)
  expect(row).toMatchObject({ state: 'PREPARED', relayAttemptedAt: null })
  return row
}

const legacyRecoveryAlert = stage => alert.mock.calls.find(call =>
  String(call[1]).includes(`legacy recovery ${stage}`))

const fragmentedAlert = () => alert.mock.calls.find(call => String(call[1]).includes('fragmented-inputs'))

const expectRefusalWording = (call, severity = 'warn') => {
  expect(call[0]).toBe(severity)
  const body = String(call[2])
  expect(body).toContain('No consolidation transaction or output')
  expect(body).toContain('Resolve the reported source condition')
  expect(body).toContain('check that the wallet reports unlocked funds')
  expect(body).toContain('scripts/requeue-failed-payouts.js')
  expect(body).not.toContain('consolidated outputs unlocked')
}

const expectUncertainRecoveryInstructions = (call, { accountIndex, distributionId }) => {
  expect(call[0]).toBe('critical')
  const body = String(call[2])
  expect(body).toContain(`distribution ${distributionId}`)
  expect(body).toContain(`source account ${accountIndex}`)
  expect(body).toContain('Stop.')
  expect(body).toContain('resolve the exact existing journal/reservation')
  expect(body).toContain('ANY actually relayed recovery outputs')
  expect(body).toContain('scripts/requeue-failed-payouts.js')
  expect(body.toLowerCase()).toContain('do not resend')
  expect(body.toLowerCase()).toContain('do not cancel')
  expect(body.toLowerCase()).toContain('tear down')
  expect(body.toLowerCase()).toContain('journal/proof')
  const resolveAt = body.indexOf('resolve the exact existing journal/reservation')
  const unlockAt = body.indexOf('ANY actually relayed recovery outputs')
  const retryAt = body.indexOf('scripts/requeue-failed-payouts.js')
  expect(resolveAt).toBeGreaterThanOrEqual(0)
  expect(unlockAt).toBeGreaterThan(resolveAt)
  expect(retryAt).toBeGreaterThan(unlockAt)
}

test('targeted size recovery sweeps only the fragmented source and journals attributed zero-principal consolidations', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n, 3: 2_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  logInfo.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls).toEqual([
    { accountIndex: 1, address: REWARDS_ADDRESS, relay: false, sweepEachSubaddress: false }
  ])
  const consolidations = consolidationsOf(models)
  expect(consolidations).toHaveLength(1)
  expect(consolidations[0]).toMatchObject({
    state: 'RELAYED',
    accountIndex: 1,
    distributionId: 7,
    principalPiconeros: 0n
  })
  expect(consolidations[0].proofId).toBeTruthy()
  expect(consolidations[0].metadata).toEqual({ selfTransfer: true, destination: REWARDS_ADDRESS })
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  const recoveryLog = logInfo.mock.calls.find(([fields, message]) =>
    fields?.reason === 'fragmented-inputs' && fields.distributionId === 7 &&
    String(message).includes('requeue-failed-payouts'))
  expect(recoveryLog[0]).toMatchObject({ distributionId: 7, accountIndex: 1 })
  expect(String(recoveryLog[1])).toContain('requeue-failed-payouts')
})

test('targeted size recovery permits primary account 0 self-consolidation', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 20_000_000_000n, 3: 2_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 1, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls).toEqual([
    { accountIndex: 0, address: REWARDS_ADDRESS, relay: false, sweepEachSubaddress: false }
  ])
  const consolidation = consolidationsOf(models)[0]
  expect(consolidation).toMatchObject({
    state: 'RELAYED', accountIndex: 0, distributionId: 7, principalPiconeros: 0n
  })
  expect(consolidation.metadata.destination).toBe(REWARDS_ADDRESS)
})

test('a targeted cycle below the dust floor is an explicit no-op alert', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 50_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 50_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  logWarn.mockClear()
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(0)
  expect(models.store.get(p.id).state).toBe('QUEUED')
  expect(logWarn.mock.calls.some(([fields]) =>
    fields?.reason === 'fragmented-inputs' && fields?.stage === 'dust')).toBe(true)
  const dustAlert = fragmentedAlert()
  expect(dustAlert[1]).toContain('dust')
  expect(String(dustAlert[2])).toContain('distribution 7')
  expect(String(dustAlert[2])).toContain('source account 1')
  expectRefusalWording(dustAlert, 'warn')
})

test('mixed distributions on one source run one bounded cycle and log the suppressed group', async () => {
  const first = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const second = makePayout({ id: 2, distributionId: 8, piconeros: 4_000_000_000n })
  const models = makeFakeModels([first, second])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d =>
      d.address === first.recipientAddress || d.address === second.recipientAddress)
  })
  logWarn.mockClear()
  alert.mockClear()
  const result = await sendPayouts([first, second], { models, wallet })
  expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 2, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls).toHaveLength(1) // one cycle for the source this drive
  const consolidations = consolidationsOf(models)
  expect(consolidations).toHaveLength(1)
  expect(consolidations[0].distributionId).toBe(7)
  expect(logWarn.mock.calls.some(([fields]) =>
    fields?.reason === 'fragmented-inputs' &&
    fields?.stage === 'suppressed-mixed-distribution' &&
    fields?.accountIndex === 1 && fields?.distributionId === 8)).toBe(true)
  const suppressedAlert = alert.mock.calls.find(call =>
    String(call[1]).includes('suppressed-mixed-distribution'))
  expect(suppressedAlert[1]).toContain('suppressed-mixed-distribution')
  expect(String(suppressedAlert[2])).toContain('distribution 8')
  expect(String(suppressedAlert[2])).toContain('source account 1')
  expectRefusalWording(suppressedAlert, 'warn')
  expect([...models.store.values()].every(row => row.state === 'QUEUED')).toBe(true)
})

test('an exhausted distribution/source cycle is never swept again on a later drive', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const sizeError = req => req.destinations.some(d => d.address === p.recipientAddress)
  const firstWallet = makeFakeWallet({ unlockedByAccount: { 1: 20_000_000_000n }, sizeErrorWhen: sizeError })
  const first = await sendPayouts([p], { models, wallet: firstWallet })
  expect(first).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 0 })
  expect(consolidationsOf(models)).toHaveLength(1)

  logWarn.mockClear()
  alert.mockClear()
  const secondWallet = makeFakeWallet({ unlockedByAccount: { 1: 20_000_000_000n }, sizeErrorWhen: sizeError })
  const second = await sendPayouts([models.store.get(p.id)], { models, wallet: secondWallet })
  expect(second).toMatchObject({ sent: 0, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  expect(secondWallet.sweepCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(1) // no second durable cycle
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  expect(logWarn.mock.calls.some(([fields]) =>
    fields?.reason === 'fragmented-inputs' && fields?.stage === 'exhausted')).toBe(true)
  const exhaustedAlert = fragmentedAlert()
  expect(exhaustedAlert[1]).toContain('exhausted')
  expect(String(exhaustedAlert[2])).toContain('distribution 7')
  expect(String(exhaustedAlert[2])).toContain('source account 1')
  expectRefusalWording(exhaustedAlert, 'warn')
})

test('an unresolved PREPARED recovery reserves the source after stale-pair reconciliation', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const scope = {
    network: String(process.env.MONERO_NETWORK || 'stagenet').toUpperCase(),
    walletAddress: REWARDS_ADDRESS
  }
  // Capture-grade but never claimed: the exact prepare->claim interruption the
  // stale-pair reconciliation must surface before the targeted history gate.
  const pairWallet = makeFakeWallet({ unlockedByAccount: { 1: 20_000_000_000n } })
  const [tx] = await pairWallet.sweepUnlocked({
    accountIndex: 1,
    address: REWARDS_ADDRESS,
    relay: false,
    sweepEachSubaddress: false
  })
  await prepareWalletTransaction({
    models,
    wallet: pairWallet,
    scope,
    tx,
    kind: 'CONSOLIDATION',
    accountIndex: 1,
    distributionId: 6,
    principalPiconeros: 0n,
    metadata: { selfTransfer: true, destination: REWARDS_ADDRESS },
    keyProvider: createPaymentProofKeyProvider(process.env)
  })
  const reserved = consolidationsOf(models)
  expect(reserved).toHaveLength(1)
  expect(reserved[0]).toMatchObject({ state: 'PREPARED', relayAttemptedAt: null })
  expect(reserved[0].dispatchId).toBeTruthy()
  expect(models.journal.proofs.get(String(reserved[0].proofId))).toBeTruthy()

  alert.mockClear()
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(wallet.sweepCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(1) // only the reservation fixture
  expect(models.store.get(p.id).state).toBe('QUEUED')
  expect(alert).toHaveBeenCalledWith('critical', 'Rewards wallet pair reserved (durable but unattempted)',
    expect.stringContaining(reserved[0].txHash), expect.objectContaining({
      dedupeKey: `rewards-pair-unattempted-${reserved[0].txHash}`
    }))
  const blockedAlert = fragmentedAlert()
  expect(blockedAlert[1]).toContain('reserved')
  expect(String(blockedAlert[2])).toContain('distribution 7')
  expect(String(blockedAlert[2])).toContain('source account 1')
  expectUncertainRecoveryInstructions(blockedAlert, { accountIndex: 1, distributionId: 7 })
})

test('another distribution\'s PREPARED recovery blocks a fresh cycle', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = seedConsolidationHistory(makeFakeModels([p]), {
    accountIndex: 1, distributionId: 6, state: 'PREPARED', relayAttemptedAt: null
  })
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 1 })
  expect(wallet.sweepCalls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
})

test.each(['network', 'wallet'])('recovery history scoped to another %s does not block this source', async foreign => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  seedConsolidationHistory(models, {
    accountIndex: 1,
    distributionId: 7,
    network: foreign === 'network' ? 'MAINNET' : undefined,
    walletAddress: foreign === 'wallet' ? makeAddress(250) : undefined
  })
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls).toHaveLength(1)
  expect(consolidationsOf(models)).toHaveLength(2)
})

test('a source-history read failure fails closed without leaking the exception', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const findMany = models.rewardsWalletTransaction.findMany.bind(models.rewardsWalletTransaction)
  let sourceReads = 0
  models.rewardsWalletTransaction.findMany = async args => {
    if (args?.where?.kind === 'CONSOLIDATION' && args.where.accountIndex !== undefined) {
      sourceReads += 1
      throw new Error('source history unavailable')
    }
    return findMany(args)
  }
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  logError.mockClear()
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(sourceReads).toBe(1)
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(wallet.sweepCalls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(0)
  const failureLog = logError.mock.calls.find(([fields]) =>
    fields?.reason === 'fragmented-inputs' && fields?.stage === 'history-unavailable')
  expect(failureLog[0]).toMatchObject({ accountIndex: 1, errorClass: 'unknown' })
  expect(JSON.stringify(logError.mock.calls)).not.toContain('source history unavailable')
  const readAlert = fragmentedAlert()
  expect(readAlert[1]).toContain('history')
  expect(String(readAlert[2])).toContain('distribution 7')
  expect(String(readAlert[2])).toContain('source account 1')
  expectUncertainRecoveryInstructions(readAlert, { accountIndex: 1, distributionId: 7 })
})

test('multiple targeted sweep transactions become separate proofs and fee facts', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    fee: 1_000_000_000n,
    sweepTxCount: 2,
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls).toHaveLength(1)
  expect(wallet.relayCalls).toHaveLength(2) // both constituent sweeps relayed
  const consolidations = consolidationsOf(models)
  expect(consolidations).toHaveLength(2)
  expect(consolidations.every(r => r.state === 'RELAYED' && r.principalPiconeros === 0n &&
    r.distributionId === 7 && r.accountIndex === 1 && r.proofId)).toBe(true)
  expect(new Set(consolidations.map(r => r.txHash)).size).toBe(2)
  expect(new Set(consolidations.map(r => r.proofId)).size).toBe(2)
  // Each journal row is bound to its own persisted, authentic proof record.
  const proofs = consolidations.map(r => models.journal.proofs.get(String(r.proofId)))
  expect(proofs.every(Boolean)).toBe(true)
  for (const [i, proof] of proofs.entries()) {
    expect(proof).toMatchObject({
      id: consolidations[i].proofId,
      rewardsJournalId: consolidations[i].id,
      claimDigest: consolidations[i].claimDigest
    })
    expect(proof.bindingDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(Buffer.from(proof.ciphertext).length).toBeGreaterThan(0)
  }
  expect(proofs[0].bindingDigest).not.toBe(proofs[1].bindingDigest)
  expect(proofs[0].ciphertext.equals(proofs[1].ciphertext)).toBe(false)
  expect(consolidations.reduce((sum, r) => sum + r.networkFeePiconeros, 0n)).toBe(2_000_000_000n)
  const swept = wallet.relayCalls.reduce((sum, tx) =>
    sum + tx.getOutgoingTransfer().getDestinations().reduce((a, d) => a + d.getAmount(), 0n), 0n)
  expect(swept + 2_000_000_000n).toBe(20_000_000_000n) // split, never double-claimed
})

test.each(['duplicate', 'empty'])('targeted recovery refuses a %s sweep hash set before any relay', async mode => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  wallet.sweepUnlocked = async ({ accountIndex, address, relay, sweepEachSubaddress }) => {
    wallet.sweepCalls.push({ accountIndex, address, relay, sweepEachSubaddress })
    const hash = mode === 'empty' ? '' : 'dd'.repeat(32)
    const tx = {
      getHash: () => hash,
      getFee: async () => 0n,
      getOutgoingTransfer: () => ({ getDestinations: () => [{ getAddress: () => address, getAmount: () => 1n }] }),
      getChangeAddress: () => null,
      getChangeAmount: async () => null,
      getKey: () => secretBundleHex(400n, 1)
    }
    return [tx, tx]
  }
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls).toHaveLength(1)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(0)
  expect(models.store.get(p.id).state).toBe('QUEUED')
  const call = fragmentedAlert()
  expect(call[1]).toContain('hash-invalid')
  expectRefusalWording(call, 'critical')
})

test('targeted recovery states a fixed reason and leaves payouts queued when fees leave no useful capacity', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 6_000_000_000n },
    fee: 2_000_000_000n,
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  logWarn.mockClear()
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls).toHaveLength(1)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(0) // no invented fee fact
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  expect(logWarn.mock.calls.some(([fields]) =>
    fields?.reason === 'fragmented-inputs' && fields?.stage === 'unaffordable')).toBe(true)
  const unaffordableAlert = fragmentedAlert()
  expect(unaffordableAlert[1]).toContain('unaffordable')
  expect(String(unaffordableAlert[2])).toContain('distribution 7')
  expect(String(unaffordableAlert[2])).toContain('source account 1')
  expectRefusalWording(unaffordableAlert, 'warn')
  expect(String(unaffordableAlert[2]).toLowerCase()).not.toContain('blind')
  expect(String(unaffordableAlert[2]).toLowerCase()).not.toContain('teardown')
})

test('an empty targeted sweep is not successful recovery', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  wallet.sweepUnlocked = async args => {
    wallet.sweepCalls.push(args)
    return []
  }
  logWarn.mockClear()
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls).toHaveLength(1)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(0)
  expect(models.store.get(p.id).state).toBe('QUEUED')
  expect(logWarn.mock.calls.some(([fields]) =>
    fields?.reason === 'fragmented-inputs' && fields?.stage === 'empty')).toBe(true)
  const emptyAlert = fragmentedAlert()
  expect(emptyAlert[1]).toContain('empty')
  expect(String(emptyAlert[2])).toContain('distribution 7')
  expect(String(emptyAlert[2])).toContain('source account 1')
  expectRefusalWording(emptyAlert, 'warn')
})

test('a targeted preparation failure alerts with the fixed recovery contract', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p], { failJournalCreate: 99 })
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 1 })
  expect(wallet.relayCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(0)
  const call = fragmentedAlert()
  expect(call[1]).toContain('preparation')
  expectUncertainRecoveryInstructions(call, { accountIndex: 1, distributionId: 7 })
})

test('a targeted claim failure alerts with the fixed recovery contract', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const $transaction = models.$transaction.bind(models)
  let transactions = 0
  models.$transaction = async fn => {
    transactions += 1
    if (transactions === 2) throw new Error('claim database unavailable')
    return $transaction(fn)
  }
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(transactions).toBe(2) // prepare, then the claim attempt
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 1 })
  expect(wallet.relayCalls).toHaveLength(0)
  const rows = consolidationsOf(models)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ state: 'PREPARED', relayAttemptedAt: null })
  const call = fragmentedAlert()
  expect(call[1]).toContain('claim')
  expectUncertainRecoveryInstructions(call, { accountIndex: 1, distributionId: 7 })
})

test('a targeted journal-state accounting failure alerts with the fixed recovery contract', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p], { failRelayedPersist: 2 })
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 1 })
  expect(wallet.relayCalls).toHaveLength(1) // the sweep DID relay; only its journal state failed
  const rows = consolidationsOf(models)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ state: 'PREPARED' })
  expect(rows[0].relayAttemptedAt).not.toBeNull()
  const call = fragmentedAlert()
  expect(call[1]).toContain('journal')
  expectUncertainRecoveryInstructions(call, { accountIndex: 1, distributionId: 7 })
})

test('a targeted sweep-build failure alerts with the fixed recovery contract', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  wallet.sweepUnlocked = async () => { throw new Error('sweep build unavailable') }
  logError.mockClear()
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 0 })
  expect(wallet.relayCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(0)
  expect(logError.mock.calls.some(([fields]) =>
    fields?.reason === 'fragmented-inputs' && fields?.stage === 'sweep-failed')).toBe(true)
  const call = fragmentedAlert()
  expect(call[1]).toContain('sweep')
  expect(String(call[2])).toContain('distribution 7')
  expect(String(call[2])).toContain('source account 1')
  expectRefusalWording(call, 'critical')
  expect(JSON.stringify(logError.mock.calls)).not.toContain('sweep build unavailable')
})

test('a targeted fee-read failure escalates as a critical fixed alert', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  wallet.sweepUnlocked = async ({ accountIndex, address, relay, sweepEachSubaddress }) => {
    wallet.sweepCalls.push({ accountIndex, address, relay, sweepEachSubaddress })
    return [{
      getHash: () => 'e1'.repeat(32),
      getFee: async () => { throw new Error('fee read unavailable') }
    }]
  }
  logError.mockClear()
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 0 })
  expect(wallet.relayCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(0)
  expect(logError.mock.calls.some(([fields]) =>
    fields?.reason === 'fragmented-inputs' && fields?.stage === 'fee-read')).toBe(true)
  expect(JSON.stringify(logError.mock.calls)).not.toContain('fee read unavailable')
  const call = fragmentedAlert()
  expect(call[1]).toContain('fee-read')
  expectRefusalWording(call, 'critical')
})

test('a targeted invalid-fee result escalates as a critical fixed alert', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === p.recipientAddress)
  })
  wallet.sweepUnlocked = async ({ accountIndex, address, relay, sweepEachSubaddress }) => {
    wallet.sweepCalls.push({ accountIndex, address, relay, sweepEachSubaddress })
    return [{
      getHash: () => 'e2'.repeat(32),
      getFee: async () => -1n
    }]
  }
  logError.mockClear()
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 0 })
  expect(wallet.relayCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(0)
  expect(logError.mock.calls.some(([fields]) =>
    fields?.reason === 'fragmented-inputs' && fields?.stage === 'invalid-fee')).toBe(true)
  const call = fragmentedAlert()
  expect(call[1]).toContain('invalid-fee')
  expectRefusalWording(call, 'critical')
})

test('an uncertain targeted relay is never replaced by another consolidation', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const sizeError = req => req.destinations.some(d => d.address === p.recipientAddress)
  const wallet = makeFakeWallet({ unlockedByAccount: { 1: 20_000_000_000n }, sizeErrorWhen: sizeError })
  const originalRelay = wallet.relayTx.bind(wallet)
  wallet.relayTx = async tx => {
    await originalRelay(tx) // the sweep DID broadcast...
    throw new Error('acknowledgement lost') // ...but the outcome is unresolved
  }
  alert.mockClear()
  const first = await sendPayouts([p], { models, wallet })
  expect(first).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 1 })
  const attempted = consolidationsOf(models)
  expect(attempted).toHaveLength(1)
  expect(attempted[0].state).toBe('PREPARED')
  expect(attempted[0].relayAttemptedAt).not.toBeNull()
  const originalHash = attempted[0].txHash
  const call = fragmentedAlert()
  expect(call[1]).toContain('uncertain')
  expectUncertainRecoveryInstructions(call, { accountIndex: 1, distributionId: 7 })

  const secondWallet = makeFakeWallet({ unlockedByAccount: { 1: 20_000_000_000n }, sizeErrorWhen: sizeError })
  const second = await sendPayouts([models.store.get(p.id)], { models, wallet: secondWallet })
  expect(second).toMatchObject({ sent: 0, skipped: 1, failed: 0 })
  expect(secondWallet.sweepCalls).toHaveLength(0)
  expect(secondWallet.relayCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(1)
  expect(consolidationsOf(models)[0].txHash).toBe(originalHash)
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
})

test('a targeted cycle halts after the first constituent relays and keeps its durable row', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const sizeError = req => req.destinations.some(d => d.address === p.recipientAddress)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    fee: 1_000_000_000n,
    sweepTxCount: 2,
    sizeErrorWhen: sizeError
  })
  const originalRelay = wallet.relayTx.bind(wallet)
  let relayAttempts = 0
  wallet.relayTx = async tx => {
    relayAttempts += 1
    if (relayAttempts >= 2) throw new Error('second relay failed')
    return originalRelay(tx)
  }
  const first = await sendPayouts([p], { models, wallet })
  expect(first).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 1 })
  expect(relayAttempts).toBe(2) // second attempt was made but failed
  const rows = consolidationsOf(models)
  expect(rows).toHaveLength(2)
  expect(rows.filter(r => r.state === 'RELAYED')).toHaveLength(1)
  expect(rows.filter(r => r.state === 'PREPARED' && r.relayAttemptedAt)).toHaveLength(1)
  expect(new Set(rows.map(r => r.txHash)).size).toBe(2)

  const secondWallet = makeFakeWallet({ unlockedByAccount: { 1: 20_000_000_000n }, sizeErrorWhen: sizeError })
  const second = await sendPayouts([models.store.get(p.id)], { models, wallet: secondWallet })
  expect(second).toMatchObject({ sent: 0, skipped: 1, failed: 0 })
  expect(secondWallet.sweepCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(2) // no replacement cycle
})

test('nested bisection with K>1 initial chunks uses at most the exact 2P-K planned-call bound', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 100_000_000_000n },
    sizeErrorWhen: () => true
  })
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 20, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls.map(req => req.destinations.length).slice(0, 2)).toEqual([15, 8])
  expect(wallet.calls).toHaveLength(2 * rows.length - 2) // K=2: 2P-K (all singleton rejects)
  expect(consolidationsOf(models)).toHaveLength(1) // targeted recovery is a separate bounded cycle
})

test('a generic retryable multi-chunk halt keeps legacy consolidation recovery', async () => {
  const rows = Array.from({ length: 35 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({ unlockedByAccount: { 1: 100_000_000_000n } })
  const createTx = wallet.createTx.bind(wallet)
  const buildAttempts = []
  wallet.createTx = async req => {
    buildAttempts.push(req.destinations.length)
    if (buildAttempts.length === 2) throw new Error('tx not possible') // second of [15, 15, 5]
    return createTx(req)
  }
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 15, failed: 0, skipped: 20, unpersisted: 0, accountingUnpersisted: 0 })
  expect(buildAttempts).toEqual([15, 15]) // the third chunk is never attempted
  expect(wallet.calls.map(req => req.destinations.length)).toEqual([15]) // the failed build recorded no tx
  expect(wallet.sweepCalls).toEqual([
    { accountIndex: 1, address: REWARDS_ADDRESS, relay: false } // legacy recovery, default shape
  ])
  expect(consolidationsOf(models)).toHaveLength(1)
})

test('a generic failure on another source cannot bypass an exhausted size-recovery budget', async () => {
  const fragmented = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const retryable = makePayout({ id: 2, distributionId: 7, piconeros: 2_000_000_000n })
  const models = seedConsolidationHistory(makeFakeModels([fragmented, retryable]), {
    accountIndex: 1, distributionId: 7, state: 'RELAYED'
  })
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 5_000_000_000n, 3: 2_000_000_000n },
    throwsOnAccount: { 3: new Error('tx not possible') },
    sizeErrorWhen: req => req.destinations.some(d => d.address === fragmented.recipientAddress)
  })
  const result = await sendPayouts([fragmented, retryable], { models, wallet })
  expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 2 })
  expect(wallet.sweepCalls).toEqual([
    { accountIndex: 3, address: REWARDS_ADDRESS, relay: false }
  ])
  const rows = consolidationsOf(models)
  expect(rows).toHaveLength(2) // the seeded exhausted cycle + generic account-3 recovery
  expect(rows.filter(r => r.accountIndex === 1)).toHaveLength(1)
  expect(rows.filter(r => r.accountIndex === 3 && r.state === 'RELAYED')).toHaveLength(1)
})

test('a restart with an authentic PREPARED recovery and a generic error never sweeps the reserved source', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const reserved = await prepareUnattemptedConsolidation(models, { accountIndex: 1, distributionId: 7 })
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    throwsOnAccount: { 1: new Error('tx not possible') }
  })
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(wallet.relayCalls).toHaveLength(0)
  expect(wallet.sweepCalls).toHaveLength(0) // legacy recovery never spends the reserved source
  expect(consolidationsOf(models)).toEqual([reserved]) // retained, never deleted or rewritten
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  const refusal = legacyRecoveryAlert('reserved')
  expect(refusal[0]).toBe('critical')
  expect(String(refusal[2])).toContain('source account 1')
  expect(String(refusal[2])).toContain('distribution 7')
  expectUncertainRecoveryInstructions(refusal, { accountIndex: 1, distributionId: 7 })
})

test('a restart with a RELAYED linked cycle and a generic error never burns another recovery fee', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = seedConsolidationHistory(makeFakeModels([p]), {
    accountIndex: 1, distributionId: 7, state: 'RELAYED'
  })
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    throwsOnAccount: { 1: new Error('tx not possible') }
  })
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.relayCalls).toHaveLength(0)
  expect(wallet.sweepCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(1)
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  const refusal = legacyRecoveryAlert('exhausted')
  expect(refusal[0]).toBe('warn')
  expect(String(refusal[2])).toContain('distribution 7')
  expect(String(refusal[2])).toContain('source account 1')
})

test('a planner omission never consolidates protected funds into a fee-burning no-op', async () => {
  // No singleton size failure this drive: 12e9 is simply too large for any
  // account. Account 1's 10e9 is protected by a PREPARED recovery, so it must
  // not be counted as recovery capacity that would authorize sweeping account
  // 3's 6e9 for a payout that still cannot be funded.
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 12_000_000_000n })
  const models = makeFakeModels([p])
  await prepareUnattemptedConsolidation(models, { accountIndex: 1, distributionId: 7 })
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 1_000_000_000n, 1: 10_000_000_000n, 3: 6_000_000_000n }
  })
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(wallet.relayCalls).toHaveLength(0)
  expect(wallet.sweepCalls).toHaveLength(0) // protected funds cannot authorize fees
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  expect(consolidationsOf(models)).toHaveLength(1)
  expect(legacyRecoveryAlert('reserved')[0]).toBe('critical')
})

test('a planner omission with protected funds still recovers from an independent healthy source', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 7_000_000_000n })
  const models = makeFakeModels([p])
  await prepareUnattemptedConsolidation(models, { accountIndex: 1, distributionId: 6 })
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 3_000_000_000n, 1: 3_000_000_000n, 3: 6_000_000_000n }
  })
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(wallet.sweepCalls).toEqual([
    { accountIndex: 3, address: REWARDS_ADDRESS, relay: false } // legacy recovery, default shape
  ])
  const rows = consolidationsOf(models)
  expect(rows).toHaveLength(2) // the reservation + the healthy source's new cycle
  expect(rows.find(row => row.accountIndex === 1)).toMatchObject({ state: 'PREPARED', relayAttemptedAt: null })
  expect(rows.find(row => row.accountIndex === 3)).toMatchObject({ state: 'RELAYED', distributionId: null })
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
})

test('an unreadable legacy recovery history fails closed without sweeping any source', async () => {
  const p = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const findMany = models.rewardsWalletTransaction.findMany.bind(models.rewardsWalletTransaction)
  models.rewardsWalletTransaction.findMany = async args => {
    if (args?.where?.kind === 'CONSOLIDATION' && args.where.accountIndex === 1) {
      throw new Error('source history unavailable')
    }
    return findMany(args)
  }
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 20_000_000_000n },
    throwsOnAccount: { 1: new Error('tx not possible') }
  })
  logError.mockClear()
  alert.mockClear()
  const result = await sendPayouts([p], { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(wallet.relayCalls).toHaveLength(0)
  expect(wallet.sweepCalls).toHaveLength(0)
  expect(consolidationsOf(models)).toHaveLength(0)
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  const failureLog = logError.mock.calls.find(([fields]) =>
    fields?.reason === 'legacy-recovery' && fields?.stage === 'history-unavailable')
  expect(failureLog[0]).toMatchObject({ accountIndex: 1, errorClass: 'unknown' })
  expect(JSON.stringify(logError.mock.calls)).not.toContain('source history unavailable')
  expect(legacyRecoveryAlert('history-unavailable')[0]).toBe('critical')
})

test.each(['throws', 'empty'])('a failed targeted sweep (%s) is not retried by legacy recovery in the same drive', async outcome => {
  const fragmented = makePayout({ id: 1, distributionId: 7, piconeros: 5_000_000_000n })
  const retryable = makePayout({ id: 2, distributionId: 7, piconeros: 2_000_000_000n })
  const models = makeFakeModels([fragmented, retryable])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 5_000_000_000n, 3: 2_000_000_000n },
    throwsOnAccount: { 3: new Error('tx not possible') },
    sizeErrorWhen: req => req.destinations.some(d => d.address === fragmented.recipientAddress)
  })
  const sweepUnlocked = wallet.sweepUnlocked.bind(wallet)
  const sweepAttempts = []
  wallet.sweepUnlocked = async args => {
    sweepAttempts.push(args.accountIndex)
    if (args.accountIndex === 1) {
      if (outcome === 'throws') throw new Error('targeted sweep unavailable')
      return []
    }
    return sweepUnlocked(args)
  }
  const result = await sendPayouts([fragmented, retryable], { models, wallet })
  expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 2, accountingUnpersisted: 0 })
  expect(sweepAttempts).toEqual([1, 3]) // legacy never repeats the source this drive
  const rows = consolidationsOf(models)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ accountIndex: 3, state: 'RELAYED' })
  expect([...models.store.values()].every(row => row.state === 'QUEUED')).toBe(true)
})

test('an uncertain chunk and a singleton size failure on the same source never consolidate', async () => {
  const rows = Array.from({ length: 16 }, (_, i) => makePayout({ id: i + 1 }))
  const special = rows[0]
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 1: 100_000_000_000n },
    sizeErrorWhen: req => req.destinations.some(d => d.address === special.recipientAddress)
  })
  const originalRelay = wallet.relayTx.bind(wallet)
  wallet.relayTx = async tx => {
    await originalRelay(tx)
    throw new Error('timeout after submission') // first successful chunk is uncertain
  }
  alert.mockClear()
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 16, accountingUnpersisted: 1 })
  expect(wallet.sweepCalls).toHaveLength(0) // neither targeted nor legacy recovery
  expect(consolidationsOf(models)).toHaveLength(0)
  expect([...models.store.values()].every(p => p.state === 'QUEUED')).toBe(true)
  const uncertainAlert = alert.mock.calls.find(call => String(call[1]).includes('account-uncertain'))
  expect(uncertainAlert[1]).toContain('rewards fragmented-inputs recovery account-uncertain')
  expectUncertainRecoveryInstructions(uncertainAlert, { accountIndex: 1, distributionId: 1 })
})

test('an unknown relay halts the account after its first chunk and leaves every row queued', async () => {
  const rows = Array.from({ length: 18 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({ unlockedByAccount: { 1: 100_000_000_000n } })
  const originalRelay = wallet.relayTx.bind(wallet)
  wallet.relayTx = async tx => {
    await originalRelay(tx)
    throw new Error('timeout after submission')
  }
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 18, unpersisted: 0, accountingUnpersisted: 1 })
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0].destinations).toHaveLength(15)
  expect(wallet.relayCalls).toHaveLength(1)
  expect(wallet.sweepCalls).toHaveLength(0)
  expect([...models.store.values()].every(p => p.state === 'QUEUED' && p.txHash === null)).toBe(true)
})

test('an unresolved prepare halts the account without building its later chunk', async () => {
  const rows = Array.from({ length: 18 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows, { failJournalCreate: 99 })
  const wallet = makeFakeWallet({ unlockedByAccount: { 1: 100_000_000_000n } })
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 18, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0].destinations).toHaveLength(15)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.journal.rows.size).toBe(0)
})

test('a principal persistence failure withholds the next chunk and keeps proven rows counted', async () => {
  const rows = Array.from({ length: 18 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows)
  const update = models.rewardPayout.update.bind(models.rewardPayout)
  models.rewardPayout.update = async ({ where, data }) => {
    if (data?.state === 'SENT') throw new Error('db down')
    return update({ where, data })
  }
  const wallet = makeFakeWallet({ unlockedByAccount: { 1: 100_000_000_000n } })
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 15, failed: 0, skipped: 3, unpersisted: 15, accountingUnpersisted: 0 })
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0].destinations).toHaveLength(15)
  expect(wallet.relayCalls).toHaveLength(1)
  expect([...models.journal.rows.values()].filter(r => r.kind === 'PAYOUT')).toHaveLength(1)
  expect(rows.slice(15).every(p => models.store.get(p.id).state === 'QUEUED')).toBe(true)
})

test('an uncertain chunk on one account preserves another account progress without duplication', async () => {
  const big = makePayout({ id: 1, piconeros: 30_000_000_000n })
  const small = Array.from({ length: 18 }, (_, i) => makePayout({ id: i + 2 }))
  const rows = [big, ...small]
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 31_000_000_000n, 1: 20_000_000_000n } })
  const originalRelay = wallet.relayTx.bind(wallet)
  wallet.relayTx = async tx => {
    const hash = await originalRelay(tx)
    if (wallet.relayCalls.length === 2) throw new Error('acknowledgement lost')
    return hash
  }
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 1, failed: 0, skipped: 18, unpersisted: 0, accountingUnpersisted: 1 })
  expect(wallet.calls.map(c => c.destinations.length)).toEqual([1, 15])
  expect(wallet.relayCalls).toHaveLength(2)
  expect(models.store.get(big.id).state).toBe('SENT')
  expect(small.every(p => models.store.get(p.id).state === 'QUEUED')).toBe(true)
  expect([...models.journal.rows.values()].filter(r => r.kind === 'PAYOUT')).toHaveLength(2)
})

test('all-singleton size rejection stays bounded and leaves every payout queued', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({ sizeErrorWhen: () => true })
  logInfo.mockClear()
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 0, failed: 0, skipped: 8, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls).toHaveLength(2 * rows.length - 1)
  expect(wallet.relayCalls).toHaveLength(1) // only the targeted consolidation relay
  expect([...models.journal.rows.values()].filter(r => r.kind === 'PAYOUT')).toHaveLength(0)
  expect([...models.journal.rows.values()].filter(r => r.kind === 'CONSOLIDATION')).toHaveLength(1)
  const fragmentLog = logInfo.mock.calls.find(([fields]) => fields?.reason === 'fragmented-payout')
  expect(fragmentLog[0].groups).toEqual([
    { accountIndex: 0, payoutIds: rows.map(p => p.id), piconeros: '8000000000' }
  ])
})

test('a rerun after a partial success only gives fresh hashes to rows still queued', async () => {
  const rows = Array.from({ length: 16 }, (_, i) => makePayout({ id: i + 1 }))
  const models = makeFakeModels(rows)
  const firstWallet = makeFakeWallet({
    unlockedByAccount: { 1: 16_000_000_000n },
    fee: 1_000_000_000n
  })
  const first = await sendPayouts(rows, { models, wallet: firstWallet })
  expect(first).toMatchObject({ sent: 15, skipped: 1 })
  const firstHash = models.store.get(1).txHash
  const firstJournal = [...models.journal.rows.values()].find(r => r.kind === 'PAYOUT')
  const secondWallet = makeFakeWallet({
    unlockedByAccount: { 1: 2_000_000_000n },
    fee: 1_000_000_000n
  })
  const second = await sendPayouts([...models.store.values()].map(p => ({ ...p })), {
    models,
    wallet: secondWallet
  })
  expect(second).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(models.store.get(1).txHash).toBe(firstHash)
  expect(models.store.get(16)).toMatchObject({ state: 'SENT' })
  expect(models.store.get(16).txHash).not.toBe(firstHash)
  expect(firstJournal.metadata.payouts.map(p => p.payoutId)).toEqual(rows.slice(0, 15).map(p => p.id))
  expect([...models.journal.rows.values()].filter(r => r.kind === 'PAYOUT')).toHaveLength(2)
})

test('a fresh unlocked source-0 wallet resumes remaining QUEUED rows after a linked consolidation without a second sweep or resending SENT chunks', async () => {
  const sentA = makePayout({
    id: 1, distributionId: 7, piconeros: 2_000_000_000n, state: 'SENT', txHash: '11'.repeat(32)
  })
  const sentB = makePayout({
    id: 2, distributionId: 7, piconeros: 2_000_000_000n, state: 'SENT', txHash: '22'.repeat(32)
  })
  const queuedA = makePayout({ id: 3, distributionId: 7, piconeros: 2_000_000_000n })
  const queuedB = makePayout({ id: 4, distributionId: 7, piconeros: 1_000_000_000n })
  const models = seedConsolidationHistory(makeFakeModels([sentA, sentB, queuedA, queuedB]), {
    id: 901, accountIndex: 0, distributionId: 7, state: 'RELAYED'
  })
  const prior = { ...consolidationsOf(models)[0] }
  expect(prior).toMatchObject({
    state: 'RELAYED', accountIndex: 0, distributionId: 7, principalPiconeros: 0n
  })

  // The recovery outputs from that linked consolidation have now unlocked on
  // primary account 0. The size predicate still exists but permits this
  // ordinary two-row resume chunk, so no new fragmentation is reported.
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 20_000_000_000n },
    sizeErrorWhen: req => req.destinations.length > 2
  })
  const summary = await sendPayouts(
    [...models.store.values()].map(p => ({ ...p })),
    { models, wallet }
  )

  expect(summary).toEqual({ sent: 2, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls).toHaveLength(1)
  expect(wallet.calls[0].destinations.map(d => d.address).sort()).toEqual(
    [queuedA.recipientAddress, queuedB.recipientAddress].sort()
  )
  expect(wallet.relayCalls).toHaveLength(1)
  expect(wallet.sweepCalls).toHaveLength(0) // the linked cycle is not repeated
  expect(consolidationsOf(models)).toHaveLength(1)
  expect(consolidationsOf(models)[0]).toMatchObject({
    id: prior.id,
    state: 'RELAYED',
    txHash: prior.txHash,
    proofId: prior.proofId,
    accountIndex: 0,
    distributionId: 7
  })

  // Earlier chunks keep their exact hashes; only the resumed rows get the new one.
  expect(models.store.get(sentA.id)).toMatchObject({ state: 'SENT', txHash: sentA.txHash })
  expect(models.store.get(sentB.id)).toMatchObject({ state: 'SENT', txHash: sentB.txHash })
  expect(models.store.get(queuedA.id).state).toBe('SENT')
  expect(models.store.get(queuedB.id).state).toBe('SENT')
  expect(models.store.get(queuedA.id).txHash).toBe(models.store.get(queuedB.id).txHash)
  expect(models.store.get(queuedA.id).txHash).not.toBe(sentA.txHash)
  expect(models.store.get(queuedA.id).txHash).not.toBe(sentB.txHash)
  expect([...models.journal.rows.values()].filter(r => r.kind === 'PAYOUT')).toHaveLength(1)
})

test('a multi-row size split excludes fee-dropped rows from child membership', async () => {
  const a = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const b = makePayout({ id: 2, piconeros: 4_000_000_000n })
  const c = makePayout({ id: 3, piconeros: 3_000_000_000n })
  const models = makeFakeModels([a, b, c])
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 12_000_000_000n },
    fee: 2_000_000_000n,
    sizeErrorWhen: req => req.destinations.length === 2
  })
  const result = await sendPayouts([a, b, c], { models, wallet })
  expect(result).toEqual({ sent: 1, failed: 0, skipped: 2, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls.map(req => req.destinations.length)).toEqual([3, 2, 1, 1])
  const droppedBuilds = wallet.calls.filter(req =>
    req.destinations.some(d => d.address === c.recipientAddress))
  expect(droppedBuilds).toHaveLength(1)
  expect(models.store.get(a.id).state).toBe('SENT')
  expect(models.store.get(b.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  expect(models.store.get(c.id)).toMatchObject({ state: 'QUEUED', txHash: null })
})

test('phase-3 fills stop at the member cap and never build an oversized transaction', async () => {
  const planned = Array.from({ length: 15 }, (_, i) => makePayout({ id: i + 1, piconeros: 4_000_000_000n }))
  const fills = Array.from({ length: 3 }, (_, i) => makePayout({ id: i + 16, piconeros: 1_000_000_000n }))
  const rows = [...planned, ...fills]
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 60_000_000_000n },
    fee: 1_000_000_000n
  })
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 15, failed: 0, skipped: 3, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls.map(req => req.destinations.length)).toEqual([15, 14, 15])
  expect(wallet.relayCalls).toHaveLength(1)
  expect(models.store.get(16).state).toBe('SENT')
  expect(models.store.get(17).state).toBe('QUEUED')
  expect(models.store.get(18).state).toBe('QUEUED')
})

test('fills never displace a later planned chunk member', async () => {
  const planned = Array.from({ length: 15 }, (_, i) => makePayout({ id: i + 1, piconeros: 1_000_000_000n }))
  const tail = makePayout({ id: 16, piconeros: 200_000_000n })
  const fills = Array.from({ length: 2 }, (_, i) => makePayout({ id: i + 17, piconeros: 300_000_000n }))
  const rows = [...planned, tail, ...fills]
  const models = makeFakeModels(rows)
  const wallet = makeFakeWallet({
    unlockedByAccount: { 0: 15_200_000_000n },
    fee: 400_000_000n
  })
  const result = await sendPayouts(rows, { models, wallet })
  expect(result).toEqual({ sent: 15, failed: 0, skipped: 3, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls.map(req => req.destinations.length)).toEqual([15, 14, 1])
  expect(models.store.get(16).state).toBe('SENT')
  expect(models.store.get(17)).toMatchObject({ state: 'QUEUED', txHash: null })
  expect(models.store.get(18)).toMatchObject({ state: 'QUEUED', txHash: null })
})

test('a persistently failing pair preparation withholds the dispatch and leaves the payout QUEUED', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5JOURNALFAIL', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p], { failJournalCreate: 99 })
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.calls).toHaveLength(1) // the tx was built...
  expect(wallet.relayCalls).toHaveLength(0) // ...but never relayed without a durable pair
  expect(models.journal.rows.size).toBe(0)
  expect(models.store.get(p.id).state).toBe('QUEUED')
  expect(models.store.get(p.id).txHash).toBeNull()
})

test('a transient journal-create blip resolves through the fresh pair read and relays exactly once', async () => {
  // The FIRST preparation attempt fails before the pair lands; the caller's
  // mandated fresh DB/pair read re-prepares idempotently and only an
  // acknowledged authentic pair releases the relay.
  const p = makePayout({ id: 1, recipientAddress: '5JOURNALBLIP', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p], { failJournalCreate: 1 })
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
  expect(wallet.relayCalls).toHaveLength(1)
  expect(models.journal.rows.size).toBe(1)
  expect(models.store.get(p.id)).toMatchObject({ state: 'SENT', txHash: models.store.get(p.id).txHash })
})

test('an unreadable journal is fail-closed: no fresh build and no relay', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5JOURNALREAD', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p], { failJournalRead: 1 })
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(models.store.get(p.id).state).toBe('QUEUED')
})

test('a relay proven while the journal RELAYED state persist fails still records the recipients and reports accountingUnpersisted', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5JOURNALPERSIST', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p], { failRelayedPersist: 2 })
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 1 })
  expect(models.store.get(p.id).state).toBe('SENT') // proven principal is persisted regardless
  expect(wallet.relayCalls).toHaveLength(1)
  const row = [...models.journal.rows.values()][0]
  expect(row.state).toBe('PREPARED') // the fee fact stays retained uncertainty until reconciliation recovers it
  expect(row.relayAttemptedAt).not.toBeNull()
})

test('an uncertain relay is excluded from a re-drive until exact-hash history resolves it — never blind re-relayed', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5UNCERTAIN', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  const relay = wallet.relayTx
  let relayAttempts = 0
  wallet.relayTx = async () => { relayAttempts += 1; throw new Error('timeout after submission') }
  const first = await sendPayouts([p], { models, wallet })
  expect(first).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(models.store.get(p.id).state).toBe('QUEUED') // never FAILED after a possible relay
  expect(relayAttempts).toBe(1)

  wallet.relayTx = relay // the transport recovers, but the journal attempt stays unresolved
  const second = await sendPayouts([models.store.get(p.id)], { models, wallet })
  expect(second).toMatchObject({ sent: 0, skipped: 1, failed: 0, accountingUnpersisted: 1 })
  expect(wallet.calls).toHaveLength(1) // no fresh build for the unresolved payout
  expect(relayAttempts).toBe(1) // still exactly one relay attempt — no blind re-relay
})

test('a durable-but-unattempted pair reserves its payout from rebuilding until operator teardown', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5RESERVED', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p])
  // A captured pair from an interrupted prepare→claim window: complete, never
  // attempted, its payout still QUEUED.
  models.journal.rows.set(1, {
    id: 1,
    network: String(process.env.MONERO_NETWORK || 'stagenet').toUpperCase(),
    walletAddress: REWARDS_ADDRESS,
    txHash: 'd7'.repeat(32),
    kind: 'PAYOUT',
    state: 'PREPARED',
    accountIndex: 0,
    distributionId: p.distributionId,
    principalPiconeros: p.piconeros,
    networkFeePiconeros: 1_000_000n,
    dispatchId: '00000000-0000-4000-8000-0000000000f1',
    captureContractVersion: 1,
    claimDigest: 'aa'.repeat(32),
    paymentClaims: {},
    proofId: '00000000-0000-4000-8000-0000000000f2',
    metadata: { payouts: [{ payoutId: p.id, recipientAddress: p.recipientAddress, piconeros: p.piconeros.toString() }] },
    relayAttemptedAt: null,
    relayedAt: null
  })
  logError.mockClear()
  const first = await sendPayouts([p], { models, wallet: makeFakeWallet({ unlockedByAccount: { 0: 100_000_000_000n } }) })
  expect(first).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  expect([...models.journal.rows.values()]).toHaveLength(1) // no new journal row
  expect(logError.mock.calls.some(args => String(args[1]).includes('durable-but-unattempted'))).toBe(true)
  expect(alert).toHaveBeenCalledWith('critical', 'Rewards wallet pair reserved (durable but unattempted)',
    expect.stringContaining('d7'.repeat(32)), expect.objectContaining({ dedupeKey: `rewards-pair-unattempted-${'d7'.repeat(32)}` }))

  // Operator-style verified teardown of the stale pair: the reservation lifts.
  models.journal.rows.delete(1)
  alert.mockClear()
  const second = await sendPayouts([models.store.get(p.id)], { models, wallet: makeFakeWallet({ unlockedByAccount: { 0: 100_000_000_000n } }) })
  expect(second).toMatchObject({ sent: 1, skipped: 0, failed: 0 })
  expect(models.store.get(p.id).state).toBe('SENT')
  expect(models.store.get(p.id).txHash).not.toBe('d7'.repeat(32)) // rebuilt under a NEW hash
  expect(models.journal.rows.size).toBe(1) // exactly the fresh pair
  // No new reservation alert after the operator resolution.
  expect(alert.mock.calls.some(call => String(call[3]?.dedupeKey ?? '').startsWith('rewards-pair-unattempted-'))).toBe(false)
})

test('a normal drive never trips the durable-but-unattempted reservation alert', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5NORMALDRIVE', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 100_000_000_000n } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toMatchObject({ sent: 1, failed: 0, skipped: 0, accountingUnpersisted: 0 })
  const row = [...models.journal.rows.values()][0]
  expect(row.state).toBe('RELAYED')
  expect(row.relayProvenance).toBe('direct-relay-observation')
  expect(alert.mock.calls.some(call => String(call[3]?.dedupeKey ?? '').startsWith('rewards-pair-unattempted-'))).toBe(false)
})

test('a journal-uncertain payout is never resolved by an address/amount history match (exact hash only)', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5HASHONLY', piconeros: 2_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  wallet.relayTx = async () => { throw new Error('timeout after submission') }
  await sendPayouts([p], { models, wallet })
  expect(models.store.get(p.id).state).toBe('QUEUED')

  // A DIFFERENT outgoing tx with the same address+amount (not the journaled
  // hash): the older address/amount reconciliation would have flipped the row
  // SENT, but only the journal's exact-hash rule may resolve an attempt.
  const otherWallet = makeFakeWallet({
    unlockedByAccount: { 0: 10_000_000_000n },
    outgoing: [makeOutgoing('ee'.repeat(32), payoutAddress('5SOMEOTHER'), 2_000_000_000n)]
  })
  const second = await sendPayouts([models.store.get(p.id)], { models, wallet: otherWallet })
  expect(second).toMatchObject({ sent: 0, skipped: 1, failed: 0, accountingUnpersisted: 1 })
  expect(models.store.get(p.id).state).toBe('QUEUED')
  expect(models.store.get(p.id).txHash).toBeNull()
  expect(otherWallet.calls).toHaveLength(0)
  expect(otherWallet.relayCalls).toHaveLength(0)
})

test('a consolidation relayed but not journaled surfaces accountingUnpersisted — never a silent COMPLETE', async () => {
  const p = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p], { failRelayedPersist: 2 })
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 4_000_000_000n, 3: 4_000_000_000n } })
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toMatchObject({ sent: 0, skipped: 1, failed: 0, accountingUnpersisted: 1 })
  expect(wallet.sweepCalls).toHaveLength(1)
  expect(wallet.relayCalls).toHaveLength(1) // the consolidation DID relay on-chain
})

test('consolidation refuses duplicate sweep hashes across accounts (one hash is one fee fact)', async () => {
  const p = makePayout({ id: 1, piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 4_000_000_000n, 1: 2_000_000_000n, 3: 2_000_000_000n } })
  // The wallet reports the SAME hash for both funded fee accounts: journaling
  // one hash as two different sweeps must be refused, so the duplicate account
  // is skipped (the prepare conflict alone is not the primary guard).
  const hash = 'dd'.repeat(32)
  logError.mockClear()
  wallet.sweepUnlocked = async ({ accountIndex, address, relay }) => {
    wallet.sweepCalls.push({ accountIndex, address, relay })
    return [{
      getHash: () => hash,
      getFee: async () => 0n,
      getOutgoingTransfer: () => ({ getDestinations: () => [{ getAddress: () => address, getAmount: () => 2_000_000_000n }] }),
      getChangeAddress: () => null,
      // Unavailable change is explicit null and pairs with a null address (C1).
      getChangeAmount: async () => null,
      // The SDK captures the SECRET-bundle STRING (final-review C1).
      getKey: () => secretBundleHex(300n, 1)
    }]
  }
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toMatchObject({ sent: 0, skipped: 1, failed: 0, accountingUnpersisted: 0 })
  expect(wallet.sweepCalls.map(c => c.accountIndex)).toEqual([1, 3])
  expect(wallet.relayCalls).toHaveLength(1) // only the first sweep relayed
  expect([...models.journal.rows.values()].filter(r => r.kind === 'CONSOLIDATION')).toHaveLength(1)
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ accountIndex: 3, reason: 'oversized-payout' }),
    expect.stringContaining('duplicate/invalid transaction hashes'))
})

// Final-review Critical regression: a durable RELAYED payout journal entry must
// stop a still-QUEUED member from being built and relayed a second time even
// when the wallet-history read throws or returns nothing. The journal is the
// durable proof of payment; a history outage must never erase it.
const seedRelayedPayoutJournal = (models, payout, { txHash, memberAmount = null, state = 'RELAYED' }) => {
  models.journal.rows.set(1, {
    id: 1,
    network: String(process.env.MONERO_NETWORK || 'stagenet').toUpperCase(),
    walletAddress: REWARDS_ADDRESS,
    txHash,
    kind: 'PAYOUT',
    state,
    accountIndex: 0,
    distributionId: payout.distributionId,
    principalPiconeros: memberAmount ?? payout.piconeros,
    networkFeePiconeros: 1_000_000n,
    metadata: {
      payouts: [{
        payoutId: payout.id,
        recipientAddress: payout.recipientAddress,
        piconeros: (memberAmount ?? payout.piconeros).toString()
      }]
    },
    relayAttemptedAt: new Date(),
    relayedAt: state === 'RELAYED' ? new Date() : null
  })
  return models
}

test('a durable RELAYED payout proof prevents a duplicate relay through a history outage', async () => {
  const journalHash = 'de'.repeat(32)
  for (const history of [
    async () => { throw new Error('history read down') },
    async () => []
  ]) {
    const p = makePayout({ id: 1, recipientAddress: '5DURABLE', piconeros: 6_000_000_000n })
    const models = seedRelayedPayoutJournal(makeFakeModels([p]), p, { txHash: journalHash })
    const wallet = makeFakeWallet({ unlockedByAccount: { 0: 100_000_000_000n } })
    wallet.getOutgoingTransfers = history
    const summary = await sendPayouts([models.store.get(p.id)], { models, wallet })
    expect(summary).toMatchObject({ sent: 1, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 })
    expect(models.store.get(p.id)).toMatchObject({ state: 'SENT', txHash: journalHash })
    expect(wallet.calls).toHaveLength(0) // no fresh build for proven money
    expect(wallet.relayCalls).toHaveLength(0) // never relayed again
  }
})

test.each(['throwing', 'empty'])('an attempted relay no fresh verification can resolve stays excluded through a %s history outage', async outage => {
  // First drive: the relay times out after the claim — the journal row stays
  // PREPARED+attempted and the recipient stays QUEUED (never FAILED).
  const p = makePayout({ id: 1, recipientAddress: '5PROMOTED', piconeros: 6_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 100_000_000_000n } })
  const relay = wallet.relayTx
  let relayAttempts = 0
  wallet.relayTx = async () => { relayAttempts += 1; throw new Error('timeout after submission') }
  const first = await sendPayouts([p], { models, wallet })
  expect(first).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 1 })
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  const attempted = [...models.journal.rows.values()][0]
  expect(attempted.state).toBe('PREPARED')
  expect(attempted.relayAttemptedAt).not.toBeNull()

  // Second drive: this unit suite has no audit session (fresh verification
  // unavailable by construction), so the attempt stays unresolved — the
  // member is excluded from every fresh send and nothing is re-relayed,
  // whatever the wallet history reads (or fails to) return.
  wallet.relayTx = relay
  wallet.getOutgoingTransfers = outage === 'throwing'
    ? async () => { throw new Error('history unavailable') }
    : async () => []
  const next = await sendPayouts([models.store.get(p.id)], { models, wallet })
  expect(next).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 1 })
  expect(wallet.calls).toHaveLength(1) // no fresh build since the first drive
  expect(relayAttempts).toBe(1) // still exactly one relay attempt — no blind re-relay
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
})

test.each(['recipient', 'amount', 'hash'])('a recovery-time %s change stays uncertain and cannot reach a fresh send', async change => {
  const p = makePayout({ id: 1, recipientAddress: '5RACERECOVERY', piconeros: 6_000_000_000n })
  const models = seedRelayedPayoutJournal(makeFakeModels([p]), p, { txHash: 'd2'.repeat(32) })
  const changed = change === 'recipient'
    ? { recipientAddress: '5CHANGED' }
    : change === 'amount' ? { piconeros: p.piconeros + 1n } : { txHash: 'd3'.repeat(32) }
  const updateMany = models.rewardPayout.updateMany.bind(models.rewardPayout)
  models.rewardPayout.updateMany = async args => {
    Object.assign(models.store.get(p.id), changed)
    return updateMany(args)
  }
  const wallet = makeFakeWallet()
  wallet.getOutgoingTransfers = async () => []
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toMatchObject({ sent: 0, skipped: 1, accountingUnpersisted: 1 })
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null, ...changed })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
})

test('a durable RELAYED proof that disagrees with the live payout is withheld and alerted', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5MISMATCH', piconeros: 7_000_000_000n })
  const models = seedRelayedPayoutJournal(makeFakeModels([p]), p, {
    txHash: 'df'.repeat(32),
    memberAmount: p.piconeros - 1n
  })
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 100_000_000_000n } })
  logError.mockClear()
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toMatchObject({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(models.store.get(p.id)).toMatchObject({ state: 'QUEUED', txHash: null })
  expect(wallet.calls).toHaveLength(0)
  expect(wallet.relayCalls).toHaveLength(0)
  expect(logError).toHaveBeenCalledWith(
    expect.objectContaining({ payoutId: p.id, reason: 'recipient/amount identity mismatch' }),
    expect.stringContaining('durable RELAYED payout proof'))
})

// Final-review Important regression (finding 4): credential-bearing wallet
// exceptions must never reach logs or alert transport from the two new
// api/monero/rewards.js boundaries — only the fixed errorLabel diagnostic.
const SECRET_MARKERS = {
  message: 'seed absorb abandon ability',
  name: 'a'.repeat(64),
  code: 'cr_live_1a2b3c4d5e6f',
  privateSpendKey: 'f'.repeat(64),
  signedTxBlob: 'deadbeef'.repeat(8)
}
const credentialShapedError = (message = SECRET_MARKERS.message) => {
  const { message: _defaultMessage, ...markers } = SECRET_MARKERS
  return Object.assign(new Error(message), markers)
}

function expectNoCredentialLeak (calls) {
  const logged = util.inspect(calls, { depth: 8, maxStringLength: Infinity })
  expect(logged).not.toContain(SECRET_MARKERS.message)
  expect(logged).not.toContain(SECRET_MARKERS.name)
  expect(logged).not.toContain(SECRET_MARKERS.code)
  expect(logged).not.toContain(SECRET_MARKERS.privateSpendKey)
  expect(logged).not.toContain(SECRET_MARKERS.signedTxBlob)
}

test('boundary 1: a credential-shaped journal-safety exception logs only the fixed label', async () => {
  const p = makePayout({ id: 1, recipientAddress: '5SECRETJOURNAL', piconeros: 1_000_000_000n })
  const models = makeFakeModels([p])
  models.journal.findMany = async () => { throw credentialShapedError() }
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 10_000_000_000n } })
  logError.mockClear()
  logWarn.mockClear()
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1, unpersisted: 0, accountingUnpersisted: 1 })
  expect(wallet.calls).toHaveLength(0)
  const call = logError.mock.calls.find(args => String(args[1]).includes('journal safety unavailable'))
  expect(call[0]).toMatchObject({ errorClass: 'unknown' })
  expectNoCredentialLeak([call])
  expectNoCredentialLeak([...logError.mock.calls, ...logWarn.mock.calls])
})

test('boundary 2: a credential-shaped build exception logs only the fixed label and a sanitized dump', async () => {
  // Hard error path: the wallet throws credential-shaped content from createTx.
  const p = makePayout({ id: 1, recipientAddress: '5SECRETBUILD', piconeros: 1_000_000_000n })
  const hardModels = makeFakeModels([p])
  const hardWallet = makeFakeWallet({ throwsOn: { [payoutAddress('5SECRETBUILD')]: credentialShapedError() } })
  logError.mockClear()
  logWarn.mockClear()
  const hard = await sendPayouts([p], { models: hardModels, wallet: hardWallet })
  expect(hard).toMatchObject({ sent: 0, failed: 1 })
  const hardLog = logError.mock.calls.find(args => String(args[1]).includes('account batch FAILED'))
  expect(hardLog[0]).toMatchObject({ errorClass: 'unknown' })
  expectNoCredentialLeak([hardLog])
  expectNoCredentialLeak([...logError.mock.calls, ...logWarn.mock.calls])

  // Retryable path: the diagnostic dump's guarded wallet reads must not echo
  // the exception's message either.
  const retryPayout = makePayout({ id: 1, recipientAddress: '5SECRETRETRY', piconeros: 1_000_000_000n })
  const retryModels = makeFakeModels([retryPayout])
  const retryWallet = makeFakeWallet({ throwsOnAccount: { 0: credentialShapedError('tx not possible') } })
  const readUnlocked = retryWallet.getUnlockedBalance.bind(retryWallet)
  let reads = 0
  retryWallet.getUnlockedBalance = async (idx) => {
    reads += 1
    if (reads > 7) throw credentialShapedError() // six plan reads + one fresh chunk read succeed; the dump read fails
    return readUnlocked(idx)
  }
  logError.mockClear()
  logWarn.mockClear()
  const retry = await sendPayouts([retryPayout], { models: retryModels, wallet: retryWallet })
  expect(retry).toMatchObject({ sent: 0, skipped: 1 })
  const retryLog = logWarn.mock.calls.find(args => String(args[1]).includes('build failed pre-relay (retryable)'))
  expect(retryLog[0]).toMatchObject({ errorClass: 'unknown' })
  expect(JSON.stringify(retryLog[0].dump)).not.toContain(SECRET_MARKERS.message)
  expectNoCredentialLeak([retryLog])
  expectNoCredentialLeak([...logError.mock.calls, ...logWarn.mock.calls])
})

test('boundary 3: a credential-shaped transaction-size exception logs only the fixed size reason', async () => {
  const sizeMessage = 'Transaction  would   be  too  large.  Try create_txs()'
  const p = makePayout({ id: 1, recipientAddress: '5SECRETSIZE', piconeros: 5_000_000_000n })
  const models = makeFakeModels([p])
  const wallet = makeFakeWallet({ unlockedByAccount: { 0: 20_000_000_000n } })
  // The fake createTx seam must throw the ACTUAL credential-shaped error: the
  // older sizeErrorWhen predicate only returned it and the fake replaced it
  // with a plain fixed-message Error, making the no-leak assertions vacuous.
  wallet.createTx = async () => { throw credentialShapedError(sizeMessage) }
  logError.mockClear()
  logWarn.mockClear()
  const summary = await sendPayouts([p], { models, wallet })
  expect(summary).toMatchObject({ sent: 0, failed: 0, skipped: 1 })
  const sizeLog = logWarn.mock.calls.find(args => args[0]?.reason === 'transaction-size')
  expect(sizeLog[0]).toMatchObject({ accountIndex: 0, payoutCount: 1, reason: 'transaction-size' })
  expect(String(sizeLog[1])).toContain('smaller transactions')
  expectNoCredentialLeak([sizeLog])
  expectNoCredentialLeak([...logError.mock.calls, ...logWarn.mock.calls])
})
