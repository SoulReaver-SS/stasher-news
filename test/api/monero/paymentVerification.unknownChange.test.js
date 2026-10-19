/* eslint-env jest */

// Non-DB regression for final-review I2: the pinned SDK can leave a built
// transaction's change address/amount unset even when the confirmed chain has
// a legitimate change output. Capture must preserve those facts as null, and
// verification may then allow ONLY the independently derived source-primary
// (minor 0) position — never a fabricated amount or an arbitrary owned output.
//
// Real paths exercised here: preparePaymentDispatch (real envelope crypto and
// in-memory pair store), collectPaymentChainEvidence (synthetic chain fixture),
// and verifyPaymentTransaction. No database, wallet, or network is touched.

import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { loadPaymentProof, preparePaymentDispatch } from '@/api/monero/paymentProofStore'
import { collectPaymentChainEvidence } from '@/api/monero/paymentChainEvidence'
import { verifyPaymentTransaction } from '@/api/monero/paymentVerification'
import { paymentChainFixture, paymentTxFixture } from '@/test/fixtures/payment-proof'

jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))
jest.mock(`${process.cwd()}/lib/logger`, () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

const OBSERVED_AT = '2026-10-06T12:00:00.000Z'
const keyProvider = createPaymentProofKeyProvider({
  TXPROOF_MASTER_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 1).toString('base64') }),
  TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
})

const SCOPE = paymentChainFixture().collectOptions.scope
const makeWallet = () => ({
  getPrimaryAddress: jest.fn(async () => SCOPE.walletAddress),
  getNetworkType: jest.fn(async () => 2),
  relayTx: jest.fn(async () => { throw new Error('verifier tests must never relay') })
})

// Minimal in-memory pair store with the exact surface preparePaymentDispatch,
// loadPaymentProof and verifyPaymentTransaction use. It is a test double, not
// a database: ids are assigned, rows are copied, and no SQL semantics are
// implied beyond the durability check the store performs.
function makeInMemoryModels () {
  const journals = new Map()
  const proofs = new Map()
  let journalSeq = 0
  const rewardsWalletTransaction = {
    async findUnique ({ where }) {
      if (where?.id !== undefined) {
        const row = journals.get(Number(where.id))
        return row ? { ...row } : null
      }
      const key = where?.network_walletAddress_txHash
      if (key) {
        for (const row of journals.values()) {
          if (row.network === key.network && row.walletAddress === key.walletAddress &&
            row.txHash === key.txHash) return { ...row }
        }
      }
      return null
    },
    async create ({ data }) {
      const id = ++journalSeq
      const row = { id, state: 'PREPARED', relayAttemptedAt: null, relayedAt: null, ...data }
      journals.set(id, row)
      return { ...row }
    }
  }
  const paymentTransactionProof = {
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
  const client = {
    rewardsWalletTransaction,
    paymentTransactionProof,
    rewardPayout: { findUnique: async () => null },
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ synchronous_commit: 'on' }]
  }
  return {
    journals,
    proofs,
    models: {
      ...client,
      $transaction: async fn => fn(client)
    }
  }
}

const rewardOwner = (overrides = {}) => {
  const fixture = paymentChainFixture()
  const members = fixture.chain.externalReceipts.map((receipt, index) => ({
    payoutId: 11 + index,
    recipientAddress: receipt.address,
    piconeros: receipt.amountPiconeros
  }))
  return {
    journalRole: 'REWARDS',
    kind: 'PAYOUT',
    accountIndex: 0,
    distributionId: null,
    principalPiconeros: members.reduce((sum, member) => sum + member.piconeros, 0n),
    metadata: { payouts: members },
    ...overrides
  }
}

// The pinned-SDK-shaped built transaction: same destinations/keys as the
// synthetic chain, but the change getters expose nothing. Capture receives
// the real SDK-shaped object; only these two getters differ from a chain that
// actually contains a change output.
function sdkUnsetChangeTx () {
  const tx = paymentTxFixture()
  tx.getChangeAddress = () => undefined
  tx.getChangeAmount = () => undefined
  return tx
}

async function capturedUnknownChange ({ chain = paymentChainFixture(), owner = rewardOwner() } = {}) {
  const store = makeInMemoryModels()
  const prepared = await preparePaymentDispatch({
    models: store.models,
    wallet: makeWallet(),
    tx: sdkUnsetChangeTx(),
    owner,
    keyProvider
  })
  const collected = await collectPaymentChainEvidence(chain.collectOptions)
  return {
    chain,
    store,
    prepared,
    session: { ...collected, checkTxKey: chain.wallet.checkTxKey }
  }
}

const verify = (fixture, overrides = {}) => verifyPaymentTransaction({
  models: fixture.store.models,
  journalRole: 'REWARDS',
  journalId: fixture.prepared.journal.id,
  session: fixture.session,
  keyProvider,
  observedAt: OBSERVED_AT,
  ...overrides
})

// Re-shape only the session's owned projection, simulating a scan that claims
// the change output at a different derived position. The raw chain facts and
// the authenticated capture are untouched.
function ownedAt (session, position) {
  const ownershipFor = session.ownershipFor
  return {
    ...session,
    ownershipFor: hash => {
      const ownership = ownershipFor(hash)
      return {
        ...ownership,
        owned: ownership.owned.map(row => ({ ...row, ...position }))
      }
    }
  }
}

test('unknown captured change recovers from the independently derived source primary without inventing facts', async () => {
  const fixture = await capturedUnknownChange()

  const loaded = await loadPaymentProof({
    models: fixture.store.models,
    journalRole: 'REWARDS',
    journalId: fixture.prepared.journal.id,
    keyProvider
  })
  expect(loaded.claims.change).toBeNull()
  expect(loaded.payload.builtStructure.changeAddress).toBeNull()
  expect(loaded.payload.builtStructure.changeAmountPiconeros).toBeNull()

  const result = await verify(fixture)
  expect(result.status).toBe('complete')
  expect(result.issues).toEqual([])
  expect(result.totals).toEqual({ D: '100', O: '33', F: '7', E: '60', residual: '0' })
  expect(result.sourceAccounts).toEqual(['0'])
  expect(result.ownedAccounting.outputs).toEqual([
    { outputIndex: 1, accountIndex: 0, subaddressIndex: 0, amountPiconeros: '33', isSpent: false }
  ])
})

test.each([
  ['wrong account', { accountIndex: 1, subaddressIndex: 0 }],
  ['non-primary minor', { accountIndex: 0, subaddressIndex: 1 }]
])('unknown captured change rejects an owned output at the %s', async (_label, position) => {
  const fixture = await capturedUnknownChange()
  const result = await verify(fixture, { session: ownedAt(fixture.session, position) })
  expect(result.status).toBe('rejected')
  expect(result.issues).toContain('OWNED_PARTITION_MISMATCH')
})

test('unknown captured change without the session position mapping stays unresolved', async () => {
  const fixture = await capturedUnknownChange()
  const result = await verify(fixture, { session: { ...fixture.session, addressForPosition: undefined } })
  expect(result.status).toBe('unresolved')
  expect(result.issues).toContain('CHAIN_EVIDENCE_INCOMPLETE')
})

test('a captured source that differs from the independently restored one never gets the unknown-change allowance', async () => {
  // Capture says account 1, but the chain's inputs independently restore
  // account 0. The captured change stays unknown; the policy must not invent
  // an account-1 allowance, and the source-set gate still rejects.
  const fixture = await capturedUnknownChange({ owner: rewardOwner({ accountIndex: 1 }) })
  const result = await verify(fixture)
  expect(result.status).toBe('rejected')
  expect(result.issues).toContain('SOURCE_ACCOUNT_MISMATCH')
})

test('a tampered raw fee still rejects unknown-change recovery', async () => {
  const chain = paymentChainFixture()
  chain.chain.audited.feePiconeros = 8n
  const fixture = await capturedUnknownChange({ chain })
  const result = await verify(fixture)
  expect(result.status).toBe('rejected')
  expect(result.issues).toContain('FEE_MISMATCH')
})

test('a non-closing owned/output residual still rejects unknown-change recovery', async () => {
  // The chain carries only 22 of the built 33 change piconeros and a hidden 11:
  // the unknown-change allowance may not absorb that residual.
  const chain = paymentChainFixture({ ownedAmount: 22n })
  const fixture = await capturedUnknownChange({ chain })
  const result = await verify(fixture)
  expect(result.status).toBe('rejected')
  expect(result.issues).toContain('UNCLAIMED_EXTERNAL_RESIDUAL')
})

test('an explicitly captured change keeps the strict captured-position checks', async () => {
  // Default fixture transaction exposes change normally; a scan claiming the
  // owned output at another position is rejected exactly as before. The
  // unknown-change policy must not apply here.
  const store = makeInMemoryModels()
  const chain = paymentChainFixture()
  const prepared = await preparePaymentDispatch({
    models: store.models,
    wallet: makeWallet(),
    tx: paymentTxFixture(),
    owner: rewardOwner(),
    keyProvider
  })
  const collected = await collectPaymentChainEvidence(chain.collectOptions)
  const fixture = {
    store,
    prepared,
    chain,
    session: { ...collected, checkTxKey: chain.wallet.checkTxKey }
  }
  const result = await verify(fixture, { session: ownedAt(fixture.session, { accountIndex: 1, subaddressIndex: 0 }) })
  expect(result.status).toBe('rejected')
  expect(result.issues).toContain('OWNED_PARTITION_MISMATCH')
})
