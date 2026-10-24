/* eslint-env jest */

// Isolated-DB integration tests for confirmed bounty-arrival attribution and
// the bounded cursor-miss recovery pass (Task 4, rewards accounting repair §4).
//
// The rewards hot wallet books bounty revenue ONLY from a verified incoming
// output on the platform rewards wallet that matches the frozen escrow
// settlement on BountyPayment (Task 3): the exact settlement tx hash (txHash,
// or feeTxHash for a legacy separate fee), the frozen destination, and the
// captured net amount. Relay/funding write no cash row (Tasks 2/3) — these
// receipts are the only new bounty revenue rows.
//
// Runs only in the dedicated isolated runner (DATABASE_URL pathname
// /stasher_rewards_repair_test); the whole suite is skipped by default anywhere
// else so an ordinary dev-DB run neither touches real rows nor fails to
// collect. Run via: ./sndev test test/worker/rewardsWalletObserver.bounty.test.js

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { runRewardsWalletObserverOnce, rewardsWalletObserver } from '@/worker/rewardsWalletObserver'
import { runConfirmFinalizerOnce } from '@/worker/confirmFinalizer'
import { reconcileBountyReceipts, __resetBountyRecoveryCursor } from '@/api/monero/bountyReceipts'
import { alert } from '@/lib/alert'
import { sweepFakeRewardsWallets } from '../helpers/sweepRewardsWallets'

jest.mock('../../lib/alert', () => ({ __esModule: true, alert: jest.fn() }))

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

const prisma = new PrismaClient()

const REWARDS_ADDR = '5RpnlBountyObs' + 'F'.repeat(85) // unique placeholder; never decoded
const COLD_ADDR = '5ColdAwardFee' + 'G'.repeat(86) // deliberately NOT the rewards address
const WINNER_ADDR = '5WinnerBounty' + 'H'.repeat(85)
const NETWORK = (process.env.MONERO_NETWORK || 'STAGENET').toUpperCase()

const created = { users: [], items: [], accounts: [], payouts: [], txHashes: [] }
let rewardsWallet

const txHash = () => randomUUID().replaceAll('-', '')

// A verified incoming output as the lws scan reports it (parseTx shape).
function lwsIncoming ({ hash, piconeros, height = 700, id = 1, major = 0, minor = 0 }) {
  return { hash, piconeros: BigInt(piconeros), recipient: { maj_i: major, min_i: minor }, height, id, payment_id: null }
}

;(ISOLATED_DB ? describe : describe.skip)('bounty receipt attribution (isolated DB only)', () => {
  beforeAll(async () => {
    // This suite is the sole writer on its dedicated DB. Clear any leaked
    // BountyPayment rows from a crashed prior run so the bounded-window
    // ordering assertions below are deterministic.
    await prisma.bountyPayment.deleteMany({})
    await sweepFakeRewardsWallets([REWARDS_ADDR])
    rewardsWallet = await prisma.moneroAccount.create({
      data: { ownerUserId: null, address: REWARDS_ADDR, label: 'platform_rewards', network: NETWORK, status: 'ACTIVE' }
    })
    created.accounts.push(rewardsWallet.id)
    // findRewardsAccount (the handler) requires a viewKey relation; the lws
    // client is injected in handler tests, so the dummy envelope is never
    // decrypted.
    await prisma.moneroViewKey.create({
      data: {
        accountId: rewardsWallet.id,
        ciphertext: Buffer.alloc(1),
        iv: Buffer.alloc(12),
        tag: Buffer.alloc(16),
        wrappedDek: Buffer.alloc(1),
        dekVersion: 0
      }
    })
  })

  beforeEach(() => {
    alert.mockClear()
    // The recovery rotation cursor is process-local; reset it so each test's
    // bounded passes start from the oldest candidate deterministically.
    __resetBountyRecoveryCursor()
  })

  afterEach(async () => {
    await prisma.feeObservation.deleteMany({ where: { txHash: { in: created.txHashes } } })
    await prisma.feeObservation.deleteMany({ where: { postId: { in: created.items } } })
    await prisma.bountyPayment.deleteMany({ where: { id: { in: created.payouts } } })
    await prisma.subaddressIndex.deleteMany({ where: { accountId: rewardsWallet.id } })
    if (created.items.length) await prisma.item.deleteMany({ where: { id: { in: created.items } } })
    if (created.users.length) await prisma.user.deleteMany({ where: { id: { in: created.users } } })
    created.users.length = 0
    created.items.length = 0
    created.payouts.length = 0
    created.txHashes.length = 0
    await prisma.moneroAccount.update({ where: { id: rewardsWallet.id }, data: { lastTxId: null } })
  })

  afterAll(async () => {
    await sweepFakeRewardsWallets([REWARDS_ADDR])
    if (created.accounts.length) await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
    await prisma.$disconnect()
  })

  async function createUser () {
    const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    created.users.push(rows[0].id)
    return rows[0].id
  }

  async function createBountyItem ({ bookedPiconeros = 100n } = {}) {
    const userId = await createUser()
    const item = await prisma.item.create({
      data: { userId, title: 'bounty receipt target', status: 'ACTIVE', bountyPiconeros: bookedPiconeros, bountyStatus: 'FUNDED' }
    })
    created.items.push(item.id)
    return item
  }

  async function seedPayout (data) {
    const payout = await prisma.bountyPayment.create({
      data: { state: 'SENT', kind: 'ROLLOVER', feePiconeros: 0n, ...data }
    })
    created.payouts.push(payout.id)
    return payout
  }

  // A SENT rollover of a 100-piconero booked prize whose signed tx sent 140
  // (prize + frozen fee) and whose actual net destination received 139.
  async function seedRollover ({ bookedPiconeros = 100n, recipientReceivedPiconeros = 139n } = {}) {
    const item = await createBountyItem({ bookedPiconeros })
    const hash = txHash()
    const payout = await seedPayout({
      itemId: item.id,
      winnerUserId: item.userId,
      kind: 'ROLLOVER',
      txHash: hash,
      recipientAddress: REWARDS_ADDR,
      piconeros: 140n,
      recipientReceivedPiconeros
    })
    created.txHashes.push(hash)
    return { item, payout, hash }
  }

  test('a verified hot rollover output books one DETECTED BOUNTY_ROLLOVER receipt with the exact split; replay inserts no second row', async () => {
    const { item, hash } = await seedRollover()
    const tx = lwsIncoming({ hash, piconeros: 139n, height: 700 })

    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })

    const rows = await prisma.feeObservation.findMany({ where: { txHash: hash } })
    expect(rows).toHaveLength(1)
    expect(rows[0].feeType).toBe('BOUNTY_ROLLOVER')
    expect(rows[0].walletReceipt).toBe(true)
    expect(rows[0].state).toBe('DETECTED')
    expect(rows[0].piconeros).toBe(139n)
    expect(rows[0].rewardsPiconeros).toBe(100n)
    expect(rows[0].height).toBe(700)
    expect(rows[0].recipientMajor).toBe(0)
    expect(rows[0].recipientMinor).toBe(0)
    expect(rows[0].postId).toBe(item.id)
    expect(rows[0].payInId).toBeNull()

    // Replay: the (txHash, major, minor) unique key makes it a no-op.
    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })
    const after = await prisma.feeObservation.findMany({ where: { txHash: hash } })
    expect(after).toHaveLength(1)
    expect(after[0].piconeros).toBe(139n)
    expect(after[0].rewardsPiconeros).toBe(100n)
  })

  test('a mempool sight is provisional (height NULL); a replay backfills the height without inflating the amount or resetting CONFIRMED', async () => {
    const { hash } = await seedRollover()

    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 139n, height: null })] })
    let row = await prisma.feeObservation.findFirst({ where: { txHash: hash } })
    expect(row).toBeTruthy()
    expect(row.height).toBeNull()

    // Mined: the replay backfills the verified height.
    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 139n, height: 700 })] })
    row = await prisma.feeObservation.findFirst({ where: { txHash: hash } })
    expect(row.height).toBe(700)
    expect(row.piconeros).toBe(139n)

    // CONFIRMED rows are never reset or rewritten by a later replay.
    await prisma.feeObservation.update({ where: { id: row.id }, data: { state: 'CONFIRMED', confirmations: 10, confirmedAt: new Date() } })
    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 139n, height: 701 })] })
    row = await prisma.feeObservation.findFirst({ where: { txHash: hash } })
    expect(row.state).toBe('CONFIRMED')
    expect(row.piconeros).toBe(139n)
    expect(row.rewardsPiconeros).toBe(100n)
    expect(row.height).toBe(700) // a replay never rewrites a recorded height
  })

  test('a verified hot award fee books BOUNTY_FEE 100% ops at the actual net amount', async () => {
    const item = await createBountyItem()
    const hash = txHash()
    await seedPayout({
      itemId: item.id,
      winnerUserId: item.userId,
      kind: 'AWARD',
      txHash: hash,
      recipientAddress: WINNER_ADDR,
      piconeros: 100n,
      feePiconeros: 40n,
      feeRecipientAddress: REWARDS_ADDR,
      recipientReceivedPiconeros: 100n,
      feeReceivedPiconeros: 39n
    })
    created.txHashes.push(hash)

    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 39n, height: 700 })] })

    const row = await prisma.feeObservation.findFirst({ where: { txHash: hash } })
    expect(row.feeType).toBe('BOUNTY_FEE')
    expect(row.walletReceipt).toBe(true)
    expect(row.piconeros).toBe(39n)
    expect(row.rewardsPiconeros).toBe(0n)
    expect(row.state).toBe('DETECTED')
    expect(row.height).toBe(700)
    expect(row.postId).toBe(item.id)
  })

  test('an equal-amount output at the wrong receiving index defers with an alert and books no eligible row', async () => {
    const { hash } = await seedRollover()

    // The frozen destination is the primary address: only (0, 0) identifies it.
    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 139n, height: 700, major: 0, minor: 3 })] })

    expect(await prisma.feeObservation.count({ where: { txHash: hash } })).toBe(0)
    expect(alert).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/index/i),
      expect.stringContaining(hash),
      { dedupeKey: `bounty-receipt-index-mismatch-${hash}` })

    // The correctly indexed sight then books.
    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 139n, height: 700 })] })
    const rows = await prisma.feeObservation.findMany({ where: { txHash: hash } })
    expect(rows).toHaveLength(1)
    expect(rows[0].recipientMajor).toBe(0)
    expect(rows[0].recipientMinor).toBe(0)
  })

  test('a settlement frozen to a rewards subaddress books only at that exact index', async () => {
    const SUB_ADDR = '5SubaddrBounty' + 'J'.repeat(81)
    await prisma.subaddressIndex.create({
      data: { accountId: rewardsWallet.id, majorIndex: 1, minorIndex: 7, address: SUB_ADDR, state: 'ASSIGNED' }
    })
    const item = await createBountyItem()
    const hash = txHash()
    await seedPayout({
      itemId: item.id,
      winnerUserId: item.userId,
      kind: 'AWARD',
      txHash: hash,
      recipientAddress: WINNER_ADDR,
      piconeros: 100n,
      feePiconeros: 40n,
      feeRecipientAddress: SUB_ADDR,
      recipientReceivedPiconeros: 100n,
      feeReceivedPiconeros: 39n
    })
    created.txHashes.push(hash)

    // Equal amount, wrong index: refused, alerted, no eligible row.
    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 39n, height: 700 })] })
    expect(await prisma.feeObservation.count({ where: { txHash: hash } })).toBe(0)
    expect(alert).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/index/i),
      expect.stringContaining(hash),
      { dedupeKey: `bounty-receipt-index-mismatch-${hash}` })

    // The exact frozen subaddress index is the only accepted sight.
    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 39n, height: 700, major: 1, minor: 7 })] })
    const row = await prisma.feeObservation.findFirst({ where: { txHash: hash } })
    expect(row).toBeTruthy()
    expect(row.piconeros).toBe(39n)
    expect(row.recipientMajor).toBe(1)
    expect(row.recipientMinor).toBe(7)
  })

  test('a cold-destination award fee cannot book a hot receipt: no row and a deferral alert', async () => {
    const item = await createBountyItem()
    const hash = txHash()
    await seedPayout({
      itemId: item.id,
      winnerUserId: item.userId,
      kind: 'AWARD',
      txHash: hash,
      recipientAddress: WINNER_ADDR,
      piconeros: 100n,
      feePiconeros: 40n,
      feeRecipientAddress: COLD_ADDR,
      recipientReceivedPiconeros: 100n,
      feeReceivedPiconeros: 39n
    })
    created.txHashes.push(hash)

    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 39n, height: 700 })] })

    expect(await prisma.feeObservation.count({ where: { txHash: hash } })).toBe(0)
    // The frozen destination resolves to no rewards-wallet address: defer and
    // alert rather than guessing that the arrival is this settlement.
    expect(alert).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/deferred/i),
      expect.stringContaining(hash),
      { dedupeKey: `bounty-receipt-deferred-${hash}` })
  })

  test('an unrelated primary-address receipt (fee-account self-consolidation) books nothing', async () => {
    const hash = txHash()
    created.txHashes.push(hash)

    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 5n, height: 700 })] })

    expect(await prisma.feeObservation.count({ where: { txHash: hash } })).toBe(0)
    expect(alert).not.toHaveBeenCalled()
  })

  test('an amount mismatch against the captured settlement defers with an alert and no eligible row; the verified sight then books', async () => {
    const { hash } = await seedRollover()

    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 138n, height: 700 })] })

    expect(await prisma.feeObservation.count({ where: { txHash: hash } })).toBe(0)
    expect(alert).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/mismatch/i),
      expect.stringContaining(hash),
      { dedupeKey: `bounty-receipt-mismatch-${hash}` })

    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 139n, height: 700 })] })
    const rows = await prisma.feeObservation.findMany({ where: { txHash: hash } })
    expect(rows).toHaveLength(1)
    expect(rows[0].piconeros).toBe(139n)
  })

  test('a hot sight whose escrow settlement scan is missing defers with an alert and books nothing', async () => {
    const { hash } = await seedRollover({ recipientReceivedPiconeros: null })

    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [lwsIncoming({ hash, piconeros: 139n, height: 700 })] })

    expect(await prisma.feeObservation.count({ where: { txHash: hash } })).toBe(0)
    expect(alert).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/deferred/i),
      expect.stringContaining(hash),
      { dedupeKey: `bounty-receipt-deferred-${hash}` })
  })

  test('a sight without a receiving index is refused, never booked as a fabricated 0/0', async () => {
    const { hash } = await seedRollover()
    const tx = lwsIncoming({ hash, piconeros: 139n, height: 700 })
    delete tx.recipient

    await runRewardsWalletObserverOnce({ models: prisma, account: rewardsWallet, txs: [tx] })

    expect(await prisma.feeObservation.count({ where: { txHash: hash } })).toBe(0)
    expect(alert).not.toHaveBeenCalled()
  })

  test('reconcile recovers a legacy separate feeTxHash receipt even though the payout is CONFIRMED', async () => {
    const item = await createBountyItem()
    const prizeHash = txHash()
    const feeHash = txHash()
    await seedPayout({
      itemId: item.id,
      winnerUserId: item.userId,
      kind: 'AWARD',
      state: 'CONFIRMED',
      txHash: prizeHash,
      feeTxHash: feeHash,
      recipientAddress: WINNER_ADDR,
      piconeros: 100n,
      feePiconeros: 6n,
      feeRecipientAddress: REWARDS_ADDR,
      recipientReceivedPiconeros: 100n,
      feeReceivedPiconeros: 5n
    })
    created.txHashes.push(feeHash)

    const attributed = await reconcileBountyReceipts({
      models: prisma,
      account: rewardsWallet,
      transactions: [lwsIncoming({ hash: feeHash, piconeros: 5n, height: 701 })]
    })

    expect(attributed).toBe(1)
    const row = await prisma.feeObservation.findFirst({ where: { txHash: feeHash } })
    expect(row.feeType).toBe('BOUNTY_FEE')
    expect(row.walletReceipt).toBe(true)
    expect(row.state).toBe('DETECTED')
    expect(row.piconeros).toBe(5n)
    expect(row.rewardsPiconeros).toBe(0n)
    expect(row.height).toBe(701)
    expect(row.postId).toBe(item.id)
  })

  test('a receipt missed because the sender persisted settlement metadata after the sight is recovered despite the advanced cursor', async () => {
    const { payout, hash } = await seedRollover({ recipientReceivedPiconeros: null })
    const incoming = lwsIncoming({ hash, piconeros: 139n, height: 700, id: 10 })
    // The output was already scanned (its id sits below the forward cursor)
    // before the sender's settlement persist landed: fresh dispatch can no
    // longer see it.
    await prisma.moneroAccount.update({ where: { id: rewardsWallet.id }, data: { lastTxId: 50n } })
    const lws = { getAddressTxs: jest.fn().mockResolvedValue({ transactions: [incoming], blockchain_height: 800 }) }

    await rewardsWalletObserver({ models: prisma, lws, rawReader: null })

    expect(await prisma.feeObservation.count({ where: { txHash: hash } })).toBe(0)
    expect(alert).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/deferred/i),
      expect.stringContaining(hash),
      { dedupeKey: `bounty-receipt-deferred-${hash}` })
    expect((await prisma.moneroAccount.findUnique({ where: { id: rewardsWallet.id } })).lastTxId).toBe(50n)

    // Metadata lands; the next poll's full-history recovery pass books the
    // receipt even though the cursor stays past the output.
    await prisma.bountyPayment.update({ where: { id: payout.id }, data: { recipientReceivedPiconeros: 139n } })
    await rewardsWalletObserver({ models: prisma, lws, rawReader: null })

    const rows = await prisma.feeObservation.findMany({ where: { txHash: hash } })
    expect(rows).toHaveLength(1)
    expect(rows[0].piconeros).toBe(139n)
    expect(rows[0].rewardsPiconeros).toBe(100n)
    expect(rows[0].height).toBe(700)
    expect(rows[0].walletReceipt).toBe(true)
    expect((await prisma.moneroAccount.findUnique({ where: { id: rewardsWallet.id } })).lastTxId).toBe(50n)
  })

  test('confirmFinalizer backfills heights and matures ONLY walletReceipt=true fee observations', async () => {
    const item = await createBountyItem()
    const hashes = {
      ineligibleMature: txHash(),
      eligibleMature: txHash(),
      ineligibleNull: txHash(),
      eligibleNull: txHash()
    }
    await prisma.feeObservation.createMany({
      data: [
        { txHash: hashes.ineligibleMature, feeType: 'BOUNTY_FEE', postId: item.id, recipientMajor: 0, recipientMinor: 0, piconeros: 5n, height: 700, state: 'DETECTED', walletReceipt: false },
        { txHash: hashes.eligibleMature, feeType: 'BOUNTY_FEE', postId: item.id, recipientMajor: 0, recipientMinor: 0, piconeros: 5n, height: 700, state: 'DETECTED', walletReceipt: true },
        { txHash: hashes.ineligibleNull, feeType: 'BOUNTY_FEE', postId: item.id, recipientMajor: 0, recipientMinor: 0, piconeros: 5n, height: null, state: 'DETECTED', walletReceipt: false },
        { txHash: hashes.eligibleNull, feeType: 'BOUNTY_FEE', postId: item.id, recipientMajor: 0, recipientMinor: 0, piconeros: 5n, height: null, state: 'DETECTED', walletReceipt: true }
      ]
    })
    created.txHashes.push(...Object.values(hashes))
    // The lws scan CAN resolve both NULL-height rows; only the eligible one
    // may be touched (a walletReceipt=false accrual row is historical
    // evidence, never matured into a hot-wallet consumer sum).
    const lws = {
      getAddressTxs: jest.fn().mockResolvedValue({
        transactions: [
          { hash: hashes.ineligibleNull, height: 701, piconeros: 5n },
          { hash: hashes.eligibleNull, height: 702, piconeros: 5n }
        ],
        blockchain_height: 709
      })
    }

    await runConfirmFinalizerOnce({
      models: prisma,
      daemonClient: { getHeight: async () => 709 },
      lwsClient: lws
    })

    const rows = Object.fromEntries(
      (await prisma.feeObservation.findMany({ where: { txHash: { in: Object.values(hashes) } } })).map(r => [r.txHash, r])
    )
    // height-set ineligible row: never matured
    expect(rows[hashes.ineligibleMature].state).toBe('DETECTED')
    // height-set eligible row: mature at REQUIRED_CONFIRMATIONS (10)
    expect(rows[hashes.eligibleMature].state).toBe('CONFIRMED')
    expect(rows[hashes.eligibleMature].confirmations).toBe(10)
    // NULL-height ineligible row: never even backfilled
    expect(rows[hashes.ineligibleNull].height).toBeNull()
    expect(rows[hashes.ineligibleNull].state).toBe('DETECTED')
    // NULL-height eligible row: backfilled (8 confs, stays DETECTED this run)
    expect(rows[hashes.eligibleNull].height).toBe(702)
    expect(rows[hashes.eligibleNull].state).toBe('DETECTED')
  })

  test('bounded recovery processes more than 100 pending candidates oldest-first across two calls', async () => {
    const item = await createBountyItem()
    const COUNT = 102
    const payouts = []
    for (let i = 0; i < COUNT; i++) {
      payouts.push({
        itemId: item.id,
        winnerUserId: item.userId,
        kind: 'AWARD',
        state: 'SENT',
        txHash: txHash(),
        recipientAddress: WINNER_ADDR,
        piconeros: 100n,
        feePiconeros: 5n,
        feeRecipientAddress: REWARDS_ADDR,
        recipientReceivedPiconeros: 100n,
        feeReceivedPiconeros: 5n
      })
    }
    await prisma.bountyPayment.createMany({ data: payouts })
    const rows = await prisma.bountyPayment.findMany({
      where: { txHash: { in: payouts.map(p => p.txHash) } },
      orderBy: { id: 'asc' },
      select: { id: true, txHash: true }
    })
    created.payouts.push(...rows.map(r => r.id))
    created.txHashes.push(...rows.map(r => r.txHash))
    const transactions = rows.map((r, i) => lwsIncoming({ hash: r.txHash, piconeros: 5n, height: 700 + i }))

    const first = await reconcileBountyReceipts({ models: prisma, account: rewardsWallet, transactions })
    expect(first).toBe(100)

    const afterFirst = await prisma.feeObservation.findMany({
      where: { txHash: { in: rows.map(r => r.txHash) } },
      select: { txHash: true }
    })
    // The bounded window is the 100 OLDEST candidates; the two newest wait.
    expect(new Set(afterFirst.map(r => r.txHash))).toEqual(new Set(rows.slice(0, 100).map(r => r.txHash)))

    const second = await reconcileBountyReceipts({ models: prisma, account: rewardsWallet, transactions })
    expect(second).toBe(2)
    expect(await prisma.feeObservation.count({ where: { txHash: { in: rows.map(r => r.txHash) } } })).toBe(COUNT)
  })

  test('bounded recovery rotates past an unbookable oldest window so later recoverable receipts are not starved', async () => {
    const item = await createBountyItem()
    const STUCK = 100 // an entire bounded window whose settlement metadata never lands
    const stuck = []
    for (let i = 0; i < STUCK; i++) {
      stuck.push({
        itemId: item.id,
        winnerUserId: item.userId,
        kind: 'ROLLOVER',
        state: 'SENT',
        txHash: txHash(),
        recipientAddress: REWARDS_ADDR,
        piconeros: 140n,
        recipientReceivedPiconeros: null // unbookable: defers every pass
      })
    }
    const good = []
    for (let i = 0; i < 2; i++) {
      good.push({
        itemId: item.id,
        winnerUserId: item.userId,
        kind: 'ROLLOVER',
        state: 'SENT',
        txHash: txHash(),
        recipientAddress: REWARDS_ADDR,
        piconeros: 140n,
        recipientReceivedPiconeros: 139n // recoverable
      })
    }
    await prisma.bountyPayment.createMany({ data: [...stuck, ...good] })
    const rows = await prisma.bountyPayment.findMany({
      where: { txHash: { in: [...stuck, ...good].map(p => p.txHash) } },
      orderBy: { id: 'asc' },
      select: { id: true, txHash: true }
    })
    created.payouts.push(...rows.map(r => r.id))
    created.txHashes.push(...rows.map(r => r.txHash))
    const stuckHashes = rows.slice(0, STUCK).map(r => r.txHash)
    const goodHashes = rows.slice(STUCK).map(r => r.txHash)
    const transactions = rows.map(r => lwsIncoming({ hash: r.txHash, piconeros: 139n, height: 700 }))

    // Pass 1: the bounded oldest window is entirely unbookable.
    const first = await reconcileBountyReceipts({ models: prisma, account: rewardsWallet, transactions })
    expect(first).toBe(0)
    expect(await prisma.feeObservation.count({ where: { txHash: { in: stuckHashes } } })).toBe(0)

    // Pass 2: rotation advances past the stuck window instead of re-selecting
    // it forever — the two later recoverable receipts book.
    const second = await reconcileBountyReceipts({ models: prisma, account: rewardsWallet, transactions })
    expect(second).toBe(2)
    expect(new Set((await prisma.feeObservation.findMany({ where: { txHash: { in: goodHashes } }, select: { txHash: true } })).map(r => r.txHash)))
      .toEqual(new Set(goodHashes))
  })

  test('composite leg cursor reaches a recoverable fee leg whose payout is split across a bounded window boundary', async () => {
    const item = await createBountyItem()
    // 99 deferred single-leg candidates fill the bounded window ahead of the
    // split payout, so the 100th row is the payout's FIRST leg.
    const stuck = []
    for (let i = 0; i < 99; i++) {
      stuck.push({
        itemId: item.id,
        winnerUserId: item.userId,
        kind: 'ROLLOVER',
        state: 'SENT',
        txHash: txHash(),
        recipientAddress: REWARDS_ADDR,
        piconeros: 140n,
        recipientReceivedPiconeros: null // unbookable: defers every pass
      })
    }
    // The split payout: its prize-tx leg defers (equal amount, but the observed
    // index does not match the frozen primary destination), while its legacy
    // separate feeTxHash leg is fully recoverable. 'aa…' < 'bb…' orders the
    // deferred prize leg FIRST within the payout id — exactly where the
    // bounded window ends.
    const prizeHash = 'aa'.repeat(32)
    const feeHash = 'bb'.repeat(32)
    await prisma.bountyPayment.createMany({
      data: [...stuck, {
        itemId: item.id,
        winnerUserId: item.userId,
        kind: 'AWARD',
        state: 'SENT',
        txHash: prizeHash,
        feeTxHash: feeHash,
        recipientAddress: WINNER_ADDR,
        piconeros: 100n,
        feePiconeros: 6n,
        feeRecipientAddress: REWARDS_ADDR,
        recipientReceivedPiconeros: 100n,
        feeReceivedPiconeros: 5n
      }]
    })
    const rows = await prisma.bountyPayment.findMany({
      where: { txHash: { in: [...stuck.map(p => p.txHash), prizeHash] } },
      orderBy: { id: 'asc' },
      select: { id: true, txHash: true }
    })
    created.payouts.push(...rows.map(r => r.id))
    created.txHashes.push(...rows.map(r => r.txHash), feeHash)
    const transactions = [
      ...rows.slice(0, 99).map(r => lwsIncoming({ hash: r.txHash, piconeros: 139n, height: 700 })),
      lwsIncoming({ hash: prizeHash, piconeros: 5n, height: 700, major: 0, minor: 3 }), // wrong index -> defers
      lwsIncoming({ hash: feeHash, piconeros: 5n, height: 700 }) // right index -> recoverable
    ]

    // Pass 1: the window is the 99 stuck legs + the payout's first (deferred)
    // leg. Nothing books.
    const first = await reconcileBountyReceipts({ models: prisma, account: rewardsWallet, transactions })
    expect(first).toBe(0)

    // Pass 2: the composite (id, hash) axis reaches the fee leg on the other
    // side of the boundary — booked within one full cycle, never starved.
    const second = await reconcileBountyReceipts({ models: prisma, account: rewardsWallet, transactions })
    expect(second).toBe(1)
    const feeRow = await prisma.feeObservation.findFirst({ where: { txHash: feeHash } })
    expect(feeRow).toBeTruthy()
    expect(feeRow.feeType).toBe('BOUNTY_FEE')
    expect(feeRow.piconeros).toBe(5n)
    expect(await prisma.feeObservation.count({ where: { txHash: prizeHash } })).toBe(0)
  })
})
