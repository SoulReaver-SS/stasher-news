/* eslint-env jest */

// Cursor-safety regression for the rewardsWalletObserver handler itself —
// the deployment blocker from docs/superpowers/plans/2026-10-22-lws-behavior-assessment.md.
//
// monero-lws v1.0.4 appends mempool rows to /get_address_txs with
// response-position IDs. The old observer advanced lastTxId from ALL rows and
// then filtered mined rows by that watermark, so pending IDs could suppress a
// later mined fee. The fix routes selection/persistence through the pure
// helpers in api/monero/lwsCursor.js; these tests pin the handler behavior.
//
// Everything economic (Prisma writes) is mocked at the models boundary; the
// observer module and cursor helpers run for real. This mocked routing
// coverage does NOT replace the existing real-DB economic suites
// (rewardsWalletObserver.{fee,downvote,flip,tip,bounty}.test.js).

import { rewardsWalletObserver } from '@/worker/rewardsWalletObserver'

jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))
jest.mock('../../api/monero/feePoolDerive', () => ({
  __esModule: true,
  topUpFeePoolIfLow: jest.fn().mockResolvedValue(undefined)
}))
jest.mock('../../api/monero/bountyReceipts', () => ({
  __esModule: true,
  attributeBountyReceipt: jest.fn().mockResolvedValue(false),
  reconcileBountyReceipts: jest.fn().mockResolvedValue(undefined)
}))

const pendingRow = id => ({
  id,
  hash: `pending-${id}`,
  height: null,
  mempool: true,
  piconeros: 1n,
  recipient: { maj_i: 0, min_i: 0 },
  payment_id: null
})

// A mined fee to a posting subaddress. Underpaid on purpose: the amount gate
// keeps the feeStatus flip (and its item-live writes) out of these cursor
// assertions while still exercising the real attribution path.
const minedFee = (id, minor = 3) => ({
  id,
  hash: `fee-${id}`,
  height: 100,
  mempool: false,
  piconeros: 1n,
  recipient: { maj_i: 1, min_i: minor },
  payment_id: null
})

function buildFixture ({ initialCursor = 9n } = {}) {
  const account = { id: 7, label: 'platform_rewards', lastTxId: initialCursor }
  const writes = []
  const models = {
    moneroAccount: {
      findFirst: jest.fn(async () => ({ ...account })),
      updateMany: jest.fn(async ({ where, data }) => {
        writes.push({ where, data })
        if (account.lastTxId == null || data.lastTxId > account.lastTxId) {
          account.lastTxId = data.lastTxId
          return { count: 1 }
        }
        return { count: 0 }
      })
    },
    payIn: {
      findFirst: jest.fn(async ({ where }) => ({
        id: 33,
        payInType: 'ITEM_CREATE',
        moneroUri: `monero:test?tx_amount=1&subaddr_minor=${where.moneroSubaddressMinor}`,
        itemPayIn: { itemId: 44 }
      }))
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
    feeObservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { piconeros: 1n } }) }
  }
  return { account, models, writes }
}

describe('the deployment blocker regression (pending IDs vs mined watermark)', () => {
  test('pending positions cannot hide a later mined fee; cursor stays at the mined max', async () => {
    const { account, models } = buildFixture()
    let response = { blockchain_height: 101, transactions: [pendingRow(10), pendingRow(11)] }
    const lws = { getAddressTxs: jest.fn(async () => response) }
    const detectReorg = jest.fn()

    await rewardsWalletObserver({ models, lws, detectReorg })
    expect(account.lastTxId).toBe(9n) // pending IDs must not advance the watermark

    response = { blockchain_height: 101, transactions: [minedFee(10)] }
    await rewardsWalletObserver({ models, lws, detectReorg })

    // The mined fee (ID 10, BELOW the pending IDs) was still attributed.
    expect(models.payIn.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { moneroSubaddressMajor: 1, moneroSubaddressMinor: 3 }
    }))
    expect(models.$queryRaw).toHaveBeenCalledTimes(1)
    expect(account.lastTxId).toBe(10n)
    expect(models.moneroAccount.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 7, OR: [{ lastTxId: null }, { lastTxId: { lt: 10n } }] },
      data: { lastTxId: 10n }
    }))
  })
})

describe('failure, replay and concurrency guards', () => {
  test('a failed attribution prevents the cursor write; a successful retry persists', async () => {
    const { account, models } = buildFixture()
    models.$queryRaw.mockRejectedValueOnce(new Error('insert failed'))
    const response = { blockchain_height: 101, transactions: [minedFee(10)] }
    const lws = { getAddressTxs: jest.fn(async () => response) }

    await expect(rewardsWalletObserver({ models, lws, detectReorg: jest.fn() }))
      .rejects.toThrow('insert failed')
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
    expect(account.lastTxId).toBe(9n)

    // Retry succeeds; the (idempotent) attribution runs once more, then the
    // cursor persists exactly once.
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(models.$queryRaw).toHaveBeenCalledTimes(2)
    expect(account.lastTxId).toBe(10n)
  })

  test('replay of an already-attributed mined row is idempotent and does not double-write', async () => {
    const { account, models } = buildFixture({ initialCursor: 10n })
    const response = { blockchain_height: 101, transactions: [minedFee(10)] }
    const lws = { getAddressTxs: jest.fn(async () => response) }

    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() }) // filtered by cursor
    expect(models.$queryRaw).not.toHaveBeenCalled()
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
    expect(account.lastTxId).toBe(10n)
  })

  test('overlapping runs: the stale proposal cannot regress the committed watermark', async () => {
    const { account, models, writes } = buildFixture({ initialCursor: 3n })
    const slow = { blockchain_height: 101, transactions: [minedFee(10)] }
    const fast = { blockchain_height: 101, transactions: [minedFee(12, 5)] }
    const responses = [slow, fast]
    const lws = { getAddressTxs: jest.fn(async () => responses.shift() ?? slow) }

    // Run A (slow) computes its proposal from the small response; run B (fast)
    // commits 12n before A's guarded write lands.
    const runA = rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    await runA

    expect(account.lastTxId).toBe(12n)
    // Both writes carried the real forward-only guard (never a bare set).
    for (const w of writes) {
      expect(w.where.OR).toEqual([{ lastTxId: null }, { lastTxId: { lt: w.data.lastTxId } }])
    }
    expect(writes.some(w => w.data.lastTxId === 12n)).toBe(true)
    expect(writes.some(w => w.data.lastTxId === 10n)).toBe(true)
  })

  test('initialization: the first mined row (id 0) persists cursor 0', async () => {
    const { account, models } = buildFixture({ initialCursor: null })
    const response = { blockchain_height: 101, transactions: [{ ...minedFee(0, 6), hash: 'fee-0' }] }
    const lws = { getAddressTxs: jest.fn(async () => response) }
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(models.moneroAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { lastTxId: 0n }
    }))
    expect(account.lastTxId).toBe(0n)
  })

  test('malformed metadata aborts the whole poll before attribution or writes', async () => {
    const { account, models } = buildFixture()
    const response = {
      blockchain_height: 101,
      transactions: [minedFee(10), { id: 11, height: 100, mempool: true }]
    }
    const lws = { getAddressTxs: jest.fn(async () => response) }
    await expect(rewardsWalletObserver({ models, lws, detectReorg: jest.fn() }))
      .rejects.toThrow(TypeError)
    expect(models.$queryRaw).not.toHaveBeenCalled()
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
    expect(account.lastTxId).toBe(9n)
  })

  test('an empty response writes nothing', async () => {
    const { account, models } = buildFixture()
    const lws = { getAddressTxs: jest.fn(async () => ({ blockchain_height: 101, transactions: [] })) }
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
    expect(account.lastTxId).toBe(9n)
  })

  test('pending-only response writes nothing even on an uninitialized cursor', async () => {
    const { account, models } = buildFixture({ initialCursor: null })
    const lws = {
      getAddressTxs: jest.fn(async () => ({
        blockchain_height: 101, transactions: [pendingRow(4)]
      }))
    }
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(models.moneroAccount.updateMany).not.toHaveBeenCalled()
    expect(account.lastTxId).toBeNull()
  })
})

describe('other dispatcher branches stay routed through the fresh slice', () => {
  test('DONATE and top-up: two unique mined receipts attribute twice, replay inserts nothing', async () => {
    const { account, models } = buildFixture({ initialCursor: null })
    const inserts = []
    models.$queryRaw.mockImplementation(async () => {
      inserts.push(Date.now())
      return [{ id: inserts.length }]
    })
    models.payIn.findFirst.mockResolvedValue({
      id: 55, payInType: 'DONATE', moneroUri: 'monero:test?tx_amount=1', itemPayIn: { itemId: 66 }
    })
    const lws = {
      getAddressTxs: jest.fn(async () => ({
        blockchain_height: 101,
        transactions: [minedFee(1, 7), minedFee(2, 7)]
      }))
    }
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(inserts).toHaveLength(2)

    // Replay: both rows are behind the cursor -> no third insert attempt.
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(inserts).toHaveLength(2)
    expect(account.lastTxId).toBe(2n)
  })

  test('a downvote receipt reaches its branch and the cursor covers it (unmapped PID is a no-op)', async () => {
    const { account, models } = buildFixture({ initialCursor: null })
    // The downvote branch is module-bound; pin it at the insert seam the
    // observer owns ($queryRaw) and stub the transition helper's model reads.
    models.downvotePidMap = {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({})
    }
    models.observedTip = { findFirst: jest.fn().mockResolvedValue(null) }
    // not an integrated-fee pid: the fee branch must fall through
    models.subFeePidMap = { findUnique: jest.fn().mockResolvedValue(null) }
    models.$queryRaw.mockResolvedValue([{ id: 1 }])
    const lws = {
      getAddressTxs: jest.fn(async () => ({
        blockchain_height: 101,
        // payment_id but no matching map row -> the branch no-ops (mocked map).
        transactions: [{ id: 3, hash: 'dv-3', height: 50, mempool: false, piconeros: 1n, recipient: { maj_i: 0, min_i: 0 }, payment_id: 'dv0000000000001' }]
      }))
    }
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(models.downvotePidMap.findUnique).toHaveBeenCalled()
    expect(account.lastTxId).toBe(3n)
  })

  test('bounty recovery reuses the fetched transactions on a full adapter (one request per poll)', async () => {
    const { reconcileBountyReceipts } = require('../../api/monero/bountyReceipts')
    const { account, models } = buildFixture({ initialCursor: 9n })
    const txs = [minedFee(10)]
    const lws = { addressTxsMode: 'full', getAddressTxs: jest.fn(async () => ({ blockchain_height: 101, transactions: txs })) }
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(lws.getAddressTxs).toHaveBeenCalledTimes(1)
    expect(reconcileBountyReceipts).toHaveBeenCalledWith(expect.objectContaining({ transactions: txs }))
    expect(account.lastTxId).toBe(10n)
  })

  test('an unknown adapter still performs the explicit full-history recovery request', async () => {
    const { reconcileBountyReceipts } = require('../../api/monero/bountyReceipts')
    const { account, models } = buildFixture({ initialCursor: 9n })
    const recovery = [{ ...minedFee(2), hash: 'recovery' }]
    let call = 0
    const lws = {
      getAddressTxs: jest.fn(async () => {
        call += 1
        return call === 1
          ? { blockchain_height: 101, transactions: [minedFee(10)] }
          : { blockchain_height: 101, transactions: recovery }
      })
    }
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(lws.getAddressTxs).toHaveBeenCalledTimes(2)
    expect(reconcileBountyReceipts).toHaveBeenCalledWith(expect.objectContaining({ transactions: recovery }))
    expect(account.lastTxId).toBe(10n)
  })

  test('a null cursor uses the initial (already full) response for recovery in either mode', async () => {
    const { reconcileBountyReceipts } = require('../../api/monero/bountyReceipts')
    const { models } = buildFixture({ initialCursor: null })
    const txs = [minedFee(1, 8)]
    const lws = { getAddressTxs: jest.fn(async () => ({ blockchain_height: 101, transactions: txs })) }
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(lws.getAddressTxs).toHaveBeenCalledTimes(1)
    expect(reconcileBountyReceipts).toHaveBeenCalledWith(expect.objectContaining({ transactions: txs }))
  })

  test('a bounty recovery failure stays best-effort and never blocks the cursor write', async () => {
    const { reconcileBountyReceipts } = require('../../api/monero/bountyReceipts')
    const { logError } = require('../../lib/logger')
    const { alert } = require('../../lib/alert')
    const { account, models } = buildFixture({ initialCursor: 9n })
    reconcileBountyReceipts.mockRejectedValueOnce(new Error('recovery failed'))
    const lws = {
      getAddressTxs: jest.fn(async () => ({
        blockchain_height: 101, transactions: [minedFee(10)]
      }))
    }
    await rewardsWalletObserver({ models, lws, detectReorg: jest.fn() })
    expect(logError).toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('critical', 'bounty receipt recovery failed', expect.any(String), expect.anything())
    expect(account.lastTxId).toBe(10n)
  })
})
