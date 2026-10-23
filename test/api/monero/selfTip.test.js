/* eslint-env jest */
import { isSelfSend, hasOwnSpendCandidates, shouldExcludeTip, resolveItemSubName, lookupTipTx, lookupTipTxMeta, chainMismatch, recheckDetectedTip } from '@/api/monero/selfTip'
import { alert } from '@/lib/alert'
import { reverseTip } from '@/api/monero/ranking'
import { moneroTxNotFoundExclusionsTotal } from '@/lib/metrics'
// ranking's reverseTip/applyTipDetected are mocked at the module boundary
// (process.cwd()-absolute, same pattern as webhook.test.js) so the exclusion
// and corrected-path transactions are assertable without the ranking SQL
// graph — applyTipDetected's loadTipRankConfig must never reach the real DB
// from this file. babel hoists jest.mock above the imports.
jest.mock(`${process.cwd()}/api/monero/ranking`, () => ({ reverseTip: jest.fn(), applyTipDetected: jest.fn() }))
jest.mock(`${process.cwd()}/lib/alert`, () => ({ alert: jest.fn() }))

const ACCT = { id: 7, subaddresses: [{ majorIndex: 0, minorIndex: 1 }, { majorIndex: 0, minorIndex: 5 }] }

// Nested wire amounts remain strings; only top-level amounts are BigInt-promoted.
const so = (maj, min, amount) => (amount == null
  ? { sender: { maj_i: maj, min_i: min } }
  : { amount: String(amount), sender: { maj_i: maj, min_i: min } })

const closingTx = (over = {}) => ({
  piconeros: 1000n,
  fee: 10n,
  spent_outputs: [so(0, 0, 1010)],
  ...over
})

describe('isSelfSend', () => {
  test('true when own-index candidates close exactly (primary subaddress (0,0))', () => {
    expect(isSelfSend(ACCT, closingTx({ spent_outputs: [so(0, 0, 1010), so(4, 2)] }))).toBe(true)
  })
  test('true when a spent output matches a registered SubaddressIndex row and closes', () => {
    expect(isSelfSend(ACCT, closingTx({ piconeros: 490n, spent_outputs: [so(0, 5, 500)] }))).toBe(true)
  })
  test('true for the sender shape', () => {
    expect(isSelfSend(ACCT, closingTx({ piconeros: 490n, spent_outputs: [so(0, 1, 500)] }))).toBe(true)
  })
  test('false when spent outputs are foreign subaddresses (candidate false-match guard)', () => {
    // a foreign wallet's primary is also (0,0) — but lws only attaches indices
    // decoded against the SCANNED account, so (4,2)/(9,9) are foreign indices
    expect(isSelfSend(ACCT, { piconeros: 1000n, fee: 10n, spent_outputs: [so(4, 2), so(9, 9)] })).toBe(false)
  })
  test('false when the account has subaddresses but none match', () => {
    const acct = { subaddresses: [{ majorIndex: 1, minorIndex: 0 }] }
    expect(isSelfSend(acct, { piconeros: 1000n, fee: 10n, spent_outputs: [so(2, 3)] })).toBe(false)
  })
  test('false for empty or missing spent_outputs', () => {
    expect(isSelfSend(ACCT, closingTx({ spent_outputs: [] }))).toBe(false)
    expect(isSelfSend(ACCT, { piconeros: 1000n, fee: 10n })).toBe(false)
  })
  test('false for a null tx (payment not found in the scan)', () => {
    expect(isSelfSend(ACCT, null)).toBe(false)
  })
})

describe('isSelfSend — exact-closure requirement (ring decoys are not proof)', () => {
  // A recipient-owned decoy must not suffice for exclusion (2026-10 incident).
  test('own-index candidate WITHOUT closure is NOT a self-send', () => {
    // real replay ratio (restored tip #7): candidates ~0.97 XMR vs received 1.0 XMR
    expect(isSelfSend(ACCT, {
      piconeros: 1000000000000n,
      fee: 61000000000n,
      spent_outputs: [so(0, 0, 969380000000)]
    })).toBe(false)
  })
  test('candidates must SUM to closure — no single-entry shortcut', () => {
    // one candidate alone would "close" (1010 - 10 == 1000) but the own sum is 1020
    expect(isSelfSend(ACCT, {
      piconeros: 1000n,
      fee: 10n,
      spent_outputs: [so(0, 0, 1010), so(0, 5, 10)]
    })).toBe(false)
    // the same two candidates summing to received + fee DO close
    expect(isSelfSend(ACCT, {
      piconeros: 1000n,
      fee: 10n,
      spent_outputs: [so(0, 0, 600), so(0, 5, 410)]
    })).toBe(true)
  })
  test('foreign-only rows never exclude, even when their amount would close', () => {
    expect(isSelfSend(ACCT, closingTx({ spent_outputs: [so(4, 2, 1010)] }))).toBe(false)
  })
  test('missing amount/fee/received is UNAVAILABLE, never zero-proof', () => {
    expect(isSelfSend(ACCT, { piconeros: 1000n, fee: 10n, spent_outputs: [so(0, 0)] })).toBe(false)
    expect(isSelfSend(ACCT, { piconeros: 1000n, spent_outputs: [so(0, 0, 1010)] })).toBe(false)
    expect(isSelfSend(ACCT, { fee: 10n, spent_outputs: [so(0, 0, 1010)] })).toBe(false)
  })
  test('malformed amounts cannot manufacture closure', () => {
    const garbage = ['', '12.5', '1e3', 'abc', '-5', -5, 1.5, 2 ** 60, null, {}, '0x10']
    for (const bad of garbage) {
      expect(isSelfSend(ACCT, { piconeros: 1000n, fee: 10n, spent_outputs: [{ amount: bad, sender: { maj_i: 0, min_i: 0 } }] })).toBe(false)
      expect(isSelfSend(ACCT, { piconeros: 1000n, fee: bad, spent_outputs: [so(0, 0, 1010)] })).toBe(false)
      expect(isSelfSend(ACCT, { piconeros: bad, fee: 10n, spent_outputs: [so(0, 0, 1010)] })).toBe(false)
    }
  })
  test('zero fee is genuine closure, not missing evidence', () => {
    expect(isSelfSend(ACCT, { piconeros: 1000n, fee: 0n, spent_outputs: [so(0, 0, 1000)] })).toBe(true)
    expect(isSelfSend(ACCT, { piconeros: 1000n, fee: '0', spent_outputs: [so(0, 0, '1000')] })).toBe(true)
  })
  test('piconero values beyond Number.MAX_SAFE_INTEGER parse exactly (strings and BigInts)', () => {
    const huge = '123456789012345678901234567890' // 2^96-ish, far past 2^53
    expect(isSelfSend(ACCT, {
      piconeros: 1000n,
      fee: huge,
      spent_outputs: [so(0, 0, '123456789012345678901234568890')] // huge + 1000
    })).toBe(true)
    expect(isSelfSend(ACCT, {
      piconeros: 1000n,
      fee: 123456789012345678901234567900n,
      spent_outputs: [so(0, 0, 123456789012345678901234568900n)] // fee + 1000
    })).toBe(true)
  })
})

describe('hasOwnSpendCandidates (review-alert signal, never an exclusion trigger)', () => {
  test('true when any candidate references an own subaddress', () => {
    expect(hasOwnSpendCandidates(ACCT, { spent_outputs: [so(4, 2), so(0, 5)] })).toBe(true)
  })
  test('false for foreign-only, empty, missing, or null rows', () => {
    expect(hasOwnSpendCandidates(ACCT, { spent_outputs: [so(4, 2)] })).toBe(false)
    expect(hasOwnSpendCandidates(ACCT, { spent_outputs: [] })).toBe(false)
    expect(hasOwnSpendCandidates(ACCT, {})).toBe(false)
    expect(hasOwnSpendCandidates(ACCT, null)).toBe(false)
  })
  test('true even when amounts are missing (the signal is the reference, not the arithmetic)', () => {
    expect(hasOwnSpendCandidates(ACCT, { spent_outputs: [so(0, 0)] })).toBe(true)
  })
})

describe('shouldExcludeTip', () => {
  const external = { spent_outputs: [so(4, 2)] }
  const closedSelfSend = { piconeros: 1000n, fee: 0n, spent_outputs: [so(0, 0, 1000)] }
  test('true when tipperId === postUserId (direct self-tip)', () => {
    expect(shouldExcludeTip({ tipperId: 5, postUserId: 5, account: ACCT, tx: external })).toBe(true)
  })
  test('true when isSelfSend (logged-out self-send from the registered wallet)', () => {
    expect(shouldExcludeTip({ tipperId: null, postUserId: 5, account: ACCT, tx: closedSelfSend })).toBe(true)
  })
  test('true when both conditions hold (direct wins as the reason)', () => {
    expect(shouldExcludeTip({ tipperId: 5, postUserId: 5, account: ACCT, tx: closedSelfSend })).toBe(true)
  })
  test('false for a normal attributed tip', () => {
    expect(shouldExcludeTip({ tipperId: 6, postUserId: 5, account: ACCT, tx: external })).toBe(false)
  })
  test('false for a normal anonymous tip', () => {
    expect(shouldExcludeTip({ tipperId: null, postUserId: 5, account: ACCT, tx: external })).toBe(false)
  })
  test('direct self-tip excludes even with no chain evidence at all', () => {
    expect(shouldExcludeTip({ tipperId: 5, postUserId: 5, account: ACCT, tx: null })).toBe(true)
  })
})

describe('resolveItemSubName', () => {
  test('COALESCEs root.subNames[1] over item.subNames[1], null when absent', async () => {
    const queue = [
      [{ subName: 'stasher' }], // first call: root lookup hit
      [{}], // second call: no subNames anywhere (undefined -> null)
      [] // third call: item not found
    ]
    const handle = { $queryRaw: async () => queue.shift() ?? [] }
    expect(await resolveItemSubName(1, handle)).toBe('stasher')
    expect(await resolveItemSubName(2, handle)).toBe(null)
    expect(await resolveItemSubName(3, handle)).toBe(null)
  })
})

describe('lookupTipTx cursor invariant (audit 2026-09-11 finding 1)', () => {
  // Mined rows (height present): real durable progress candidates.
  const txs = [
    { id: 101, hash: 'a', payment_id: 'feeleg', piconeros: 1n, height: 900 },
    { id: 102, hash: 'b', payment_id: 'dvx', piconeros: 2n, height: 901 }
  ]
  const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: txs }) }

  test('NEVER advances lastTxId on the platform rewards account (observer watermark)', async () => {
    const rewards = { id: 7, label: 'platform_rewards', lastTxId: 100n }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    const tx = await lookupTipTx(models, monero, rewards, 'dvx')
    expect(tx.hash).toBe('b')
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
  })

  test('still advances lastTxId forward-only on non-rewards accounts', async () => {
    const author = { id: 8, label: null, lastTxId: 100n }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    await lookupTipTx(models, monero, author, 'dvx')
    expect(models.moneroAccount.updateMany).toHaveBeenCalledWith({
      where: { id: 8, OR: [{ lastTxId: null }, { lastTxId: { lt: 102n } }] },
      data: { lastTxId: 102n }
    })
  })

  test('pending-only rows never advance the cursor (v1.0.4 mempool IDs are positions)', async () => {
    const author = { id: 8, label: null, lastTxId: 100n }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    const pendingMonero = {
      getAddressTxs: jest.fn().mockResolvedValue({
        transactions: [{ id: 205, hash: 'p', payment_id: 'dvx', piconeros: 2n, height: null, mempool: true }]
      })
    }
    await lookupTipTx(models, pendingMonero, author, 'dvx')
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
  })

  test('mixed rows advance to the mined max only', async () => {
    const author = { id: 8, label: null, lastTxId: 100n }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    const mixedMonero = {
      getAddressTxs: jest.fn().mockResolvedValue({
        transactions: [
          ...txs,
          { id: 250, hash: 'c', payment_id: null, piconeros: 1n, height: null, mempool: true }
        ]
      })
    }
    await lookupTipTx(models, mixedMonero, author, 'dvx')
    expect(models.moneroAccount.updateMany).toHaveBeenCalledWith({
      where: { id: 8, OR: [{ lastTxId: null }, { lastTxId: { lt: 102n } }] },
      data: { lastTxId: 102n }
    })
  })

  test('a huge BigInt cursor is compared exactly, never through Number', async () => {
    const huge = 9007199254740993n
    const author = { id: 8, label: null, lastTxId: huge }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    await lookupTipTx(models, monero, author, 'dvx')
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
  })
})

describe('chainMismatch (audit 2026-09-11 finding 2)', () => {
  const tip = { piconeros: 1000n, txHash: 'AA11' }
  test('true when the stored amount disagrees with the chain tx', () => {
    expect(chainMismatch(tip, { piconeros: 999n, hash: 'aa11' })).toBe(true)
  })
  test('true when both hashes are present and differ', () => {
    expect(chainMismatch(tip, { piconeros: 1000n, hash: 'ff22' })).toBe(true)
  })
  test('false when amount and (case-insensitive) hash match', () => {
    expect(chainMismatch(tip, { piconeros: 1000n, hash: 'aa11' })).toBe(false)
  })
  test('false when the stored hash is null (callbacks may omit tx_hash)', () => {
    expect(chainMismatch({ piconeros: 1000n, txHash: null }, { piconeros: 1000n, hash: 'aa11' })).toBe(false)
  })
  test('false for a null tx (not found — caller fails open)', () => {
    expect(chainMismatch(tip, null)).toBe(false)
  })
})

describe('recheckDetectedTip', () => {
  const account = { id: 7, label: 'author_acct', status: 'ACTIVE', viewKey: { ciphertext: Buffer.alloc(0) }, lastTxId: null, subaddresses: [] }
  const baseTip = {
    id: 42n,
    postId: 3,
    tipperId: 5,
    post: { userId: 9 },
    piconeros: 1000n,
    txHash: 'aa11',
    paymentId: 'abc',
    rankPiconeros: 700n,
    recipientAccount: account
  }
  const boundAt = new Date('2026-09-01T00:00:00Z')
  let txHandle
  function modelsWithClaim (claimed = 1) {
    txHandle = null
    return {
      moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      observedTip: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn(async (fn) => {
        txHandle = {
          $executeRaw: jest.fn().mockResolvedValue(claimed),
          $queryRaw: jest.fn().mockResolvedValue([{ subName: null }]),
          abuseSignal: { create: jest.fn().mockResolvedValue({}) }
        }
        return fn(txHandle)
      })
    }
  }
  const lws = (tx) => ({ getAddressTxs: jest.fn().mockResolvedValue({ transactions: tx == null ? [] : [tx] }) })

  beforeEach(() => jest.clearAllMocks())

  test('excludes CHAIN_MISMATCH, reverses the delta, and signals when a BOUND row is forged', async () => {
    const models = modelsWithClaim()
    const out = await recheckDetectedTip({
      models,
      monero: lws({ hash: 'aa11', payment_id: 'abc', piconeros: 999n, spent_outputs: [] }),
      tip: { ...baseTip, amountVerifiedAt: boundAt },
      confirmations: 10
    })
    expect(out).toEqual({ action: 'excluded', reason: 'CHAIN_MISMATCH' })
    expect(reverseTip).toHaveBeenCalledWith(3, 5, 1000n, 700n, txHandle)
    expect(txHandle.abuseSignal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'CHAIN_MISMATCH_EXCLUDED',
        piconeros: 1000n,
        details: expect.objectContaining({
          lateRecheck: true,
          storedPiconeros: '1000',
          onChainPiconeros: '999',
          storedTxHash: 'aa11',
          onChainTxHash: 'aa11'
        })
      })
    })
  })

  test('clean when a bound row matches the chain (no transaction, no signal)', async () => {
    const models = modelsWithClaim()
    const out = await recheckDetectedTip({
      models,
      monero: lws({ hash: 'aa11', payment_id: 'abc', piconeros: 1000n, spent_outputs: [] }),
      tip: { ...baseTip, amountVerifiedAt: boundAt, height: 90 },
      confirmations: 10
    })
    expect(out).toEqual({ action: 'clean' })
    expect(models.$transaction).not.toHaveBeenCalled()
  })

  test('defers when the lws tx is missing and monerod corroboration is unreachable (retries next run)', async () => {
    const models = modelsWithClaim()
    const daemon = { getTransactions: jest.fn().mockRejectedValue(new Error('monerod down')) }
    const out = await recheckDetectedTip({
      models,
      monero: lws(null),
      daemon,
      tip: { ...baseTip, txHash: 'bb'.repeat(32) },
      confirmations: 10
    })
    expect(out).toEqual({ action: 'deferred', reason: 'daemon_unreachable' })
    expect(models.$transaction).not.toHaveBeenCalled()
  })

  test('still excludes SELF_SEND when the spent outputs close exactly (wash tip)', async () => {
    const models = modelsWithClaim()
    const out = await recheckDetectedTip({
      models,
      monero: lws({ hash: 'aa11', payment_id: 'abc', piconeros: 1000n, fee: 10n, spent_outputs: [{ amount: '1010', sender: { maj_i: 0, min_i: 0 } }] }),
      tip: baseTip,
      confirmations: 10
    })
    expect(out).toEqual({ action: 'excluded', reason: 'SELF_SEND' })
    expect(txHandle.abuseSignal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'SELF_SEND_EXCLUDED' })
    })
  })

  test.each([
    ['own-index candidate without closure', [so(0, 0, 500)], true],
    ['foreign-only candidate', [so(4, 2, 500)], false],
    // Self-send plus 1 unit to a foreign destination: 1011 - 10 != received 1000.
    ['self-send batched with foreign dust', [so(0, 0, 1011)], true]
  ])('%s: proceeds without exclusion; warns only for own candidates', async (_, spentOutputs, warns) => {
    const models = modelsWithClaim()
    const out = await recheckDetectedTip({
      models,
      monero: lws({ hash: 'aa11', payment_id: 'abc', ...closingTx({ spent_outputs: spentOutputs }) }),
      tip: { ...baseTip, amountVerifiedAt: boundAt, height: 90 },
      confirmations: 10
    })
    expect(out).toEqual({ action: 'clean' })
    expect(reverseTip).not.toHaveBeenCalled()
    expect(models.$transaction).not.toHaveBeenCalled()
    if (warns) {
      expect(alert).toHaveBeenCalledWith('warn', 'unclosed Monero spend candidates',
        expect.stringContaining('tip 42'),
        { dedupeKey: 'spend-candidate-unclosed-aa11' })
    } else {
      expect(alert).not.toHaveBeenCalled()
    }
  })

  test('still excludes DIRECT_SELF_TIP with no lws lookup', async () => {
    const moneroFake = { getAddressTxs: jest.fn() }
    const out = await recheckDetectedTip({ models: modelsWithClaim(), monero: moneroFake, tip: { ...baseTip, tipperId: 9 }, confirmations: 10 })
    expect(out).toEqual({ action: 'excluded', reason: 'DIRECT_SELF_TIP' })
    expect(moneroFake.getAddressTxs).not.toHaveBeenCalled()
  })

  test('skips unscannable accounts entirely (documented fail-open posture)', async () => {
    const moneroFake = { getAddressTxs: jest.fn() }
    const out = await recheckDetectedTip({
      models: modelsWithClaim(),
      monero: moneroFake,
      tip: { ...baseTip, recipientAccount: { ...account, viewKey: null } },
      confirmations: 10
    })
    expect(out).toEqual({ action: 'clean' })
    expect(moneroFake.getAddressTxs).not.toHaveBeenCalled()
  })

  test('reports clean when another claimer won the EXCLUDED transition', async () => {
    const models = modelsWithClaim(0)
    const out = await recheckDetectedTip({
      models,
      monero: lws({ hash: 'aa11', payment_id: 'abc', piconeros: 999n, spent_outputs: [] }),
      tip: { ...baseTip, amountVerifiedAt: boundAt },
      confirmations: 10
    })
    expect(out).toEqual({ action: 'clean' })
    expect(reverseTip).not.toHaveBeenCalled()
  })

  test('backfills a bound row\'s missing height from the lws tx (never from the callback)', async () => {
    const models = modelsWithClaim()
    const out = await recheckDetectedTip({
      models,
      monero: lws({ hash: 'aa11', payment_id: 'abc', piconeros: 1000n, height: 2172600, spent_outputs: [] }),
      tip: { ...baseTip, amountVerifiedAt: boundAt },
      confirmations: 10
    })
    expect(out).toEqual({ action: 'clean' })
    expect(models.observedTip.updateMany).toHaveBeenCalledWith({
      where: { id: 42n, state: 'DETECTED', height: null },
      data: { height: 2172600 }
    })
  })
})

describe('recheckDetectedTip — zero-conf hardening (fail-closed + two-phase binding)', () => {
  function scannable () {
    // Uninitialized cursor: the mined-only helper accepts null or BigInt.
    return { id: 1, label: 'author', address: 'A', status: 'ACTIVE', viewKey: {}, lastTxId: null, subaddresses: [] }
  }
  function tipRow (over = {}) {
    return {
      id: 1,
      postId: 10,
      tipperId: 5,
      state: 'DETECTED',
      paymentId: 'deadbeefdeadbeef',
      piconeros: 1000n,
      txHash: 'bb'.repeat(32),
      rankPiconeros: 700n,
      recipientAccount: scannable(),
      post: { userId: 99 },
      amountVerifiedAt: null,
      ...over
    }
  }

  beforeEach(() => jest.clearAllMocks())

  test('a DETECTED row whose tx exists on neither lws nor monerod is TX_NOT_FOUND excluded', async () => {
    const execRaw = jest.fn().mockResolvedValue(1)
    const models = { observedTip: {}, moneroAccount: { updateMany: jest.fn() }, $transaction: jest.fn(async (fn) => fn({ $executeRaw: execRaw, abuseSignal: { create: jest.fn() }, $queryRaw: jest.fn().mockResolvedValue([{ subName: null }]) })) }
    const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 100 }) }
    const daemon = { getTransactions: jest.fn().mockResolvedValue([]) }
    const out = await recheckDetectedTip({ models, monero, daemon, tip: tipRow() })
    expect(out.action).toBe('excluded')
    expect(out.reason).toBe('TX_NOT_FOUND')
  })

  test('TX_NOT_FOUND exclusions increment the terminal-exclusion counter (lost claims and other reasons do not)', async () => {
    const count = async () => (await moneroTxNotFoundExclusionsTotal.get()).values[0].value
    const txStub = (claimed) => ({
      $executeRaw: jest.fn().mockResolvedValue(claimed),
      $queryRaw: jest.fn().mockResolvedValue([{ subName: null }]),
      abuseSignal: { create: jest.fn() }
    })
    const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 100 }) }
    const daemon = { getTransactions: jest.fn().mockResolvedValue([]) }
    const before = await count()

    // A won TX_NOT_FOUND exclusion counts once.
    const won = { observedTip: {}, moneroAccount: { updateMany: jest.fn() }, $transaction: jest.fn(async (fn) => fn(txStub(1))) }
    expect((await recheckDetectedTip({ models: won, monero, daemon, tip: tipRow() })).reason).toBe('TX_NOT_FOUND')
    expect(await count()).toBe(before + 1)

    // A lost claim excluded nothing -> no increment.
    const lost = { observedTip: {}, moneroAccount: { updateMany: jest.fn() }, $transaction: jest.fn(async (fn) => fn(txStub(0))) }
    expect((await recheckDetectedTip({ models: lost, monero, daemon, tip: tipRow() })).action).toBe('clean')
    expect(await count()).toBe(before + 1)

    // A different exclusion reason (SELF_SEND) never touches the counter.
    const selfSendTx = [{ id: 1, hash: 'bb'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 1000n, fee: 10n, height: 90, spent_outputs: [{ amount: '1010', sender: { maj_i: 0, min_i: 0 } }] }]
    const selfSend = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: selfSendTx, blockchain_height: 100 }) }
    const exModels = { observedTip: {}, moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, $transaction: jest.fn(async (fn) => fn(txStub(1))) }
    expect((await recheckDetectedTip({ models: exModels, monero: selfSend, tip: tipRow() })).reason).toBe('SELF_SEND')
    expect(await count()).toBe(before + 1)
  })

  test('lws miss but monerod has the tx -> deferred, never excluded', async () => {
    const models = { observedTip: {}, moneroAccount: { updateMany: jest.fn() }, $transaction: jest.fn() }
    const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [], blockchain_height: 100 }) }
    const daemon = { getTransactions: jest.fn().mockResolvedValue([{ hash: 'bb'.repeat(32), extra: Buffer.from([]), vout: [] }]) }
    const out = await recheckDetectedTip({ models, monero, daemon, tip: tipRow() })
    expect(out.action).toBe('deferred')
  })

  test('an unbound row (amountVerifiedAt null) is corrected to the chain amount and stamped, not excluded', async () => {
    const execRaw = jest.fn().mockResolvedValue(1)
    const models = {
      observedTip: {},
      moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(async (fn) => fn({
        $executeRaw: execRaw,
        $queryRaw: jest.fn().mockResolvedValue([{ rank_delta: 700n }]),
        abuseSignal: { create: jest.fn() }
      }))
    }
    const chainTx = { id: 1, hash: 'bb'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 400n, height: 90, spent_outputs: [] }
    const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [chainTx], blockchain_height: 100 }) }
    const out = await recheckDetectedTip({ models, monero, daemon: null, tip: tipRow({ piconeros: 1000n }) })
    expect(out.action).toBe('corrected')
    expect(out.piconeros).toBe(400n)
  })

  test('the corrected-path height stamp takes the lws tx height only, never the callback arg (review fix)', async () => {
    const runCorrected = async ({ txHeight, callbackHeight }) => {
      const execRaw = jest.fn().mockResolvedValue(1)
      const models = {
        observedTip: {},
        moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        $transaction: jest.fn(async (fn) => fn({
          $executeRaw: execRaw,
          $queryRaw: jest.fn().mockResolvedValue([{ rank_delta: 700n }]),
          abuseSignal: { create: jest.fn() }
        }))
      }
      const chainTx = {
        id: 1,
        hash: 'bb'.repeat(32),
        payment_id: 'deadbeefdeadbeef',
        piconeros: 400n,
        height: txHeight,
        spent_outputs: []
      }
      const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [chainTx], blockchain_height: 100 }) }
      const out = await recheckDetectedTip({
        models,
        monero,
        daemon: null,
        tip: tipRow({ piconeros: 1000n }),
        confirmations: 10,
        height: callbackHeight
      })
      // the stamp update is the second $executeRaw call; positional args are
      // [strings, piconeros, txHash, rankDelta, height, tipId]
      return { out, writtenHeight: execRaw.mock.calls[1][4] }
    }

    const withTxHeight = await runCorrected({ txHeight: 90, callbackHeight: 999 })
    expect(withTxHeight.out.action).toBe('corrected')
    expect(withTxHeight.writtenHeight).toBe(90)

    // the dangerous case the fallback used to cover: lws tx carries no height,
    // callback does — the callback height must NOT be written
    const withoutTxHeight = await runCorrected({ txHeight: null, callbackHeight: 999 })
    expect(withoutTxHeight.out.action).toBe('corrected')
    expect(withoutTxHeight.writtenHeight).toBe(null)
  })

  test('closure is a property of the CHAIN row: an unbound row with a divergent provisional amount still excludes when the chain tx closes', async () => {
    // Stored 1000 != chain 400, but chain closure must still exclude.
    const execRaw = jest.fn().mockResolvedValue(1)
    const models = {
      observedTip: {},
      moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(async (fn) => fn({
        $executeRaw: execRaw,
        $queryRaw: jest.fn().mockResolvedValue([{ subName: null }]),
        abuseSignal: { create: jest.fn() }
      }))
    }
    const chainTx = { id: 1, hash: 'bb'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 400n, fee: 0n, height: 90, spent_outputs: [{ amount: '400', sender: { maj_i: 0, min_i: 0 } }] }
    const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [chainTx], blockchain_height: 100 }) }
    const out = await recheckDetectedTip({ models, monero, daemon: null, tip: tipRow({ piconeros: 1000n }) })
    expect(out).toEqual({ action: 'excluded', reason: 'SELF_SEND' })
    expect(reverseTip).toHaveBeenCalled()
  })

  test('closure against the chain row only: an unbound row whose provisional amount closes is still NOT excluded when the chain tx does not', async () => {
    // A non-closing candidate must not block correction to the chain amount.
    const models = {
      observedTip: {},
      moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(async (fn) => fn({
        $executeRaw: jest.fn().mockResolvedValue(1),
        $queryRaw: jest.fn().mockResolvedValue([{ rank_delta: 700n }]),
        abuseSignal: { create: jest.fn() }
      }))
    }
    const chainTx = { id: 1, hash: 'bb'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 400n, fee: 0n, height: 90, spent_outputs: [{ amount: '500', sender: { maj_i: 0, min_i: 0 } }] }
    const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [chainTx], blockchain_height: 100 }) }
    const out = await recheckDetectedTip({ models, monero, daemon: null, tip: tipRow({ piconeros: 1000n }) })
    expect(out.action).toBe('corrected')
    expect(out.piconeros).toBe(400n)
    expect(alert).toHaveBeenCalledWith('warn', 'unclosed Monero spend candidates',
      expect.any(String),
      { dedupeKey: expect.stringContaining('spend-candidate-unclosed-') })
  })

  test('an unbound row whose lws tx carries no amount is DEFERRED without writing (never bound to 0n)', async () => {
    // A chain row without an amount is not bindable evidence: binding 0n would
    // trust-correct the row to zero (and reverse/re-apply its ranking at the
    // wrong amount). Treat it as unverifiable: no write, no credit, retry.
    const execRaw = jest.fn().mockResolvedValue(1)
    const models = {
      observedTip: {},
      moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(async (fn) => fn({
        $executeRaw: execRaw,
        $queryRaw: jest.fn().mockResolvedValue([{ rank_delta: 700n }]),
        abuseSignal: { create: jest.fn() }
      }))
    }
    const chainTx = { id: 1, hash: 'bb'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: null, height: 90, spent_outputs: [] }
    const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [chainTx], blockchain_height: 100 }) }
    const out = await recheckDetectedTip({ models, monero, daemon: null, tip: tipRow({ piconeros: 1000n }) })
    expect(out.action).toBe('deferred')
    expect(out.reason).toBe('amount_unavailable')
    expect(models.$transaction).not.toHaveBeenCalled()
    expect(reverseTip).not.toHaveBeenCalled()
  })

  test('a lost binding race returns clean WITH the winner-bound amount (callers must not credit their snapshot)', async () => {
    // The CAS matches 0 rows (a concurrent webhook/finalizer already bound the
    // row), so the follow-up read inside the same transaction must surface the
    // bound amount: the row now carries the chain's 400n, not this caller's
    // provisional 1000n snapshot.
    const execRaw = jest.fn().mockResolvedValue(0)
    const queryRaw = jest.fn().mockResolvedValue([{ piconeros: 400n }])
    const models = {
      observedTip: {},
      moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(async (fn) => fn({
        $executeRaw: execRaw,
        $queryRaw: queryRaw,
        abuseSignal: { create: jest.fn() }
      }))
    }
    const chainTx = { id: 1, hash: 'bb'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 400n, height: 90, spent_outputs: [] }
    const monero = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [chainTx], blockchain_height: 100 }) }
    const out = await recheckDetectedTip({ models, monero, daemon: null, tip: tipRow({ piconeros: 1000n }) })
    expect(out).toEqual({ action: 'clean', piconeros: 400n })
    expect(reverseTip).not.toHaveBeenCalled()
    expect(queryRaw).toHaveBeenCalled()
  })
})

describe('hash-first tx resolution (lookupTipTxMeta)', () => {
  const account = { id: 1, label: 'author', lastTxId: null, address: 'A', status: 'ACTIVE', viewKey: {}, subaddresses: [] }

  function moneroWith (txs, blockchainHeight = 100) {
    return { getAddressTxs: jest.fn().mockResolvedValue({ transactions: txs, blockchain_height: blockchainHeight }) }
  }

  test('hash-first: a named hash resolves its exact tx even when a different tx carries the pid', async () => {
    const dust = { id: 1, hash: 'aa'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 1n }
    const genuine = { id: 2, hash: 'bb'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 1000n }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
    const out = await lookupTipTxMeta(models, moneroWith([dust, genuine]), account, 'deadbeefdeadbeef', { txHash: genuine.hash })
    expect(out.tx).toBe(genuine)
    expect(out.blockchainHeight).toBe(100)
  })

  test('hash-first: a named hash absent from lws returns null (never a colliding pid tx)', async () => {
    const dust = { id: 1, hash: 'aa'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 1n }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
    const out = await lookupTipTxMeta(models, moneroWith([dust]), account, 'deadbeefdeadbeef', { txHash: 'cc'.repeat(32) })
    expect(out.tx).toBeNull()
  })

  test('no named hash: pid lookup still works (last-wins is fine for hash-free claims)', async () => {
    const tx = { id: 1, hash: 'aa'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 1n }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
    const out = await lookupTipTxMeta(models, moneroWith([tx]), account, 'deadbeefdeadbeef')
    expect(out.tx).toBe(tx)
  })

  test('collision signal: named hash absent while a same-pid tx exists', async () => {
    const dust = { id: 1, hash: 'aa'.repeat(32), payment_id: 'deadbeefdeadbeef', piconeros: 1n }
    const models = { moneroAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
    const out = await lookupTipTxMeta(models, moneroWith([dust]), account, 'deadbeefdeadbeef', { txHash: 'cc'.repeat(32) })
    expect(out.tx).toBeNull()
    expect(out.collision).toBe(true)
  })
})
