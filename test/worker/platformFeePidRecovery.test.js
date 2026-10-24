/* eslint-env jest */
// Raw-payment-id recovery for integrated platform fees
// (worker/platformFeePidRecovery.js), run by rewardsWalletObserver every
// minute. Uses REAL pid cryptography: each fixture's raw extra decrypts under
// the rewards view key to the issued pid while lws serves scrambled bytes (the
// payer-decrypted-first lws behavior). The receipt applier is mocked at the
// module boundary so the suite pins exactly what is booked, and when.
import { ed25519 } from '@noble/curves/ed25519'
import { recoverPlatformFeePids, __resetPlatformFeePidRecoveryForTests } from '@/worker/platformFeePidRecovery'
import { encryptViewKey } from '@/api/monero/viewkey'
import { maskFromTxPubKey, xorWithMask } from '@/api/monero/pidDecrypt'
import { applyFeeReceipt } from '../../api/monero/feeObservation'
import { alert } from '../../lib/alert'

jest.mock('../../api/monero/feeObservation', () => ({
  __esModule: true,
  applyFeeReceipt: jest.fn().mockResolvedValue({ transitioned: true, cumulative: 0n })
}))
jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))

process.env.VIEWKEY_MASTER_KEY = Buffer.alloc(32, 97).toString('base64')

const VIEW_KEY = '01' + '00'.repeat(31)
const ISSUED_PID = '8a05774bc66a6479'
const SERVED_PID = '006b21173b04781b' // payer-side garbage lws stored
const ACCOUNT = { id: 91, label: 'platform_rewards', address: 'PLATFORM', viewKey: encryptViewKey(VIEW_KEY) }
const FEE_MAP = { id: 3, paymentId: ISSUED_PID, feeType: 'POSTING', recipientAccountId: 91, recipientAddress: 'PLATFORM', amountPiconeros: 1_000_000_000n }
const PAYIN = { id: 12, payInType: 'ITEM_CREATE', moneroPaymentId: ISSUED_PID }

// raw extra that decrypts (under VIEW_KEY) to `pid`, plus the lws row
function evidence ({ hash = 'ab'.repeat(32), pid = ISSUED_PID, row = {} } = {}) {
  const pub = Buffer.from(ed25519.ExtendedPoint.BASE.multiply(2n).toRawBytes())
  const stored = xorWithMask(Buffer.from(pid, 'hex'), maskFromTxPubKey(pub, VIEW_KEY))
  return {
    raw: { hash, extra: Buffer.concat([Buffer.from([1]), pub, Buffer.from([2, 9, 1]), stored]) },
    row: { hash, payment_id: SERVED_PID, height: 500, piconeros: 1_000_000_000n, recipient: { maj_i: 0, min_i: 0 }, spent_outputs: [], ...row }
  }
}

function fixture (items, { intents = [FEE_MAP], bookedFees = [], bookedDownvotes = [] } = {}) {
  const rawReader = {
    read: jest.fn(async hashes => {
      const raws = items.filter(e => hashes.includes(e.raw.hash)).map(e => e.raw)
      return { raws, missingHashes: hashes.filter(h => !raws.some(r => r.hash === h)), stats: {} }
    })
  }
  const models = {
    feeObservation: { findMany: jest.fn(async ({ where }) => bookedFees.filter(h => where.txHash.in.includes(h)).map(txHash => ({ txHash }))) },
    observedDownvote: { findMany: jest.fn(async ({ where }) => bookedDownvotes.filter(h => where.txHash.in.includes(h)).map(txHash => ({ txHash }))) },
    subFeePidMap: { findMany: jest.fn(async ({ where }) => intents.filter(m => where.paymentId.in.includes(m.paymentId))) },
    subaddressIndex: { findMany: jest.fn().mockResolvedValue([]) },
    payIn: { findUnique: jest.fn(async ({ where }) => where.moneroPaymentId === ISSUED_PID ? PAYIN : null) }
  }
  return { rawReader, models, transactions: items.map(e => e.row) }
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetPlatformFeePidRecoveryForTests()
})

test('a wrong-pid lws row is booked by its raw-decrypted issued pid, with the lws amount and height', async () => {
  const fx = fixture([evidence()])
  const out = await recoverPlatformFeePids({ models: fx.models, account: ACCOUNT, transactions: fx.transactions, rawReader: fx.rawReader })
  expect(out.recovered).toBe(1)
  expect(applyFeeReceipt).toHaveBeenCalledWith(fx.models, {
    feeMap: FEE_MAP, feePayIn: PAYIN, txHash: 'ab'.repeat(32), piconeros: 1_000_000_000n, height: 500, confirmations: 0
  })
  expect(alert).toHaveBeenCalledWith('warn', 'platform fee payment-id misattribution recovered', expect.any(String), expect.anything())
})

test('several wrong-pid top-ups on one invoice are each booked', async () => {
  const fx = fixture([evidence({ hash: 'ab'.repeat(32), row: { piconeros: 400_000_000n } }), evidence({ hash: 'cd'.repeat(32), row: { piconeros: 600_000_000n } })])
  await recoverPlatformFeePids({ models: fx.models, account: ACCOUNT, transactions: fx.transactions, rawReader: fx.rawReader })
  expect(applyFeeReceipt.mock.calls.map(c => c[1].piconeros)).toEqual([400_000_000n, 600_000_000n])
})

test('only mined, unbooked primary-address rows are candidates', async () => {
  const items = [
    evidence({ hash: '01'.repeat(32), row: { height: null } }), // mempool
    evidence({ hash: '02'.repeat(32), row: { recipient: { maj_i: 1, min_i: 7 } } }), // fee-pool subaddress
    evidence({ hash: '03'.repeat(32) }), // already booked fee
    evidence({ hash: '04'.repeat(32) }), // already booked downvote
    evidence({ hash: '05'.repeat(32) }) // the only candidate
  ]
  const fx = fixture(items, { bookedFees: ['03'.repeat(32)], bookedDownvotes: ['04'.repeat(32)] })
  await recoverPlatformFeePids({ models: fx.models, account: ACCOUNT, transactions: fx.transactions, rawReader: fx.rawReader })
  expect(fx.rawReader.read).toHaveBeenCalledWith(['05'.repeat(32)])
  expect(applyFeeReceipt).toHaveBeenCalledTimes(1)
})

test('settled decisions are memoized: a steady-state tick reads nothing new', async () => {
  const fx = fixture([evidence(), evidence({ hash: 'ee'.repeat(32), pid: 'ffffffffffffffff' })])
  await recoverPlatformFeePids({ models: fx.models, account: ACCOUNT, transactions: fx.transactions, rawReader: fx.rawReader })
  jest.clearAllMocks()
  const out = await recoverPlatformFeePids({ models: fx.models, account: ACCOUNT, transactions: fx.transactions, rawReader: fx.rawReader })
  expect(out.candidates).toBe(0)
  expect(fx.rawReader.read).not.toHaveBeenCalled()
  expect(fx.models.feeObservation.findMany).not.toHaveBeenCalled()
  expect(applyFeeReceipt).not.toHaveBeenCalled()
})

test('missing raw evidence is retried next tick, never treated as nonpayment', async () => {
  const fx = fixture([evidence()])
  fx.rawReader.read.mockResolvedValueOnce({ raws: [], missingHashes: ['ab'.repeat(32)], stats: {} })
  await recoverPlatformFeePids({ models: fx.models, account: ACCOUNT, transactions: fx.transactions, rawReader: fx.rawReader })
  expect(applyFeeReceipt).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('warn', 'platform fee raw transaction evidence incomplete', expect.any(String), expect.anything())
  await recoverPlatformFeePids({ models: fx.models, account: ACCOUNT, transactions: fx.transactions, rawReader: fx.rawReader })
  expect(applyFeeReceipt).toHaveBeenCalledTimes(1)
})

test.each([
  ['an owner intent pid', { intents: [] }], // the query only returns platform intents
  ['an intent frozen to another account', { intents: [{ ...FEE_MAP, recipientAccountId: 92, recipientAddress: 'OTHER' }] }]
])('%s on the rewards wallet is never credited', async (_, opts) => {
  const fx = fixture([evidence()], opts)
  await recoverPlatformFeePids({ models: fx.models, account: ACCOUNT, transactions: fx.transactions, rawReader: fx.rawReader })
  expect(applyFeeReceipt).not.toHaveBeenCalled()
})

test('self-sent rewards-wallet change that decrypts to a fee pid is refused', async () => {
  const fx = fixture([evidence({ row: { fee: 400_000_000n, spent_outputs: [{ amount: '1400000000', sender: { maj_i: 0, min_i: 0 } }] } })])
  await recoverPlatformFeePids({ models: fx.models, account: ACCOUNT, transactions: fx.transactions, rawReader: fx.rawReader })
  expect(applyFeeReceipt).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('warn', 'platform fee self-payment refused', expect.any(String), expect.anything())
})

test('an unscannable account or no reader is a no-op', async () => {
  const fx = fixture([evidence()])
  await recoverPlatformFeePids({ models: fx.models, account: { ...ACCOUNT, viewKey: null }, transactions: fx.transactions, rawReader: fx.rawReader })
  await recoverPlatformFeePids({ models: fx.models, account: ACCOUNT, transactions: fx.transactions, rawReader: null })
  expect(fx.rawReader.read).not.toHaveBeenCalled()
  expect(applyFeeReceipt).not.toHaveBeenCalled()
})
