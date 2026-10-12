/* eslint-env jest */
// Retry policy: every retry-safe boss.send seed and self-requeue spreads
// BOSS_RETRY; money handlers that are not retry-safe opt out explicitly (see
// rewardsDistributor below). payWeeklyPostBounty must claim via CAS (no
// read-then-pay).
//
// STEP 1 AUDIT — idempotency verdicts (full evidence in
// .superpowers/sdd/task-4-report.md):
//   - payWeeklyPostBounty (worker/weeklyPosts.js): NOT idempotent
//     (read-then-pay TOCTOU) -> CAS claim added. NOTE: this repo has NO
//     Item.bountyPaidTo column — A-13 replaced it with bountyWinnerCommentId
//     (prisma/schema.prisma). The claim conditionally sets
//     bountyWinnerCommentId, mirroring the payBounty claim transaction in
//     api/resolvers/bounty.js:190-197 (single-writer domain; the api/ TIP
//     payIn flow never writes it). -> retries ON.
//   - territoryBilling (worker/territory.js:48 `nextStatus !== sub.status`;
//     lapse path writes a terminal LAPSED/STOPPED so a re-run diverges):
//     re-run safe -> retries ON.
//   - confirmFinalizer (worker/confirmFinalizer.js:91-94 conditional UPDATE
//     ... WHERE state = 'DETECTED' inside a Serializable tx): claimed-CAS
//     verified -> retries ON.
//   - reconcilePendingTips (worker/reconcilePendingTips.js:89-93 conditional
//     UPDATE ... WHERE state = 'PENDING' inside a Serializable tx): verified
//     -> retries ON.
//   - rewardsWalletObserver (worker/rewardsWalletObserver.js:325 lastTxId
//     cursor + ON CONFLICT DO NOTHING ... RETURNING idempotency on every
//     insert): verified -> retries ON.
//   - bounties (worker/bounties.js -> api/monero/escrowTransactions.js
//     sendBountyPayments): payout dispatch is now capture-barrier protected —
//     durable journal+proof pair, DB-only attempt CAS, relay never inside a
//     retried transaction; a mid-dispatch interruption leaves the leg
//     withheld for reconciliation (retryLimit stays 0: an immediate job retry
//     would only re-scan the same sweep, the next cron tick re-runs it with
//     fresh state).
//   - dbBackup: cron-owned (pgboss.schedule migration
//     20260808160000_schedule_db_backup) — left as-is this pass; handler-side
//     alerts + nightly cadence cover failures, and a rerun is harmless
//     (overwrites same-night file).
//   - rewardsDistributor: cron-owned, but deliberately retry-free — a retried
//     distribution could double-pay, so every rewards job carries
//     expireInHours 4, retryLimit 0, retryDelay 0, retryBackoff false
//     (worker/rewardsDistributorSchedule.js; migration
//     20261012100100_rewards_job_execution_budget). It must NOT spread
//     BOSS_RETRY: even a nonzero retryDelay alone would imply a retry in
//     pg-boss 9.
//   - Not audited, out of scope this pass (still default retryLimit 0):
//     webhookCleanup, rotateViewKeys, search indexAllItems.
import { BOSS_RETRY } from '@/lib/constants'
import { datePivot } from '@/lib/time'

// weeklyPosts transitively imports @/api/payIn, whose itemCreate type pulls
// ESM-only markdown deps jest cannot transform. The DI `pay` param means the
// default export is never invoked by these tests — mock the module outright.
jest.mock('../../api/payIn', () => ({ __esModule: true, default: jest.fn() }))

const makeBoss = () => {
  const sends = []
  return {
    sends,
    send: async (name, data, opts) => { sends.push({ name, data, opts }) },
    getQueueSize: async () => 0,
    work: async () => {}
  }
}

describe('BOSS_RETRY', () => {
  it('is frozen with retryLimit 3 and backoff', () => {
    expect(BOSS_RETRY.retryLimit).toBe(3)
    expect(BOSS_RETRY.retryBackoff).toBe(true)
    expect(Object.isFrozen(BOSS_RETRY)).toBe(true)
  })
})

describe('territoryBilling self-requeue', () => {
  it('spreads BOSS_RETRY into requeue sends', async () => {
    const boss = makeBoss()
    // "paid up" early-return branch (worker/territory.js:39-42): a future
    // billPaidUntil re-sends without touching webPush — exactly the retry-opts
    // surface under test (the PENDING_FEE lapse branch couples to
    // notifyTerritoryStatusChange and needs real models).
    const sub = {
      name: 'test-sub',
      billingType: 'MONTHLY',
      billingStatus: 'PAID',
      billPaidUntil: datePivot(new Date(), { days: 30 }),
      billingPayIn: null,
      user: { id: 1 }
    }
    const models = {
      sub: {
        findUnique: async () => sub,
        update: async () => sub
      }
    }
    const { territoryBilling } = await import('@/worker/territory')
    await territoryBilling({ data: { subName: 'test-sub' }, boss, models })
    expect(boss.sends.length).toBe(1)
    expect(boss.sends[0].opts.retryLimit).toBe(3)
    expect(boss.sends[0].opts.retryBackoff).toBe(true)
    expect(boss.sends[0].opts.startAfter).toEqual(new Date(sub.billPaidUntil))
  })
})

describe('payWeeklyPostBounty CAS', () => {
  const makeApollo = (item) => ({
    query: async () => ({ data: { item } })
  })

  it('pays exactly once when the conditional claim succeeds', async () => {
    const { payWeeklyPostBounty } = await import('@/worker/weeklyPosts')
    const claims = []
    const models = {
      item: {
        updateMany: async (args) => {
          claims.push(args)
          return { count: 1 }
        }
      }
    }
    const winner = { id: 42 }
    const apollo = makeApollo({
      userId: 1,
      bounty: 1000,
      bountyWinnerCommentId: null,
      comments: { comments: [winner] }
    })
    let paid = 0
    await payWeeklyPostBounty({ data: { id: 7 }, models, apollo, pay: async () => { paid++ } })
    expect(paid).toBe(1)
    expect(claims.length).toBe(1)
    // claim BEFORE pay, conditional on no winner recorded yet (and not
    // escrow-FUNDED — see the dedicated guard test below)
    expect(claims[0].where).toEqual({ id: 7, bountyWinnerCommentId: null, bountyStatus: { not: 'FUNDED' } })
    expect(claims[0].data).toEqual({ bountyWinnerCommentId: 42 })
  })

  it('never claims an escrow-FUNDED bounty (bountyStatus guard mirrors payBounty)', async () => {
    const { payWeeklyPostBounty } = await import('@/worker/weeklyPosts')
    // payBounty's claim (api/resolvers/bounty.js:191-194) only fires on
    // bountyStatus = 'FUNDED'; this claim must exclude exactly that state so
    // the two predicates can never both fire on the same row.
    const claims = []
    const models = {
      item: {
        updateMany: async (args) => {
          claims.push(args)
          return { count: 1 }
        }
      }
    }
    const apollo = makeApollo({
      userId: 1,
      bounty: 1000,
      bountyWinnerCommentId: null,
      comments: { comments: [{ id: 42 }] }
    })
    await payWeeklyPostBounty({ data: { id: 7 }, models, apollo, pay: async () => {} })
    expect(claims.length).toBe(1)
    expect(claims[0].where.bountyStatus).toEqual({ not: 'FUNDED' })
  })

  it('throws "payout may be stranded" and never pays when the claim is denied', async () => {
    const { payWeeklyPostBounty } = await import('@/worker/weeklyPosts')
    let claimed = 0
    const models = {
      item: {
        updateMany: async () => { claimed++; return { count: 0 } }
      }
    }
    const winner = { id: 42 }
    const apollo = makeApollo({
      userId: 1,
      bounty: 1000,
      bountyWinnerCommentId: null,
      comments: { comments: [winner] }
    })
    let paid = 0
    // a prior successful claim (ours or payBounty's) lost the race AFTER the
    // precheck passed — the custodial payout needs manual reconciliation
    await expect(
      payWeeklyPostBounty({ data: { id: 7 }, models, apollo, pay: async () => { paid++ } })
    ).rejects.toThrow('Bounty claim lost — payout may be stranded and needs manual reconciliation')
    expect(claimed).toBe(1) // the denied path DID attempt the claim, then stopped
    expect(paid).toBe(0)
  })

  it('throws before claiming when a winner is already recorded', async () => {
    const { payWeeklyPostBounty } = await import('@/worker/weeklyPosts')
    let claimed = 0
    const models = {
      item: {
        updateMany: async () => { claimed++; return { count: 1 } }
      }
    }
    const apollo = makeApollo({
      userId: 1,
      bounty: 1000,
      bountyWinnerCommentId: 42,
      comments: { comments: [{ id: 43 }] }
    })
    let paid = 0
    // precheck (bountyWinnerCommentId already set) keeps the plain message —
    // distinct from the claim-denied stranded message above
    await expect(
      payWeeklyPostBounty({ data: { id: 7 }, models, apollo, pay: async () => { paid++ } })
    ).rejects.toThrow('Bounty already paid')
    expect(claimed).toBe(0) // precheck short-circuits before the claim
    expect(paid).toBe(0)
  })
})
