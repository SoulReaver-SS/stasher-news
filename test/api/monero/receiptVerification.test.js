/* eslint-env jest */
import { parsePiconeros, verifyReceiptAmount, ReceiptLookupError } from '@/api/monero/receiptVerification'
import { alert } from '@/lib/alert'
import { encryptViewKey } from '@/api/monero/viewkey'
import { maskFromTxPubKey, xorWithMask } from '@/api/monero/pidDecrypt'
import ownershipFixture from './fixtures/ownership-fixture.json'

// Pin the view-key master key before the lazy master-key registry can first
// load under the container's own key: the daemon-level tests below encrypt and
// decrypt REAL view-key envelopes.
const MASTER_B64 = Buffer.from('b'.repeat(32)).toString('base64')
process.env.VIEWKEY_MASTER_KEY = MASTER_B64

// The collision path pages operators via lib/alert. Mock it at the module
// boundary (same pattern as webhook.test.js) so the alert CALL is assertable
// without a network side effect or logger noise.
jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))

describe('parsePiconeros', () => {
  test('accepts positive integer strings and numbers', () => {
    expect(parsePiconeros('1000')).toBe(1000n)
    expect(parsePiconeros(1000)).toBe(1000n)
  })

  test('rejects zero, negatives, garbage, null and undefined', () => {
    expect(parsePiconeros('0')).toBeNull()
    expect(parsePiconeros('-1')).toBeNull()
    expect(parsePiconeros('-1000')).toBeNull()
    expect(parsePiconeros('abc')).toBeNull()
    expect(parsePiconeros('1.5')).toBeNull()
    expect(parsePiconeros(null)).toBeNull()
    expect(parsePiconeros(undefined)).toBeNull()
    expect(parsePiconeros('')).toBeNull()
  })
})

const ACTIVE_ACCOUNT = {
  id: 7,
  address: 'ADDR',
  status: 'ACTIVE',
  viewKey: { ciphertext: Buffer.alloc(0) },
  lastTxId: null,
  subaddresses: []
}

function lwsWith (txs) {
  return { getAddressTxs: jest.fn().mockResolvedValue({ transactions: txs }) }
}
const MODELS = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }

describe('verifyReceiptAmount', () => {
  test('accepts when the on-chain amount and hash match (lws level, daemon reserved)', async () => {
    const monero = lwsWith([{ hash: 'deadbeef', payment_id: 'abc', piconeros: 1000n }])
    await expect(verifyReceiptAmount({ models: MODELS, monero, daemon: { reserved: true }, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: true, level: 'lws', chainHeight: null })
  })

  test('rejects on amount mismatch', async () => {
    const monero = lwsWith([{ hash: 'deadbeef', payment_id: 'abc', piconeros: 1000n }])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 999n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: false, reason: 'amount_mismatch' })
  })

  test('rejects when the callback hash matches no chain tx, even though a same-pid tx exists (hash-first anti-replay binding)', async () => {
    const monero = lwsWith([{ hash: 'aaaa', payment_id: 'abc', piconeros: 1000n }])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 1000n, txHash: 'bbbb' }))
      .resolves.toMatchObject({ ok: false, reason: 'tx_not_found' })
    expect(alert).toHaveBeenCalledWith('warn', 'payment-id collision on receipt verification',
      expect.stringContaining('abc'),
      expect.objectContaining({ dedupeKey: 'pid-collision-abc' }))
  })

  test('rejects when a named hash finds no tx and the same-pid tx carries no hash (hashless pid tx is not evidence)', async () => {
    const monero = lwsWith([{ payment_id: 'abc', piconeros: 1000n }])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: false, reason: 'tx_not_found' })
  })

  test('rejects with hash_unavailable when the pid tx has no hash and the callback names none', async () => {
    const monero = lwsWith([{ payment_id: 'abc', piconeros: 1000n }])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 1000n }))
      .resolves.toMatchObject({ ok: false, reason: 'hash_unavailable' })
  })

  test('rejects when the tx is not found', async () => {
    const monero = lwsWith([])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'missing', piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: false, reason: 'tx_not_found' })
  })

  test('throws ReceiptLookupError on lws failure', async () => {
    const monero = { getAddressTxs: jest.fn().mockRejectedValue(new Error('lws down')) }
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'abc', piconeros: 1000n, txHash: 'deadbeef' }))
      .rejects.toBeInstanceOf(ReceiptLookupError)
  })

  test('skips verification for an unscannable account (existing fail-open posture)', async () => {
    await expect(verifyReceiptAmount({ models: {}, monero: {}, account: { id: 9, status: 'INACTIVE', viewKey: null }, paymentId: 'abc', piconeros: 1n, txHash: 'x' }))
      .resolves.toMatchObject({ ok: true, skipped: true })
  })

  test('reuses a pre-fetched tx and does not call lws again', async () => {
    const monero = { getAddressTxs: jest.fn() }
    await expect(verifyReceiptAmount({
      models: {},
      monero,
      account: ACTIVE_ACCOUNT,
      paymentId: 'abc',
      piconeros: 1000n,
      txHash: 'deadbeef',
      tx: { hash: 'deadbeef', payment_id: 'abc', piconeros: 1000n }
    })).resolves.toMatchObject({ ok: true })
    expect(monero.getAddressTxs).not.toHaveBeenCalled()
  })

  test('does not advance the cursor when verifying against the rewards account (C6 downvote path)', async () => {
    const monero = lwsWith([{ id: 5, hash: 'deadbeef', payment_id: 'abc', piconeros: 1000n }])
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
    const rewards = { ...ACTIVE_ACCOUNT, label: 'platform_rewards' }
    await expect(verifyReceiptAmount({ models, monero, account: rewards, paymentId: 'abc', piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: true })
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
  })

  test('a named hash never binds to a different same-pid tx (hash-first)', async () => {
    const account = { address: 'A', status: 'ACTIVE', viewKey: {}, lastTxId: null, subaddresses: [], label: 'author', id: 1 }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
    const dust = { id: 1, hash: 'aa'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 5n }
    const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [dust], blockchain_height: 50 }) }
    const out = await verifyReceiptAmount({ models, monero, account, paymentId: 'deadbeefdeadbeef', piconeros: 5n, txHash: 'bb'.repeat(32) })
    expect(out).toEqual({ ok: false, reason: 'tx_not_found' })
    // the collision signal is surfaced as a deduped operator alert
    expect(alert).toHaveBeenCalledWith('warn', 'payment-id collision on receipt verification',
      expect.stringContaining('deadbeefdeadbeef'),
      expect.objectContaining({ dedupeKey: 'pid-collision-deadbeefdeadbeef' }))
  })

  // -------------------------------------------------------------------------
  // PID BINDING (2026-09-19 review finding): the hash-first lookup binds the
  // tx hash, but the claimed payment id must ALSO be bound to that tx — a
  // token-holding replay could otherwise re-attribute a real payment to a
  // different pending pid on the same account (duplicate tip credits, bounty
  // escrow over-commitment, wrong fee-leg flips).
  // -------------------------------------------------------------------------
  test('SECURITY: rejects when the named hash is found but carries a DIFFERENT pid than claimed (no daemon corroboration)', async () => {
    const monero = lwsWith([{ hash: 'deadbeef', payment_id: 'realpid', piconeros: 1000n }])
    await expect(verifyReceiptAmount({ models: MODELS, monero, account: ACTIVE_ACCOUNT, paymentId: 'forgedpid', piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: false, reason: 'pid_mismatch' })
  })

  test('SECURITY: rejects when the daemon candidates exclude the claim (extra decrypts to a different pid)', async () => {
    const OTHER_PID = 'ffffffffffffffff'
    const R = Buffer.from(ownershipFixture.txPubKeys[0], 'hex')
    const encPid = xorWithMask(Buffer.from(OTHER_PID, 'hex'), maskFromTxPubKey(R, ownershipFixture.viewKeyHex))
    const extra = Buffer.concat([Buffer.from([0x01]), R, Buffer.from([0x02, 0x09, 0x01]), encPid])
    const account = { id: 1, address: ownershipFixture.address, status: 'ACTIVE', viewKey: encryptViewKey(ownershipFixture.viewKeyHex), lastTxId: null, subaddresses: [] }
    const monero = lwsWith([{ hash: 'deadbeef', piconeros: 1000n }])
    const daemon = { getTransactions: jest.fn().mockResolvedValue([{ hash: 'deadbeef', extra, vout: ownershipFixture.voutKeys }]) }
    await expect(verifyReceiptAmount({ models: MODELS, monero, daemon, account, paymentId: 'forgedpid', piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: false, reason: 'pid_mismatch' })
  })

  test('defers (ReceiptLookupError) when pid corroboration cannot reach monerod — never a false reject', async () => {
    const monero = lwsWith([{ hash: 'deadbeef', payment_id: 'realpid', piconeros: 1000n }])
    const daemon = { getTransactions: jest.fn().mockRejectedValue(new Error('monerod down')) }
    await expect(verifyReceiptAmount({ models: MODELS, monero, daemon, account: ACTIVE_ACCOUNT, paymentId: 'claimedpid', piconeros: 1000n, txHash: 'deadbeef' }))
      .rejects.toBeInstanceOf(ReceiptLookupError)
  })

  test('accepts a mismatch only when the daemon recipient-side decrypt proves the claimed pid (lws misattribution false-reject protection)', async () => {
    // lws served the wrong pid (shared-scan bug documented in pidDecrypt.js);
    // the raw tx extra decrypts to the claimed pid under the recipient view key.
    const PID = 'a1b2c3d4e5f60718'
    const R = Buffer.from(ownershipFixture.txPubKeys[0], 'hex')
    const encPid = xorWithMask(Buffer.from(PID, 'hex'), maskFromTxPubKey(R, ownershipFixture.viewKeyHex))
    const extra = Buffer.concat([Buffer.from([0x01]), R, Buffer.from([0x02, 0x09, 0x01]), encPid])
    const account = { id: 1, address: ownershipFixture.address, status: 'ACTIVE', viewKey: encryptViewKey(ownershipFixture.viewKeyHex), lastTxId: null, subaddresses: [] }
    const monero = lwsWith([{ hash: 'deadbeef', payment_id: 'wrongpid', piconeros: 1000n }])
    const daemon = { getTransactions: jest.fn().mockResolvedValue([{ hash: 'deadbeef', extra, vout: ownershipFixture.voutKeys }]) }
    await expect(verifyReceiptAmount({ models: MODELS, monero, daemon, account, paymentId: PID, piconeros: 1000n, txHash: 'deadbeef' }))
      .resolves.toMatchObject({ ok: true, level: 'lws' })
  })

  // (SELF-SPEND AMOUNT tests removed 2026-09-19: the opt-in allowance was
  // reverted — self-sends on fee legs are refused outright by the webhook's
  // ban, and verification stays amount-strict for every caller. The
  // change-inflated lws total therefore rejects as a plain amount_mismatch,
  // covered by the amount tests above.)
})

// ---------------------------------------------------------------------------
// daemon level (Task 9). A monerod-fallback receipt is accepted ONLY when BOTH
// hold: the tx extra decrypts to the claimed payment id under the recipient's
// view key, AND an on-chain output is provably owned by the recipient. The
// extra below is built with the shipping pid crypto (test setup only) and the
// account envelope is really encrypted/decrypted, so the control flow runs
// against the real helpers; Task 8's regtest fixture independently pins the
// crypto to monero-core data (voutKeys/txPubKeys/keys are chain-derived).
// ---------------------------------------------------------------------------
describe('verifyReceiptAmount daemon level (monerod fallback)', () => {
  const PID = 'a1b2c3d4e5f60718'
  const RAW_HASH = 'bb'.repeat(32)
  const R = Buffer.from(ownershipFixture.txPubKeys[0], 'hex')

  let account
  let ownedExtra
  let models

  beforeAll(() => {
    // Real encrypted-pid wire format: [0x01][R][0x02][0x09][0x01][encPid].
    // encPid = pid XOR the sender-side mask 8·r·A, which commutes to the
    // recipient-side 8·a·R our decryptor recomputes.
    const encPid = xorWithMask(Buffer.from(PID, 'hex'), maskFromTxPubKey(R, ownershipFixture.viewKeyHex))
    ownedExtra = Buffer.concat([Buffer.from([0x01]), R, Buffer.from([0x02, 0x09, 0x01]), encPid])
    account = {
      id: 1,
      address: ownershipFixture.address,
      status: 'ACTIVE',
      viewKey: encryptViewKey(ownershipFixture.viewKeyHex),
      lastTxId: null,
      subaddresses: []
    }
  })

  beforeEach(() => {
    models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
  })

  // lws sees nothing for the named hash: the callback can only verify through
  // the daemon fallback.
  const lwsMiss = () => ({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 10 }) })
  const daemonWith = (txs) => ({ getTransactions: jest.fn().mockResolvedValue(txs) })

  test('accepts with pid decrypt + recipient-output ownership (level: daemon)', async () => {
    const daemon = daemonWith([{ hash: RAW_HASH, extra: ownedExtra, vout: ownershipFixture.voutKeys }])
    const out = await verifyReceiptAmount({ models, monero: lwsMiss(), daemon, account, paymentId: PID, piconeros: 1000n, txHash: RAW_HASH })
    expect(out).toEqual({ ok: true, level: 'daemon', tx: { hash: RAW_HASH, height: null } })
  })

  test('SECURITY: rejects a tx carrying the right pid that pays a foreign recipient', async () => {
    const daemon = daemonWith([{ hash: RAW_HASH, extra: ownedExtra, vout: [ownershipFixture.foreignVoutKey] }])
    await expect(verifyReceiptAmount({ models, monero: lwsMiss(), daemon, account, paymentId: PID, piconeros: 1000n, txHash: RAW_HASH }))
      .resolves.toEqual({ ok: false, reason: 'ownership_mismatch' })
  })

  test('rejects when the extra does not decrypt to the claimed pid (wrong or absent)', async () => {
    const noPidExtra = Buffer.concat([Buffer.from([0x01]), R])
    await expect(verifyReceiptAmount({ models, monero: lwsMiss(), daemon: daemonWith([{ hash: RAW_HASH, extra: ownedExtra, vout: ownershipFixture.voutKeys }]), account, paymentId: 'ffffffffffffffff', piconeros: 1000n, txHash: RAW_HASH }))
      .resolves.toEqual({ ok: false, reason: 'pid_mismatch' })
    await expect(verifyReceiptAmount({ models, monero: lwsMiss(), daemon: daemonWith([{ hash: RAW_HASH, extra: noPidExtra, vout: ownershipFixture.voutKeys }]), account, paymentId: PID, piconeros: 1000n, txHash: RAW_HASH }))
      .resolves.toEqual({ ok: false, reason: 'pid_mismatch' })
  })

  test('fails closed (tx_not_found) when the daemon call throws', async () => {
    const daemon = { getTransactions: jest.fn().mockRejectedValue(new Error('monerod down')) }
    await expect(verifyReceiptAmount({ models, monero: lwsMiss(), daemon, account, paymentId: PID, piconeros: 1000n, txHash: RAW_HASH }))
      .resolves.toEqual({ ok: false, reason: 'tx_not_found' })
  })

  test('fails closed (tx_not_found) when the daemon returns no tx for the hash', async () => {
    await expect(verifyReceiptAmount({ models, monero: lwsMiss(), daemon: daemonWith([]), account, paymentId: PID, piconeros: 1000n, txHash: RAW_HASH }))
      .resolves.toEqual({ ok: false, reason: 'tx_not_found' })
  })

  test('fails closed (tx_not_found) when the view-key envelope cannot be decrypted', async () => {
    const broken = { ...account, viewKey: { ciphertext: Buffer.alloc(0) } }
    const daemon = daemonWith([{ hash: RAW_HASH, extra: ownedExtra, vout: ownershipFixture.voutKeys }])
    await expect(verifyReceiptAmount({ models, monero: lwsMiss(), daemon, account: broken, paymentId: PID, piconeros: 1000n, txHash: RAW_HASH }))
      .resolves.toEqual({ ok: false, reason: 'tx_not_found' })
  })

  test('an unscannable account still returns skipped without consulting the daemon', async () => {
    const daemon = { getTransactions: jest.fn() }
    const out = await verifyReceiptAmount({ models: {}, monero: {}, daemon, account: { id: 9, status: 'INACTIVE', viewKey: null }, paymentId: PID, piconeros: 1n, txHash: RAW_HASH })
    expect(out).toEqual({ ok: true, skipped: true })
    expect(daemon.getTransactions).not.toHaveBeenCalled()
  })
})
