/* eslint-env jest */
// lws tx-confirmation callbacks for INTEGRATED PLATFORM fee intents
// (pages/api/monero/webhook.js fee branch). The owner-routed cases live in
// webhook.test.js; this suite pins what is different for platform intents:
// verification against the FROZEN recipient, fail-closed (503) when that
// recipient cannot verify, chain-derived height/depth only, and the hand-off
// to the shared applier — never a direct ledger write.
import { handleWebhook } from '@/pages/api/monero/webhook'
import { verifyReceiptAmount } from '@/api/monero/receiptVerification'
import { applyFeeReceipt, excludeProvisionalFeeReceipt } from '@/api/monero/feeObservation'
import { alert } from '@/lib/alert'

jest.mock(`${process.cwd()}/lib/auth`, () => ({ secureCookie: (name) => name }))
jest.mock(`${process.cwd()}/lib/alert`, () => ({ alert: jest.fn() }))
jest.mock(`${process.cwd()}/api/monero/daemonClient`, () => ({
  daemonClient: { getTransactions: jest.fn().mockResolvedValue([]) }
}))
jest.mock(`${process.cwd()}/api/monero/feeObservation`, () => ({
  applyFeeReceipt: jest.fn().mockResolvedValue({ transitioned: true, cumulative: 0n }),
  excludeProvisionalFeeReceipt: jest.fn().mockResolvedValue(1)
}))
jest.mock(`${process.cwd()}/api/monero/receiptVerification`, () => ({
  ...jest.requireActual(`${process.cwd()}/api/monero/receiptVerification`),
  verifyReceiptAmount: jest.fn()
}))

const PID = 'a1b2c3d4e5f60718'
const RECIPIENT = { id: 91, label: 'platform_rewards', status: 'ACTIVE', address: 'PLATFORM', viewKey: { ciphertext: Buffer.alloc(0) }, subaddresses: [] }
const FEE_MAP = { id: 3, paymentId: PID, feeType: 'POSTING', ownerUserId: null, subName: null, postId: 77, amountPiconeros: 1_000_000_000n, recipientAccountId: 91, recipientAddress: 'PLATFORM' }
const FEE_PAYIN = { id: 101, payInType: 'ITEM_CREATE', moneroPaymentId: PID, moneroUri: 'monero:4INT?tx_amount=0.001', piconeros: 0n }

const NOT_MODELS = new Set(['then', 'asymmetricMatch', 'toJSON', 'nodeType', 'constructor', 'tagName'])

// Every model lookup the handler makes before the fee branch (tip, bounty, …)
// misses; the fee intent, its PayIn and the frozen recipient are served.
function platformModels ({ payIn = FEE_PAYIN, recipient = RECIPIENT, feeMap = FEE_MAP } = {}) {
  const miss = () => jest.fn().mockResolvedValue(null)
  const models = new Proxy({
    subFeePidMap: { findUnique: jest.fn(async ({ where }) => where.paymentId === PID ? feeMap : null) },
    payIn: { findUnique: jest.fn(async ({ where }) => where.moneroPaymentId === PID ? payIn : null) },
    moneroAccount: { findUnique: jest.fn(async ({ where }) => where.id === 91 ? recipient : null), findFirst: miss() },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0)
  }, {
    // auto-vivify only model delegates (never symbols/jest equality probes)
    get: (target, prop) => {
      if (!(prop in target) && typeof prop === 'string' && /^[a-z][A-Za-z]+$/.test(prop) && !NOT_MODELS.has(prop)) {
        target[prop] = new Proxy({}, { get: (t, m) => (typeof m === 'string' ? (t[m] ??= miss()) : undefined) })
      }
      return target[prop]
    }
  })
  return models
}

function mockRes () {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn().mockReturnThis() }
}

const lwsCallback = (overrides = {}) => ({
  headers: {},
  body: { payment_id: PID, confirmations: 999, tx_info: { tx_hash: 'txA', amount: '1000000000', block: 1 }, ...overrides }
})

beforeEach(() => jest.clearAllMocks())

test('a verified mined receipt goes to the shared applier with chain-derived height and depth', async () => {
  verifyReceiptAmount.mockResolvedValue({ ok: true, level: 'lws', tx: { hash: 'txA', height: 100, piconeros: 1_000_000_000n, spent_outputs: [] }, chainHeight: 104 })
  const models = platformModels()
  const res = mockRes()
  await handleWebhook(lwsCallback(), res, models, {})
  expect(res.status).toHaveBeenCalledWith(200)
  // verification ran against the FROZEN recipient, never an owner/current-wallet lookup
  expect(verifyReceiptAmount).toHaveBeenCalledWith(expect.objectContaining({ account: RECIPIENT, paymentId: PID, txHash: 'txA' }))
  expect(models.moneroAccount.findFirst).not.toHaveBeenCalled()
  // callback block (1) and confirmations (999) are ignored: height 100, depth 104-100+1
  expect(applyFeeReceipt).toHaveBeenCalledWith(models, {
    feeMap: FEE_MAP, feePayIn: FEE_PAYIN, txHash: 'txA', piconeros: 1_000_000_000n, height: 100, confirmations: 5
  })
})

test('a daemon-level (mempool) verdict is provisional: NULL height, zero depth', async () => {
  verifyReceiptAmount.mockResolvedValue({ ok: true, level: 'daemon', tx: { hash: 'txA', height: null } })
  const models = platformModels()
  await handleWebhook(lwsCallback(), mockRes(), models, {})
  expect(applyFeeReceipt).toHaveBeenCalledWith(models, expect.objectContaining({ height: null, confirmations: 0 }))
})

test.each([
  ['the frozen recipient is gone', { recipient: null }],
  ['the frozen recipient no longer matches its snapshot', { recipient: { ...RECIPIENT, address: 'SWAPPED' } }],
  ['the frozen recipient has no view key', { recipient: { ...RECIPIENT, viewKey: null } }],
  ['the frozen recipient is INACTIVE', { recipient: { ...RECIPIENT, status: 'INACTIVE' } }]
])('fails closed with 503 (lws retries) when %s — no receipt', async (_, opts) => {
  const res = mockRes()
  await handleWebhook(lwsCallback(), res, platformModels(opts), {})
  expect(res.status).toHaveBeenCalledWith(503)
  expect(verifyReceiptAmount).not.toHaveBeenCalled()
  expect(applyFeeReceipt).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('critical', 'platform fee verification unavailable', expect.any(String), expect.anything())
})

test('a skipped verification never credits a platform receipt (no legacy fail-open)', async () => {
  verifyReceiptAmount.mockResolvedValue({ ok: true, skipped: true })
  const res = mockRes()
  await handleWebhook(lwsCallback(), res, platformModels(), {})
  expect(res.status).toHaveBeenCalledWith(503)
  expect(applyFeeReceipt).not.toHaveBeenCalled()
})

test('a fabricated amount/hash (rejected verdict) records nothing', async () => {
  verifyReceiptAmount.mockResolvedValue({ ok: false, reason: 'amount_mismatch' })
  const res = mockRes()
  await handleWebhook(lwsCallback(), res, platformModels(), {})
  expect(res.status).toHaveBeenCalledWith(200)
  expect(applyFeeReceipt).not.toHaveBeenCalled()
})

test('a self-send (rewards-wallet change) is refused and its provisional receipt excluded', async () => {
  // exact monetary closure: own spent output 1.0004 - fee 0.0004 == received 1.0
  verifyReceiptAmount.mockResolvedValue({
    ok: true,
    level: 'lws',
    tx: { hash: 'txA', height: 100, piconeros: 1_000_000_000n, fee: 400_000_000n, spent_outputs: [{ amount: 1_400_000_000n, sender: { maj_i: 0, min_i: 0 } }] },
    chainHeight: 110
  })
  const models = platformModels()
  const res = mockRes()
  await handleWebhook(lwsCallback(), res, models, {})
  expect(res.status).toHaveBeenCalledWith(200)
  expect(excludeProvisionalFeeReceipt).toHaveBeenCalledWith(models, FEE_MAP, 'txA')
  expect(applyFeeReceipt).not.toHaveBeenCalled()
})

test('a late payment on an abandoned invoice records cash (no PayIn, no gate) and pages operators', async () => {
  verifyReceiptAmount.mockResolvedValue({ ok: true, level: 'lws', tx: { hash: 'txA', height: 100, piconeros: 1_000_000_000n, spent_outputs: [] }, chainHeight: 100 })
  const models = platformModels({ payIn: null })
  const res = mockRes()
  await handleWebhook(lwsCallback(), res, models, {})
  expect(res.status).toHaveBeenCalledWith(200)
  expect(applyFeeReceipt).toHaveBeenCalledWith(models, expect.objectContaining({ feeMap: FEE_MAP, feePayIn: null, height: 100, confirmations: 1 }))
  expect(alert).toHaveBeenCalledWith('critical', 'payment arrived after fee abandonment', expect.stringContaining('platform POSTING fee'), expect.anything())
})

test('a daemon-level over-claim beyond the quote is refused for gated fees, allowed for boosts', async () => {
  verifyReceiptAmount.mockResolvedValue({ ok: true, level: 'daemon', tx: { hash: 'txA', height: null } })
  await handleWebhook(lwsCallback({ tx_info: { tx_hash: 'txA', amount: '9000000000' } }), mockRes(), platformModels(), {})
  expect(applyFeeReceipt).not.toHaveBeenCalled()
  const boostMap = { ...FEE_MAP, feeType: 'BOOST' }
  const models = platformModels({ feeMap: boostMap, payIn: { ...FEE_PAYIN, payInType: 'BOOST' } })
  await handleWebhook(lwsCallback({ tx_info: { tx_hash: 'txA', amount: '9000000000' } }), mockRes(), models, {})
  expect(applyFeeReceipt).toHaveBeenCalledWith(models, expect.objectContaining({ feeMap: boostMap, piconeros: 9_000_000_000n, height: null }))
})
