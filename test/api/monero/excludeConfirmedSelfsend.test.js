/* eslint-env jest */
// Injected dependencies test the money-changing CLI without a live database.
import { runCli, findTipTx, closureEvidence } from '@/scripts/exclude-confirmed-selfsend'
import { reverseTip } from '@/api/monero/ranking'

jest.mock(`${process.cwd()}/api/monero/ranking`, () => ({ reverseTip: jest.fn() }))

const ACCT = {
  id: 7,
  label: 'author',
  address: 'A',
  status: 'ACTIVE',
  viewKey: { ciphertext: Buffer.alloc(0) },
  lastTxId: null,
  subaddresses: [{ majorIndex: 0, minorIndex: 5 }]
}

const closingTx = (over = {}) => ({
  hash: 'aa'.repeat(32),
  payment_id: 'deadbeefdeadbeef',
  piconeros: 1000n,
  fee: 10n,
  spent_outputs: [{ amount: '1010', out_index: 1, sender: { maj_i: 0, min_i: 0 } }],
  ...over
})

const confTip = (over = {}) => ({
  id: 42n,
  postId: 3,
  tipperId: 5,
  state: 'CONFIRMED',
  paymentId: 'deadbeefdeadbeef',
  piconeros: 1000n,
  txHash: 'aa'.repeat(32),
  rankPiconeros: 700n,
  post: { userId: 9 },
  recipientAccount: ACCT,
  ...over
})

function modelsWithTip (tip, { claimed = 1 } = {}) {
  const executeRaw = jest.fn().mockResolvedValue(claimed)
  const abuseSignalCreate = jest.fn().mockResolvedValue({})
  const userUpdate = jest.fn().mockResolvedValue({})
  const models = {
    observedTip: { findUnique: jest.fn().mockResolvedValue(tip) },
    $transaction: jest.fn(async (fn) => fn({
      $executeRaw: executeRaw,
      $queryRaw: jest.fn().mockResolvedValue([{ subName: null }]),
      abuseSignal: { create: abuseSignalCreate },
      user: { update: userUpdate }
    }))
  }
  return { models, executeRaw, abuseSignalCreate, userUpdate }
}

const lwsWith = (txs) => ({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: txs }) })
const log = jest.fn()
const logError = jest.fn()

function cliCase ({ txs = [closingTx()], tip = confTip(), claimed = 1 } = {}) {
  const fixture = modelsWithTip(tip, { claimed })
  const lws = lwsWith(txs)
  return {
    ...fixture,
    lws,
    run: (argv = ['42', '--apply']) => runCli(argv, { models: fixture.models, lws, log, logError })
  }
}

beforeEach(() => jest.clearAllMocks())

describe('findTipTx (hash-first evidence anchoring)', () => {
  test('a stored hash resolves only its exact tx (case-insensitive)', () => {
    const samePid = closingTx({ hash: 'bb'.repeat(32) })
    const exact = closingTx()
    expect(findTipTx([samePid, exact], { paymentId: 'deadbeefdeadbeef', txHash: 'aa'.repeat(32).toUpperCase() })).toBe(exact)
  })
  test('a same-pid different-hash tx is never evidence for the stored hash', () => {
    const samePid = closingTx({ hash: 'bb'.repeat(32) })
    expect(findTipTx([samePid], { paymentId: 'deadbeefdeadbeef', txHash: 'aa'.repeat(32) })).toBe(null)
  })
  test('no stored hash falls back to the pid lookup (legacy hash-free claims)', () => {
    const tx = closingTx()
    expect(findTipTx([tx], { paymentId: 'deadbeefdeadbeef', txHash: null })).toBe(tx)
  })
})

describe('closureEvidence (dry-run math, never candidate-only "proof")', () => {
  test('reports received, own-candidate sum, fee, and the verdict', () => {
    expect(closureEvidence(closingTx(), ACCT)).toEqual({
      received: 1000n,
      candidateSum: 1010n,
      fee: 10n,
      closes: true
    })
  })
  test('missing candidate amount leaves closure unproven, not zero', () => {
    const tx = closingTx({ spent_outputs: [{ sender: { maj_i: 0, min_i: 0 } }] })
    const ev = closureEvidence(tx, ACCT)
    expect(ev.candidateSum).toBe(null)
    expect(ev.closes).toBe(false)
  })
  test('an empty tx closes only if the write gate does (no candidate shortcut)', () => {
    expect(closureEvidence({ piconeros: 0n, fee: 0n, spent_outputs: [] }, ACCT).closes).toBe(false)
  })
})

describe('runCli — refusal and write discipline', () => {
  test('closure-exact tip + --apply: excludes, reverses, restores credit, signals', async () => {
    const { run, executeRaw, abuseSignalCreate, userUpdate } = cliCase()
    const out = await run()
    expect(out.status).toBe('excluded')
    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect(reverseTip).toHaveBeenCalledWith(3, 5, 1000n, 700n, expect.anything())
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { stackedPiconeros: { decrement: 1000n } }
    })
    expect(abuseSignalCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'SELF_SEND_EXCLUDED', tipId: 42n })
    })
  })

  test.each([
    ['candidate-only tx', [closingTx({ fee: null, spent_outputs: [{ sender: { maj_i: 0, min_i: 0 } }] })]],
    ['missing fee', [closingTx({ fee: null })]],
    ['foreign-only candidates', [closingTx({ spent_outputs: [{ amount: '1010', sender: { maj_i: 4, min_i: 2 } }] })]],
    ['same-PID different-hash tx', [closingTx({ hash: 'bb'.repeat(32) })]],
    ['no matching tx', []]
  ])('%s: refuses without writes', async (_, txs) => {
    const { run, models, executeRaw } = cliCase({ txs })
    const out = await run()
    expect(out.status).toBe('refused')
    expect(models.$transaction).not.toHaveBeenCalled()
    expect(executeRaw).not.toHaveBeenCalled()
  })

  test('dry-run: prints the evidence, writes nothing', async () => {
    const { run, models, executeRaw } = cliCase()
    const out = await run(['42'])
    expect(out.status).toBe('dry-run')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('closes=true'))
    expect(models.$transaction).not.toHaveBeenCalled()
    expect(executeRaw).not.toHaveBeenCalled()
  })

  test('lost claim (state changed concurrently): no side effects, no signal', async () => {
    const { run, executeRaw, abuseSignalCreate } = cliCase({ claimed: 0 })
    const out = await run()
    expect(out.status).toBe('lost-claim')
    // The CAS ran but claimed zero rows; no reversal or signal may follow.
    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect(abuseSignalCreate).not.toHaveBeenCalled()
    expect(reverseTip).not.toHaveBeenCalled()
  })

  test.each([
    ['non-CONFIRMED tip', { state: 'DETECTED' }],
    ['unscannable account', { recipientAccount: { ...ACCT, viewKey: null } }]
  ])('%s: refused before any scan', async (_, overrides) => {
    const { run, lws } = cliCase({ tip: confTip(overrides) })
    const out = await run()
    expect(out.status).toBe('refused')
    expect(lws.getAddressTxs).not.toHaveBeenCalled()
  })

  test('platform rewards account is never author-credited', async () => {
    const { run, userUpdate } = cliCase({ tip: confTip({ recipientAccount: { ...ACCT, label: 'platform_rewards' } }) })
    const out = await run()
    expect(out.status).toBe('excluded')
    expect(userUpdate).not.toHaveBeenCalled()
  })
})
