/* eslint-env jest */
// Integrated-address fee receipts (api/monero/feeObservation.js) against the
// REAL DB: the platform receipt state machine is raw SQL over FeeObservation's
// (txHash, recipientMajor, recipientMinor) unique, so its idempotency, binding
// and gate guarantees are only meaningful under real constraints. The live
// flip and the boost bump are module-bound side effects — mocked here so the
// suite asserts exactly when the applier fires them.
import { randomBytes } from 'node:crypto'
import prisma from '@/api/models'
import { applyFeeReceipt, excludeProvisionalFeeReceipt } from '@/api/monero/feeObservation'
import { flipPendingToLive, applyBoostDetected } from '@/worker/rewardsWalletObserver'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { testPlatformFeeRecipient } from '../../helpers/platformFeeRecipient'

jest.mock('../../../worker/rewardsWalletObserver', () => ({
  __esModule: true,
  flipPendingToLive: jest.fn(async () => {}),
  applyBoostDetected: jest.fn(async () => {})
}))
jest.mock('../../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))

const created = { users: [], payIns: [], pids: [], hashes: [] }
let userId
let recipient

const pid = () => { const p = randomBytes(8).toString('hex'); created.pids.push(p); return p }
const hash = () => { const h = 'ifafee' + randomBytes(29).toString('hex'); created.hashes.push(h); return h }

beforeAll(async () => {
  const [{ id }] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  userId = id
  created.users.push(id)
  recipient = await testPlatformFeeRecipient(prisma)
})

afterAll(async () => {
  // FK-safe: receipts, then intents, then PayIns/users (the recipient row is
  // shared test infrastructure and never deleted).
  await prisma.feeObservation.deleteMany({ where: { txHash: { in: created.hashes } } })
  await prisma.observedSubFee.deleteMany({ where: { txHash: { in: created.hashes } } })
  await prisma.subFeePidMap.deleteMany({ where: { paymentId: { in: created.pids } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

beforeEach(() => jest.clearAllMocks())

// A platform intent + its PayIn quoting `quote` piconeros (0.001 XMR default).
async function seedPlatformLeg ({ feeType = 'POSTING', quote = 1_000_000_000n, uriXmr = '0.001', postId = 4242, subName = null, payInType = 'ITEM_CREATE' } = {}) {
  const paymentId = pid()
  const feeMap = await prisma.subFeePidMap.create({
    data: {
      paymentId,
      amountPiconeros: quote,
      expiresAt: new Date(Date.now() + 86_400_000),
      recipientAccountId: recipient.id,
      recipientAddress: recipient.address,
      feeType,
      postId,
      subName
    }
  })
  const feePayIn = await prisma.payIn.create({
    data: { userId, payInType, payInState: 'PAID', piconeros: 0n, moneroUri: `monero:4INTEGRATED?tx_amount=${uriXmr}`, moneroPaymentId: paymentId }
  })
  created.payIns.push(feePayIn.id)
  return { feeMap, feePayIn }
}

const rowsFor = txHash => prisma.feeObservation.findMany({ where: { txHash } })

test('a provisional platform receipt is ledger-only: frozen intent identity at (0,0), no gate', async () => {
  const { feeMap, feePayIn } = await seedPlatformLeg({ subName: 'frozen-turf' })
  const txHash = hash()
  // forged callback depth on a height-less receipt must not mature it either
  const out = await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash, piconeros: 1_000_000_000n, height: null, confirmations: 999 })
  expect(out).toEqual({ transitioned: false, cumulative: 0n })
  expect(flipPendingToLive).not.toHaveBeenCalled()
  const [row] = await rowsFor(txHash)
  expect(row).toMatchObject({
    paymentId: feeMap.paymentId,
    payInId: feePayIn.id,
    feeType: 'POSTING',
    postId: 4242,
    subName: 'frozen-turf',
    recipientMajor: 0,
    recipientMinor: 0,
    height: null,
    state: 'DETECTED',
    walletReceipt: true
  })
  expect(await prisma.observedSubFee.count({ where: { txHash } })).toBe(0)
})

test('two verified partial receipts open the gate only once the cumulative covers the full quote', async () => {
  const { feeMap, feePayIn } = await seedPlatformLeg()
  const a = await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash: hash(), piconeros: 400_000_000n, height: 100, confirmations: 1 })
  expect(a.cumulative).toBe(400_000_000n)
  expect(flipPendingToLive).not.toHaveBeenCalled()
  const b = await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash: hash(), piconeros: 600_000_000n, height: 101, confirmations: 1 })
  expect(b.cumulative).toBe(1_000_000_000n)
  expect(flipPendingToLive).toHaveBeenCalledWith(prisma, feePayIn, 1_000_000_000n)
})

test('a replay re-runs the gate (heals a failed flip) without a second row or transition', async () => {
  const { feeMap, feePayIn } = await seedPlatformLeg()
  const receipt = { feeMap, feePayIn, txHash: hash(), piconeros: 1_000_000_000n, height: 100, confirmations: 1 }
  expect((await applyFeeReceipt(prisma, receipt)).transitioned).toBe(true)
  const replay = await applyFeeReceipt(prisma, receipt)
  expect(replay.transitioned).toBe(false)
  expect(flipPendingToLive).toHaveBeenCalledTimes(2)
  expect(await rowsFor(receipt.txHash)).toHaveLength(1)
})

test('the verified height transition corrects the provisional (callback-claimed) amount', async () => {
  const { feeMap, feePayIn } = await seedPlatformLeg()
  const txHash = hash()
  await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash, piconeros: 5_000_000_000n, height: null, confirmations: 0 })
  await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash, piconeros: 300_000_000n, height: 100, confirmations: 1 })
  const [row] = await rowsFor(txHash)
  expect(row.piconeros).toBe(300_000_000n)
  expect(row.height).toBe(100)
  expect(flipPendingToLive).not.toHaveBeenCalled()
})

test('concurrent writers on one receipt book exactly one platform row', async () => {
  const { feeMap, feePayIn } = await seedPlatformLeg()
  const receipt = { feeMap, feePayIn, txHash: hash(), piconeros: 1_000_000_000n, height: 100, confirmations: 1 }
  const results = await Promise.all([applyFeeReceipt(prisma, receipt), applyFeeReceipt(prisma, receipt)])
  expect(await rowsFor(receipt.txHash)).toHaveLength(1)
  expect(results.filter(r => r.transitioned)).toHaveLength(1)
})

test('a (hash,0,0) row bound to another pid is never rebound or rewritten', async () => {
  const first = await seedPlatformLeg()
  const second = await seedPlatformLeg()
  const txHash = hash()
  await applyFeeReceipt(prisma, { ...first, txHash, piconeros: 1_000_000_000n, height: null, confirmations: 0 })
  jest.clearAllMocks()
  const out = await applyFeeReceipt(prisma, { ...second, txHash, piconeros: 9_000_000_000n, height: 100, confirmations: 20 })
  expect(out).toEqual({ transitioned: false, cumulative: 0n })
  expect(flipPendingToLive).not.toHaveBeenCalled()
  const [row] = await rowsFor(txHash)
  expect(row).toMatchObject({ paymentId: first.feeMap.paymentId, payInId: first.feePayIn.id, piconeros: 1_000_000_000n, height: null, state: 'DETECTED' })
})

test('a URI quote that disagrees with the intent refuses settlement but keeps the cash', async () => {
  const { feeMap, feePayIn } = await seedPlatformLeg({ quote: 1_000_000_000n, uriXmr: '0.0001' })
  const txHash = hash()
  await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash, piconeros: 1_000_000_000n, height: 100, confirmations: 1 })
  expect(flipPendingToLive).not.toHaveBeenCalled()
  expect(await rowsFor(txHash)).toHaveLength(1)
})

test('an excluded (self-send) provisional receipt can never be claimed or counted', async () => {
  const { feeMap, feePayIn } = await seedPlatformLeg()
  const txHash = hash()
  await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash, piconeros: 1_000_000_000n, height: null, confirmations: 0 })
  expect(await excludeProvisionalFeeReceipt(prisma, feeMap, txHash)).toBe(1)
  const out = await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash, piconeros: 1_000_000_000n, height: 100, confirmations: REQUIRED_CONFIRMATIONS })
  expect(out).toEqual({ transitioned: false, cumulative: 0n })
  expect(flipPendingToLive).not.toHaveBeenCalled()
  const [row] = await rowsFor(txHash)
  expect(row).toMatchObject({ state: 'EXCLUDED', height: null })
})

test('N-conf maturity needs the verified height and fires once', async () => {
  const { feeMap, feePayIn } = await seedPlatformLeg()
  const txHash = hash()
  await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash, piconeros: 1_000_000_000n, height: 100, confirmations: REQUIRED_CONFIRMATIONS })
  const [row] = await rowsFor(txHash)
  expect(row.state).toBe('CONFIRMED')
  expect(row.confirmedAt).not.toBeNull()
})

test('an abandoned (PayIn-less) receipt records cash with payInId NULL and no gate', async () => {
  const { feeMap } = await seedPlatformLeg()
  const txHash = hash()
  await applyFeeReceipt(prisma, { feeMap, feePayIn: null, txHash, piconeros: 1_000_000_000n, height: 100, confirmations: 1 })
  expect(flipPendingToLive).not.toHaveBeenCalled()
  const [row] = await rowsFor(txHash)
  expect(row).toMatchObject({ payInId: null, postId: 4242, feeType: 'POSTING', height: 100 })
})

test('a boost bumps by the actual verified amount exactly once per receipt, never provisionally', async () => {
  const { feeMap, feePayIn } = await seedPlatformLeg({ feeType: 'BOOST', payInType: 'BOOST' })
  const first = hash()
  await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash: first, piconeros: 7_000_000_000n, height: null, confirmations: 0 })
  expect(applyBoostDetected).not.toHaveBeenCalled()
  await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash: first, piconeros: 7_000_000_000n, height: 100, confirmations: 1 })
  await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash: first, piconeros: 7_000_000_000n, height: 100, confirmations: 1 })
  await applyFeeReceipt(prisma, { feeMap, feePayIn, txHash: hash(), piconeros: 2_000_000_000n, height: 101, confirmations: 1 })
  expect(applyBoostDetected.mock.calls.map(c => c[2])).toEqual([7_000_000_000n, 2_000_000_000n])
  // boosts have no quote gate: overpayment is legitimate, never a flip
  expect(flipPendingToLive).not.toHaveBeenCalled()
})

test('an owner intent stays in the owner ledger (ObservedSubFee), never FeeObservation', async () => {
  const paymentId = pid()
  const feeMap = await prisma.subFeePidMap.create({
    data: {
      paymentId,
      subName: 'owner-turf',
      ownerUserId: userId,
      amountPiconeros: 1_000_000_000n,
      expiresAt: new Date(Date.now() + 86_400_000),
      recipientAccountId: recipient.id,
      recipientAddress: recipient.address
    }
  })
  const txHash = hash()
  await applyFeeReceipt(prisma, { feeMap, feePayIn: null, txHash, piconeros: 1_000_000_000n, height: 100, confirmations: 1 })
  expect(await prisma.observedSubFee.count({ where: { txHash, paymentId } })).toBe(1)
  expect(await prisma.feeObservation.count({ where: { txHash } })).toBe(0)
})

test('the intent route/snapshot checks reject malformed intents at the DB', async () => {
  const base = { amountPiconeros: 1n, expiresAt: new Date() }
  // platform classification without a recipient
  await expect(prisma.subFeePidMap.create({ data: { ...base, paymentId: pid(), feeType: 'POSTING' } })).rejects.toThrow()
  // recipient id without its address snapshot
  await expect(prisma.subFeePidMap.create({ data: { ...base, paymentId: pid(), feeType: 'POSTING', recipientAccountId: recipient.id } })).rejects.toThrow()
  // owner intent without owner attribution
  await expect(prisma.subFeePidMap.create({ data: { ...base, paymentId: pid(), recipientAccountId: recipient.id, recipientAddress: recipient.address } })).rejects.toThrow()
  // a historical owner intent (no recipient snapshot) stays valid
  await expect(prisma.subFeePidMap.create({ data: { ...base, paymentId: pid(), subName: 'legacy', ownerUserId: userId } })).resolves.toMatchObject({ recipientAccountId: null })
})
