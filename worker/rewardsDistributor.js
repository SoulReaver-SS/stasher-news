import { Prisma } from '@prisma/client'
import createPrisma from '@/lib/create-prisma'
import { computeCuratorShares, effectiveTrustWeightFloor } from './curatorShares'
import { sendPayouts as defaultSendPayouts, getRewardsWallet } from '@/api/monero/rewards'
import { reconcileWalletTransactions, errorLabel } from '@/api/monero/rewardsTransactions'
import logger, { logInfo, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { moneroDistributionStatus } from '@/lib/metrics'
import { opsCarry, walletScope, WEEKLY_CURATOR_CAP_PICONEROS } from '@/lib/rewardsAccounting'
import { readRewardsInflow } from '@/api/monero/rewardsInflow'
import { readRewardsWalletLedger } from '@/api/monero/rewardsLedger'
import { withRewardsPhase } from './rewardsPhase'

// rewardsDistributor — StasherNews' weekly rewards-pool distribution job
// (Phase 4 Task 8 / design spec §5, §6.2). Each week it:
//
//   1. tallies CONFIRMED platform-wallet inflow by source (downvotes +
//      posting/territory fees) for the period;
//   2. applies the PlatformFeeConfig allocation split to get the rewards earmark;
//   3. adds the prior period's rolledOverPiconeros to form the pool;
//   4. calls computeCuratorShares (Task 7) to apportion up to 0.6 XMR to the
//      curators (tippers) of the period's top content;
//   5. writes one RewardDistribution row + one QUEUED RewardPayout per curator
//      who has a registered receiving address. Curators with no address are
//      excluded — their share joins the rollover.
//
// The actual on-chain signing/sending is Task 9's hot-wallet signer
// (api/monero/rewards.js): after the ledger transaction below commits a PENDING
// distribution + QUEUED payouts, finalizeDistribution drives the signer and
// flips the distribution PENDING -> SENDING -> COMPLETE (payouts QUEUED -> SENT).
//
// This module exports (mirrors worker/rewardsWalletObserver.js /
// worker/confirmFinalizer.js):
//   - runDistributionOnce: the testable per-run core (no pg-boss worker).
//   - rewardsDistributor:   the pg-boss handler. Runs the core once per scheduled
//                            weekly run (pgboss.schedule cron, Monday 00:00 UTC).
//   - completeAndEnqueue:  the shared completion path (finalize + eligibility +
//                            delayed ops-sweep enqueue) used by the core, the
//                            stale-SENDING watchdog, and the requeue tool.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const DISTRIBUTION_STATUS_GAUGE = { PENDING: 0, SENDING: 1, COMPLETE: 2, FAILED: 3 }

// One weekly distribution. The testable core: no pg-boss worker, no network.
// Accepts the Prisma client (so tests pass their own); creates a throwaway
// client if omitted. `sendPayouts` is injectable so tests drive the signer with
// a stub (no real keys/wallet); production leaves it unset and uses the real
// signer. `boss` is the send-only queue handle the shared completion path uses
// to schedule the delayed opsSweep follow-up; `scheduleOpsSweep:false` is the
// explicit no-scheduler mode (tests, out-of-band tooling) and requires no boss
// — a missing boss with scheduling enabled throws BEFORE any DB mutation.
// `getWallet` is an injectable readiness seam for reconcileCompletionAccounting
// (production leaves it unset and uses the lazy getRewardsWallet singleton).
// Returns the created (or pre-existing, via idempotency) RewardDistribution
// with its RewardPayout rows included (post-send state).
export async function runDistributionOnce ({ models, sendPayouts: injectSendPayouts, boss, scheduleOpsSweep = true, getWallet } = {}) {
  if (scheduleOpsSweep && !boss) throw new Error('ops sweep scheduler boss required')
  const ownsClient = !models
  const db = ownsClient ? createPrisma() : models
  try {
    const sendPayouts = injectSendPayouts || defaultSendPayouts
    // R02: recover distributions stranded in SENDING by a dead process BEFORE
    // this run's own work, so their QUEUED payouts are re-driven.
    await recoverStaleDistributions(db, { sendPayouts, boss, scheduleOpsSweep, getWallet })
    await warnUndeliveredDistributions(db)
    // Phase timings (Finding 3): the ledger transaction and the completion
    // (signer + terminal flips) are timed separately so a slow-but-legitimate
    // run is distinguishable from a hang in the phase logs. Wrapping in place
    // preserves return/throw identity; context carries only code-owned ids.
    const distribution = await withRewardsPhase('distribution-ledger', () => distribute(db))
    return await withRewardsPhase(
      'distribution-completion',
      () => completeAndEnqueue(db, distribution, sendPayouts, { boss, scheduleOpsSweep, getWallet }),
      { distributionId: distribution?.id }
    )
  } finally {
    if (ownsClient) db.$disconnect().catch(logError)
  }
}

async function distribute (models) {
  const periodEnd = new Date()
  // Allocation eligibility uses the UTC calendar week: a run creates at most
  // one distribution per week beginning Monday 00:00 UTC. A delayed prior run
  // consumes only the week it was actually created in, never the following
  // Monday. The inflow window stays independently anchored to the previous
  // distribution's exact periodEnd (see periodStart below).
  const weekStart = new Date(periodEnd)
  weekStart.setUTCHours(0, 0, 0, 0)
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7))
  // First distribution only: fall back to the trailing seven days for the
  // inflow window (matching lib/rewardsPool.js's open-cycle fallback).
  const firstRunPeriodStart = new Date(periodEnd.getTime() - WEEK_MS)

  // The whole ledger write is atomic: the idempotency check, the read-only
  // inflow/share computations, the RewardDistribution create, and the
  // RewardPayout createMany all run inside ONE serializable transaction so they
  // commit or roll back together. This mirrors the codebase's wallet-safety
  // convention (api/payIn/index.js `begin`; worker/moneroIndexer.js) and closes
  // two hazards the sequential-await form would have:
  //   - crash window: a process death between the distribution create and the
  //     payout createMany can no longer leave a PENDING RewardDistribution with
  //     payoutCount > 0 but zero RewardPayout rows;
  //   - race window: a concurrent run (a manual `sndev monero distribute`
  //     racing a scheduled cron fire) that both pass the findFirst can no longer
  //     both create — under Serializable the loser aborts, then either no-ops
  //     (finds the existing distribution on retry) or errors cleanly. No partial
  //     write is ever visible.
  return await models.$transaction(async (tx) => {
    // Idempotency: a distribution whose periodEnd falls in this UTC week (or
    // later) means the week's allocation already happened; return it verbatim
    // instead of double-distributing. Calendar weeks replace the old rolling
    // seven-day cutoff, where a prior allocation created >1h late suppressed
    // the following Monday. The resumability path is preserved: a FAILED
    // distribution re-driven later the same week is still found here and
    // re-finalized.
    const existing = await tx.rewardDistribution.findFirst({
      where: { periodEnd: { gte: weekStart } },
      orderBy: { periodEnd: 'desc' },
      include: { payouts: true }
    })
    if (existing) {
      logInfo('rewardsDistributor: allocation already exists for this UTC week (or later); reusing')
      return existing
    }

    // Cross-week sender serialization: a prior week's distribution can still be
    // actively signing at the UTC boundary. The old rolling guard incidentally
    // skipped the next run in that case; a calendar-week guard would otherwise
    // start a second wallet send. Defer the new allocation until the in-flight
    // sender settles (its own completion or the stale-SENDING watchdog); a later
    // run then allocates with contiguous inflow, so nothing is lost.
    const inFlight = await tx.rewardDistribution.findFirst({
      where: { status: 'SENDING', startedAt: { not: null } },
      orderBy: { periodEnd: 'desc' },
      include: { payouts: true }
    })
    if (inFlight) {
      logInfo('rewardsDistributor: another distribution is SENDING; deferring this allocation until it settles')
      return inFlight
    }

    // Inflow window: contiguous with the previous distribution — start exactly
    // where it ended, so a late run absorbs its gap window rather than dropping
    // it and consecutive windows never overlap. This accounting boundary is
    // deliberately NOT rounded to the UTC week. Before the first distribution,
    // fall back to the trailing 7 days (matching lib/rewardsPool.js's
    // open-cycle fallback). Read inside the transaction: it also yields the
    // rollover input.
    const lastDistribution = await tx.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' } })
    const periodStart = lastDistribution?.periodEnd ?? firstRunPeriodStart

    // --- Allocation config (platform singleton row, id=1) ---
    const config = await tx.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })

    // --- Inflow through the ONE shared reader (all CONFIRMED eligible, the
    // fee sources require walletReceipt=true, exact mixed-rollover reward
    // split, confirmedAt in [periodStart, periodEnd)). The old independent
    // aggregates could count funding-time accruals the wallet never received
    // and could not see a rollover's exact reward component. ---
    const inflow = await readRewardsInflow(tx, { start: periodStart, end: periodEnd, config })

    // Rewards earmark: each source's contribution at its allocation %, floored
    // per source exactly like lib/rewardsAccounting.js (allocateInflow).
    const rewardsInflow = inflow.rewardsPiconeros
    // BOUNTY_FEE counts toward totalPiconeros (it physically arrived at the
    // rewards wallet via the rollover) but 0% toward rewards — it was booked
    // 100% ops at funding confirmation, so opsInflow absorbs all of it.
    const opsInflow = inflow.opsPiconeros

    // --- One factual ledger for the checkpoint + fee-adjusted carry ---
    const ledger = await readRewardsWalletLedger(tx, { scope: walletScope() })

    // --- Pool: this week's earmark + the prior period's rollover ---
    const rolledOver = toBigInt(lastDistribution?.rolledOverPiconeros)
    const poolPiconeros = rewardsInflow + rolledOver
    // Keep the FULL pool in the ledger and protected from ops sweeps. Only the
    // curator budget is capped; referrals still use the full pool's remainder.
    const curatorBudget = poolPiconeros < WEEKLY_CURATOR_CAP_PICONEROS ? poolPiconeros : WEEKLY_CURATOR_CAP_PICONEROS

    // Ops earmark rollover: the prior period's unswept ops carried in, LESS the
    // network costs incurred after that snapshot's checkpoint (and with a
    // journal-proven unpersisted sweep substituted for the recorded swept
    // amount). opsSwept itself is populated by the ops-sweep job; until then it
    // stays 0, so the full prior opsAvailable (net of real fees) rolls forward.
    const opsRolledOver = opsCarry({
      distribution: lastDistribution,
      totalNetworkFeesPiconeros: ledger.totalNetworkFeesPiconeros,
      provenSweptPiconeros: lastDistribution
        ? (ledger.sweptByDistribution.get(lastDistribution.id) ?? 0n)
        : 0n
    })
    const opsAvailable = opsInflow + opsRolledOver

    // --- Curator trust weighting (#6): config floor + staleness fail-safe.
    // Weighting keys off the nightly trust walk's DEDICATED heartbeat
    // (HealthSnapshot.trustCompletedAt, written only after a fully-successful
    // run). max(UserSubTrust.updated_at) was rejected: territory create/
    // unarchive also write fresh rows, so a territory event inside the window
    // would mask a broken walk. Heartbeat missing/stale (> TRUST_STALENESS_MS)
    // or trust table empty => force 1.0 (weighting disabled) so a broken walk
    // can never slash payouts. ---
    const configTrustFloor = config.curatorTrustWeightFloor ?? 1.0
    const heartbeat = await tx.healthSnapshot.findUnique({ where: { id: 1 }, select: { trustCompletedAt: true } })
    const trustRows = await tx.userSubTrust.count()
    const trustWeightFloor = trustRows > 0
      ? effectiveTrustWeightFloor(configTrustFloor, heartbeat?.trustCompletedAt ?? null)
      : 1.0
    if (trustWeightFloor !== configTrustFloor) {
      logError('rewardsDistributor: trust walk stale or missing (heartbeat) — curator trust weighting disabled for this run')
    }

    // --- Curator shares (Task 7). Read-only, so it COULD run outside the tx,
    // but passing tx keeps the reads in the same serializable snapshot as the
    // writes below — fully consistent at no extra cost. ---
    const { shares } = await computeCuratorShares(
      periodStart, periodEnd, curatorBudget,
      { minPayout: toBigInt(config.distributionMinPayoutPiconeros), topN: config.distributionTopN, trustWeightFloor },
      tx)

    // --- Address filter + payout rows ---
    // A curator is a tipper; they may not have registered a wallet to RECEIVE
    // payouts. Curators with no MoneroAccount(ownerUserId) are excluded — their
    // share rolls over (it stays in poolPiconeros - distributedPiconeros).
    const payoutRows = []
    const paidCuratorIds = new Set()
    for (const share of shares) {
      const account = await tx.moneroAccount.findFirst({ where: { ownerUserId: share.curatorId } })
      if (!account) continue
      paidCuratorIds.add(share.curatorId)
      payoutRows.push({
        curatorId: share.curatorId,
        recipientAddress: account.address,
        piconeros: share.sharePiconeros
      })
    }

    // --- Referral shares (A-09, forever-only) ---
    // For every paid curator with a referrer, the referrer earns 10% of that
    // curator's share IN ADDITION (paid from the pool, upstream FOREVER_REFERRAL
    // semantics). Referral payouts are aggregated per referrer. A referrer without
    // a MoneroAccount is skipped (their cut rolls over — mirroring address-less
    // curators). The total of curator + referral payouts is capped at the pool so
    // rolledOverPiconeros never goes negative.
    const curatorTotal = payoutRows.reduce((acc, p) => acc + p.piconeros, 0n)
    let referralBudget = poolPiconeros - curatorTotal

    const referralByReferrer = new Map() // referrerId -> { piconeros }
    for (const share of shares) {
      if (share.sharePiconeros <= 0n) continue
      // R04: referral payouts are earned on PAID curator shares only. A
      // wallet-less curator's share rolls over — 10% of money that was never
      // paid must not leak to their referrer.
      if (!paidCuratorIds.has(share.curatorId)) continue
      const curator = await tx.user.findUnique({
        where: { id: share.curatorId },
        select: { referrerId: true }
      })
      if (!curator?.referrerId) continue
      const referralPiconeros = share.sharePiconeros / 10n
      if (referralPiconeros <= 0n) continue
      const entry = referralByReferrer.get(curator.referrerId) || { piconeros: 0n }
      entry.piconeros += referralPiconeros
      referralByReferrer.set(curator.referrerId, entry)
    }

    // Referral payout rows are role-tagged here so the Earn loops below can tell
    // them apart from curator payout rows. A referrer who is ALSO a paid curator
    // contributes BOTH row kinds (same curatorId) — without the tag, the curator
    // loop re-emits the referrer's TIP_* earns and the referral loop emits a
    // FOREVER_REFERRAL row for the referrer's own curator share.
    const referralPayoutRows = new Set()
    for (const [referrerId, entry] of referralByReferrer) {
      if (referralBudget <= 0n) break
      const referrerAccount = await tx.moneroAccount.findFirst({ where: { ownerUserId: referrerId } })
      if (!referrerAccount) continue
      const piconeros = entry.piconeros < referralBudget ? entry.piconeros : referralBudget
      const row = { curatorId: referrerId, recipientAddress: referrerAccount.address, piconeros }
      payoutRows.push(row)
      referralPayoutRows.add(row)
      referralBudget -= piconeros
    }

    // --- Final ledger (atomic with the payout createMany below) ---
    // distributedPiconeros is the sum of the CREATED payouts (after address
    // filtering). rolledOverPiconeros is whatever is left — this captures BOTH
    // the weekly cap's excess, Task 7's sub-minPayout/topN rollover, and the
    // addressless-curator rollover, less any additional referral payouts.
    const distributedPiconeros = payoutRows.reduce((acc, p) => acc + p.piconeros, 0n)
    const finalRolledOverPiconeros = poolPiconeros - distributedPiconeros

    const distribution = await tx.rewardDistribution.create({
      data: {
        periodStart,
        periodEnd,
        poolPiconeros,
        distributedPiconeros,
        rolledOverPiconeros: finalRolledOverPiconeros,
        opsInflowPiconeros: opsInflow,
        opsRolledOverPiconeros: opsRolledOver,
        opsAvailablePiconeros: opsAvailable,
        // The cumulative RELAYED network cost already inside this snapshot:
        // every later fee (Fnow - this) debits the active carry exactly once.
        opsNetworkFeesAccountedPiconeros: ledger.totalNetworkFeesPiconeros,
        payoutCount: payoutRows.length,
        status: 'PENDING'
      }
    })

    if (payoutRows.length > 0) {
      await tx.rewardPayout.createMany({
        data: payoutRows.map(p => ({ ...p, distributionId: distribution.id, state: 'QUEUED' }))
      })
      // Write per-(curator, type) Earn rows for every paid curator — SN-parity
      // trophy list + exact "you earned X (Y%)" (sum(Earn) === distributedPiconeros).
      // typeId null = no item links (matches upstream). createdAt = periodEnd so
      // the meRewards day bucket + the in-app Earn notification date land on the
      // distribution day. Address-less curators get no rows (their share rolled
      // over; notifying "you stashed" for unreceived funds would be a lie).
      const earnRows = []
      for (const p of payoutRows) {
        // Referral rows emit only their FOREVER_REFERRAL Earn row below, never
        // curator-type rows — even when the referrer is ALSO a paid curator
        // (shares.find would otherwise succeed and re-emit the referrer's earns).
        if (referralPayoutRows.has(p)) continue
        const share = shares.find(s => s.curatorId === p.curatorId)
        for (const e of share?.earns ?? []) {
          earnRows.push({
            userId: p.curatorId,
            piconeros: e.piconeros,
            type: e.type,
            rank: e.rank,
            typeId: null,
            distributionId: distribution.id,
            createdAt: periodEnd
          })
        }
      }
      // FOREVER_REFERRAL Earn rows: one per referrer (only actual referral
      // payout rows — the role tag, not the curatorId, decides), rank/typeId
      // null (upstream parity). These are what the ReferralReward notification
      // and the /referrals page read.
      for (const p of payoutRows) {
        if (!referralPayoutRows.has(p)) continue
        earnRows.push({
          userId: p.curatorId,
          piconeros: p.piconeros,
          type: 'FOREVER_REFERRAL',
          rank: null,
          typeId: null,
          distributionId: distribution.id,
          createdAt: periodEnd
        })
      }
      await tx.earn.createMany({ data: earnRows })
    }

    // The on-chain signing + PENDING -> SENDING -> COMPLETE flip happens AFTER
    // this transaction commits, in finalizeDistribution (Task 9), so a signer
    // failure never rolls back the atomic ledger write above.

    logger.info({
      pool: poolPiconeros.toString(),
      distributed: distributedPiconeros.toString(),
      rolledOver: finalRolledOverPiconeros.toString(),
      opsAvailable: opsAvailable.toString(),
      payouts: payoutRows.length
    }, 'rewardsDistributor: distribution complete')

    return await tx.rewardDistribution.findUnique({
      where: { id: distribution.id },
      include: { payouts: true }
    })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 })
}

function toBigInt (v) {
  if (v == null) return 0n
  return BigInt(v)
}

// R03: FAILED payouts strand their funds (counted as distributed, excluded from
// rollover, re-entered only by manual reconciliation). Called at every
// transition to COMPLETE so the terminal state can never read clean while
// FAILED payouts exist. Logs + alerts only: no DB work, never throws.
function warnPayoutsStranded (distribution, payouts) {
  const failedPayouts = payouts.filter(p => p.state === 'FAILED')
  if (failedPayouts.length === 0) return
  const strandedPiconeros = failedPayouts.reduce((acc, p) => acc + p.piconeros, 0n)
  const ids = failedPayouts.map(p => p.id).join(', ')
  logError({ distributionId: distribution.id, failedCount: failedPayouts.length, strandedPiconeros: strandedPiconeros.toString() }, 'rewardsDistributor: CRITICAL — distribution completing with FAILED payouts (funds stranded)')
  alert('critical', 'rewards distribution completed with FAILED payouts — manual re-entry required',
    `distribution ${distribution.id} flips COMPLETE with ${failedPayouts.length} FAILED payout(s) [${ids}], ${strandedPiconeros.toString()} piconeros stranded (counted as distributed, excluded from rollover). ` +
    `Recover them with the requeue tool: sndev monero requeue ${distribution.id} --confirm (dev) or the loader-wrapped scripts/requeue-failed-payouts.js (VPS).`,
    { dedupeKey: `dist-${distribution.id}-complete-with-failures` })
}

// Task 9: drive the hot-wallet signer after the ledger transaction commits a
// PENDING distribution + its QUEUED payouts, and flip the distribution's status.
//
//   - Atomic {PENDING,FAILED} -> SENDING: the flip is a compare-and-set
//     (`UPDATE ... WHERE status IN ('PENDING','FAILED') RETURNING id`). A manual
//     `sndev monero distribute` racing the weekly cron can't both win the flip
//     and both call the signer on the same QUEUED rows — the loser's UPDATE
//     matches zero rows and it bails before sending. No double-send.
//   - Resumable after failure: a FAILED distribution that still has QUEUED
//     payouts is re-driven on the next run in the same UTC week; after that,
//     recovery is manual via requeueFailedPayouts. sendPayouts is idempotent on
//     QUEUED rows (it filters `state === 'QUEUED'`, so already-SENT payouts are
//     skipped), so resuming never double-pays. (FAILED is in the CAS set above
//     for exactly this reason.)
//   - Nothing left to send: an empty week (0 payouts), or a row whose payouts
//     are all already SENT, reconciles straight to COMPLETE without entering
//     SENDING.
//   - SENDING / COMPLETE: a no-op for this call (another process is mid-send, or
//     the run already finished).
//   - Catastrophic signer failure: flip to FAILED. QUEUED payouts are untouched
//     (funds never left the wallet), so the next same-week run resumes as above.
//   - Incomplete send summary: if sendPayouts reports any skipped or failed
//     payouts (skipped > 0 || failed > 0), the distribution is marked FAILED
//     (resumable) with a CRITICAL alert — it never reaches COMPLETE until every
//     payout is SENT. The ops-earmark sweep is deliberately NOT part of this
//     function (2026-09-14 decoupling): the shared completion path
//     (completeAndEnqueue) enqueues worker/opsSweep.js as a delayed one-shot
//     after an eligible COMPLETE, so a sweep problem can never affect
//     distribution status.
//   - Unpersisted relays: a payout relayed on-chain whose DB persist failed
//     twice counts as `unpersisted` — same FAILED (resumable) path; the next
//     run's wallet-history reconciliation flips it SENT without re-sending
//     (never a silent COMPLETE, never a double pay).
//   - Unresolved accounting: an additive `accountingUnpersisted` count (an
//     attempted-but-unproven journal relay, a proven relay whose journal state
//     could not be persisted, or an unsettled consolidation) also forces the
//     FAILED (resumable) path — a missing fee cost can never slip into a
//     COMPLETE distribution. Summaries without the key default to zero, so
//     older injected/stubbed signers remain accepted.
export async function finalizeDistribution (models, distribution, sendPayouts) {
  // SENDING = another process is mid-send; COMPLETE = already done. Nothing for
  // this call to drive. (PENDING and FAILED fall through — FAILED is resumable
  // if it still has QUEUED payouts.)
  if (distribution.status === 'SENDING' || distribution.status === 'COMPLETE') return distribution

  const payouts = distribution.payouts || []
  const hasQueued = payouts.some(p => p.state === 'QUEUED')

  if (!hasQueued) {
    // Nothing to send — covers the 0-payout week AND a row whose payouts are all
    // already SENT (e.g. a FAILED run since delivered). Reconcile straight to
    // COMPLETE without ever entering SENDING. R03: the stranded-FAILED alert
    // fires first so the terminal flip can never silently mask them.
    warnPayoutsStranded(distribution, payouts)
    await models.$queryRaw`
      UPDATE "RewardDistribution" SET status = 'COMPLETE', "completedAt" = NOW()
      WHERE id = ${distribution.id} AND status IN ('PENDING','FAILED') RETURNING id`
    moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.COMPLETE)
    return
  }

  // Atomic CAS: only the process that flips {PENDING,FAILED} -> SENDING
  // proceeds. The loser's RETURNING is empty and it bails before sendPayouts, so
  // the same QUEUED payouts are never sent twice.
  const flipped = await models.$queryRaw`
    UPDATE "RewardDistribution" SET status = 'SENDING', "startedAt" = NOW()
    WHERE id = ${distribution.id} AND status IN ('PENDING','FAILED') RETURNING id`
  if (!flipped || flipped.length === 0) return
  moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.SENDING)

  try {
    const sendSummary = await sendPayouts(payouts, { models })
    const accountingUnpersisted = sendSummary?.accountingUnpersisted || 0
    if (sendSummary && (sendSummary.skipped > 0 || sendSummary.failed > 0 ||
      (sendSummary.unpersisted || 0) > 0 || accountingUnpersisted > 0)) {
      logError({ distributionId: distribution.id, ...sendSummary }, 'rewardsDistributor: CRITICAL — payouts not fully sent; distribution FAILED (resumable)')
      alert('critical', 'rewards distribution send incomplete',
        `distribution ${distribution.id}: sent ${sendSummary.sent}, skipped ${sendSummary.skipped}, failed ${sendSummary.failed}, unpersisted ${sendSummary.unpersisted ?? 0}, accountingUnpersisted ${accountingUnpersisted}; marked FAILED (resumable) — payouts remain QUEUED` +
        ((sendSummary.unpersisted || 0) > 0 ? '. WARNING: unpersisted payouts WERE relayed on-chain; the next run reconciles them from wallet history — do NOT manually re-send them.' : '') +
        (accountingUnpersisted > 0 ? `. WARNING: ${accountingUnpersisted} unresolved rewards-wallet fee/journal accounting item(s) remain (unresolved fee costs or journal state — distinct from relayed-but-unpersisted recipient principal); the next run resolves proven relays from exact-hash wallet history before an all-SENT completion and never blindly re-relays.` : ''),
        { dedupeKey: `dist-${distribution.id}-send-incomplete` })
      // Conditional on SENDING closes the ordinary races (e.g. a stale sender
      // whose row was watchdog-recovered and re-driven, R02, must not clobber
      // the newer owner's state). A sender genuinely alive beyond the stale
      // timeout is the documented, accepted tail.
      await models.$queryRaw`
        UPDATE "RewardDistribution" SET status = 'FAILED'
        WHERE id = ${distribution.id} AND status = 'SENDING' RETURNING id`
      moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.FAILED)
      return
    }
    // R03: a mixed FAILED+QUEUED distribution must not flip COMPLETE silently
    // over stranded funds — warn before the success-path terminal write too.
    warnPayoutsStranded(distribution, payouts)
    await models.$queryRaw`
      UPDATE "RewardDistribution" SET status = 'COMPLETE', "completedAt" = NOW()
      WHERE id = ${distribution.id} AND status = 'SENDING' RETURNING id`
    moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.COMPLETE)
  } catch (err) {
    logError({ distributionId: distribution.id, errorClass: errorLabel(err) }, 'rewardsDistributor: finalization failed')
    alert('critical', 'rewards distribution finalization failed',
      `distribution ${distribution.id}: finalization failed (diagnostic withheld; see the worker log errorClass)`,
      { dedupeKey: `dist-${distribution.id}-failed` })
    await models.$queryRaw`
      UPDATE "RewardDistribution" SET status = 'FAILED'
      WHERE id = ${distribution.id} AND status = 'SENDING' RETURNING id`
    moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.FAILED)
  }
}

function alertCompletionAccountingBlocked (distribution, detail) {
  alert('critical', 'rewards distribution completion blocked by unresolved wallet accounting',
    `distribution ${distribution.id}: ${detail}. Recipient rows are untouched (no payout status is rewritten and no new attempt is manufactured); a later run retries the reconciliation before the distribution may complete or schedule a sweep.`,
    { dedupeKey: `dist-${distribution.id}-accounting-blocked` })
}

// Readiness gate for the all-SENT / no-QUEUED completion path (Task 10, routed
// Task 8 finding). A distribution with no QUEUED payouts never calls the
// signer, so sendPayouts' journal reconciliation (Task 6/8) does not run there:
// a proven payout relay whose fee journal persist failed would otherwise let
// the run flip COMPLETE and schedule a sweep with unpersisted accounting.
//
// Explicit scoped journal reads cover attempted-but-unproven (PREPARED +
// relayAttemptedAt) rows that belong to THIS distribution, plus every scoped
// consolidation attempt (consolidations are distribution-independent). When any
// exist, the wallet is obtained OUTSIDE DB work and reconcileWalletTransactions
// resolves them from the wallet's own exact-hash history. The rewards-wallet
// ledger is ALWAYS re-read before readiness (not only when an attempt remains):
// an already-RELAYED journal row conflicting with a recorded payout fact
// (double-send, mismatched amount/address, corrupt metadata) must block an
// all-SENT completion even when no attempted row is left. An unresolved
// attempt, a proven-but-unjournaled relay, a ledger contradiction, or any
// failed read returns false with a CRITICAL accounting alert. No wallet is
// opened when nothing is unresolved, no payout status is ever rewritten here,
// and no new send attempt is manufactured. Read-only toward
// distribution/payout state.
export async function reconcileCompletionAccounting (models, distribution, { getWallet = getRewardsWallet } = {}) {
  try {
    const scope = walletScope()
    const unresolvedAttemptWhere = {
      network: scope.network,
      walletAddress: scope.walletAddress,
      state: 'PREPARED',
      relayAttemptedAt: { not: null }
    }
    const readAttempted = async () => {
      const forDistribution = await models.rewardsWalletTransaction.findMany({
        where: { ...unresolvedAttemptWhere, distributionId: distribution.id },
        orderBy: { id: 'asc' }
      })
      const consolidations = await models.rewardsWalletTransaction.findMany({
        where: { ...unresolvedAttemptWhere, kind: 'CONSOLIDATION' },
        orderBy: { id: 'asc' }
      })
      return [...forDistribution, ...consolidations]
    }

    const attempted = await readAttempted()
    // Wallet work (open + exact-hash resolution) is only warranted when an
    // attempted-but-unproven relay exists; it happens outside DB work.
    let reconciliation = null
    if (attempted.length > 0) {
      const wallet = await getWallet(models)
      reconciliation = await reconcileWalletTransactions({ models, wallet, scope })
    }
    const accountingUnpersisted = reconciliation?.accountingUnpersisted || 0

    // ALWAYS validate the proved-fact union, even with no attempt remaining: a
    // conflict detected here (fail-closed on a read failure) must block the
    // COMPLETE flip and the sweep enqueue.
    const ledger = await readRewardsWalletLedger(models, { scope })
    const remaining = attempted.length > 0 ? await readAttempted() : []

    if (remaining.length > 0 || accountingUnpersisted > 0 || ledger.accountingUncertain) {
      const reasons = []
      if (remaining.length > 0) reasons.push(`${remaining.length} attempted journal entr${remaining.length === 1 ? 'y is' : 'ies are'} still unproven`)
      if (accountingUnpersisted > 0) reasons.push(`${accountingUnpersisted} proven relay(s) could not be journaled`)
      if (ledger.accountingUncertain) reasons.push('the rewards wallet ledger reports unresolved or conflicting facts')
      logError({
        distributionId: distribution.id,
        remaining: remaining.length,
        accountingUnpersisted,
        accountingUncertain: ledger.accountingUncertain
      }, 'rewardsDistributor: CRITICAL — all-SENT completion blocked by unresolved rewards-wallet accounting')
      alertCompletionAccountingBlocked(distribution, reasons.join('; '))
      return false
    }
    return true
  } catch (err) {
    // Fixed, allowlisted diagnostics only: a wallet/RPC/SDK exception can carry
    // credentials or signed transaction material and the shared logger has no
    // redaction, so neither the raw error nor its message reaches the log or
    // the operator alert text.
    logError({ distributionId: distribution.id, errorClass: errorLabel(err) },
      'rewardsDistributor: CRITICAL — completion accounting reconciliation failed; refusing COMPLETE')
    alertCompletionAccountingBlocked(distribution, 'accounting reconciliation failed (diagnostic withheld; see the worker log errorClass)')
    return false
  }
}

// Complete a distribution and (when eligible) schedule its delayed ops sweep.
// The ONE completion orchestration shared by the weekly cron, manual CLI runs,
// same-week re-drives, stale-SENDING recovery and requeue: finalizeDistribution
// owns the payout send/CAS state machine; this function adds the no-QUEUED
// accounting gate and the enqueue eligibility checks.
//
//   - scheduleOpsSweep:false is an explicit no-scheduler mode (tests,
//     out-of-band tooling) and requires no boss; scheduling enabled with no
//     boss is a programming error that throws before any DB mutation.
//   - SENDING: another process owns the row; return it untouched.
//   - No QUEUED payouts: the signer is never called on that path, so its
//     journal reconciliation cannot run there — reconcileCompletionAccounting
//     resolves attempted journal entries and always validates the ledger union;
//     false readiness blocks the COMPLETE flip (the row stays FAILED-resumable).
//   - Enqueue only when the freshly re-read row is COMPLETE, is the LATEST
//     distribution by periodEnd (the sweep job only ever sweeps the latest
//     row), has every payout SENT/CONFIRMED (no stranded principal), and has no
//     proven sweep yet (neither SWEPT nor a partial opsSweptPiconeros).
//   - An enqueue failure never reverts the committed COMPLETE/recipient state:
//     it logs and alerts CRITICAL; repeating an eligible completion retries the
//     enqueue and pg-boss's singletonKey suppresses duplicate LIVE jobs. A
//     crash between the COMPLETE write and the enqueue is NOT covered by the
//     singleton — the next eligible run re-enqueues (there is no outbox).
export async function completeAndEnqueue (models, distribution, signer, { boss, scheduleOpsSweep = true, getWallet } = {}) {
  if (scheduleOpsSweep && !boss) throw new Error('ops sweep scheduler boss required')
  if (distribution.status === 'SENDING') return distribution
  const queued = distribution.payouts?.some(p => p.state === 'QUEUED')
  if (!queued && !await reconcileCompletionAccounting(models, distribution, { getWallet })) return distribution
  await finalizeDistribution(models, distribution, signer)
  const fresh = await models.rewardDistribution.findUnique({ where: { id: distribution.id }, include: { payouts: true } })
  if (!scheduleOpsSweep || fresh?.status !== 'COMPLETE') return fresh
  const latest = await models.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' } })
  if (latest?.id !== fresh.id || fresh.payouts.some(p => !['SENT', 'CONFIRMED'].includes(p.state)) ||
      fresh.opsSweepState === 'SWEPT' || fresh.opsSweptPiconeros > 0n) return fresh
  try {
    await enqueueOpsSweep(boss, fresh)
  } catch (err) {
    logError({ distributionId: fresh.id, errorClass: errorLabel(err) }, 'ops sweep follow-up enqueue failed; payouts remain COMPLETE')
    alert('critical', 'ops sweep follow-up enqueue failed', `distribution ${fresh.id}: retry eligible completion to enqueue; no inline sweep`,
      { dedupeKey: `dist-${fresh.id}-enqueue-failed` })
  }
  return fresh
}

// Recovery re-entry for stranded payouts (2026-09-28 incident): a terminal
// FAILED payout with NULL txHash provably never moved money (FAILED is only
// written in relayBucketTx's createTx catch, where no tx exists), but nothing
// re-drives it — finalizeDistribution resumes only QUEUED rows and the
// calendar-week idempotency guard stops returning the distribution once its UTC
// week ends. This is the "manual re-entry" tool the R03 alert always referenced.
//
// Modes:
//   dry-run (default): report candidates, mutate nothing.
//   confirm: flip {FAILED, txHash IS NULL} -> QUEUED inside ONE Serializable
//     transaction that also re-reads status (refuse SENDING — a live sender
//     may be mid-send; the tx isolation closes the read-then-write race) and
//     un-masks COMPLETE -> FAILED (clearing completedAt) so finalize's CAS
//     accepts it. FAILED rows WITH a txHash are refused — they may have been
//     relayed; wallet-history reconciliation owns them (requeue = double pay).
//     Earn rows are NEVER touched: they were written at distribution time and
//     a recovery must not duplicate them.
//   drive (confirm + send, when >=1 row actually flipped OR the distribution
//     still holds QUEUED payouts — the classification-change stranding shape):
//     re-fetch and run the shared completion path (completeAndEnqueue) with the
//     real signer — the exact cron path (CAS-protected against concurrent
//     senders, wallet-history reconciliation, idempotent on QUEUED, and the
//     same enqueue eligibility for the delayed sweep). NEVER drive a no-op:
//     the completion path's own accounting readiness gate + finalize's
//     !hasQueued branch cannot mask the distribution COMPLETE over stranded
//     rows. A drive crash mid-send is self-healing: the R02 watchdog fails
//     the SENDING row after 24h and the next run re-drives.
export async function requeueFailedPayouts (models, distributionId, { confirm = false, send = true, sendPayouts: injectSendPayouts, boss, scheduleOpsSweep = true, getWallet } = {}) {
  // A send-capable invocation must own its scheduler before any DB mutation;
  // dry-run and --no-send are report/ledger-only and need no boss.
  if (confirm && send && scheduleOpsSweep && !boss) throw new Error('ops sweep scheduler boss required')
  const distribution = await models.rewardDistribution.findUnique({
    where: { id: distributionId },
    include: { payouts: true }
  })
  if (!distribution) throw new Error(`distribution ${distributionId} not found`)

  const candidates = distribution.payouts.filter(p => p.state === 'FAILED' && p.txHash === null)
  const refusedWithTxHash = distribution.payouts.filter(p => p.state === 'FAILED' && p.txHash !== null).map(p => p.id)
  const queuedCount = distribution.payouts.filter(p => p.state === 'QUEUED').length
  const candidatePiconeros = candidates.reduce((acc, p) => acc + p.piconeros, 0n)
  const summary = {
    distributionId,
    status: distribution.status,
    candidates: candidates.map(p => ({ id: p.id, curatorId: p.curatorId, recipientAddress: p.recipientAddress, piconeros: p.piconeros })),
    candidatePiconeros,
    refusedWithTxHash,
    queuedCount,
    requeued: 0,
    drove: false,
    finalStatus: distribution.status
  }
  // Proceed when there are FAILED rows to requeue OR QUEUED payout(s) to deliver (the classification-change stranding shape): confirm-mode drives finalize for QUEUED rows — safe because finalize's masking !hasQueued branch cannot fire while QUEUED rows exist, its CAS loses to any live sender, and wallet-history reconciliation covers secretly-relayed rows.
  if (!confirm || (candidates.length === 0 && queuedCount === 0)) return summary

  const txResult = await models.$transaction(async (tx) => {
    const fresh = await tx.rewardDistribution.findUnique({ where: { id: distributionId }, select: { status: true } })
    if (!fresh || fresh.status === 'SENDING') {
      throw new Error(`distribution ${distributionId} is ${fresh ? fresh.status : 'missing'} — refusing to requeue (a sender may be live; retry after it settles)`)
    }
    // The WHERE re-filters at write time: anything that changed since the
    // summary read (row SENT, hash appeared) is excluded atomically.
    const res = await tx.rewardPayout.updateMany({
      where: { distributionId, state: 'FAILED', txHash: null },
      data: { state: 'QUEUED' }
    })
    let unmasked = false
    if ((res.count > 0 || queuedCount > 0) && fresh.status === 'COMPLETE') {
      // Un-mask: a prior !hasQueued finalize flipped it COMPLETE over stranded
      // rows; finalizeDistribution's CAS only accepts {PENDING, FAILED}.
      await tx.$queryRaw`
        UPDATE "RewardDistribution" SET status = 'FAILED', "completedAt" = NULL
        WHERE id = ${distributionId} AND status = 'COMPLETE' RETURNING id`
      unmasked = true
    }
    return { requeued: res.count, unmasked }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 })

  summary.requeued = txResult.requeued
  if (txResult.unmasked) {
    summary.status = 'FAILED'
    summary.finalStatus = 'FAILED'
  }
  if (txResult.requeued === 0 && queuedCount === 0) return summary
  if (txResult.requeued > 0) {
    logInfo({ distributionId, requeued: txResult.requeued, piconeros: candidatePiconeros.toString() }, 'rewardsDistributor: requeued stranded FAILED payouts (pre-relay, provably unsent)')
    alert('warn', 'rewards payouts requeued for delivery',
      `operator requeued ${txResult.requeued} stranded FAILED payout(s) of distribution ${distributionId} (${candidatePiconeros.toString()} piconeros) to QUEUED${send ? '; delivery is being driven now' : ' (ledger-only, --no-send)'}.`,
      { dedupeKey: `dist-${distributionId}-requeued` })
  }

  if (send) {
    const signer = injectSendPayouts || defaultSendPayouts
    const fresh = await models.rewardDistribution.findUnique({ where: { id: distributionId }, include: { payouts: true } })
    await completeAndEnqueue(models, fresh, signer, { boss, scheduleOpsSweep, getWallet })
    summary.drove = true
    const after = await models.rewardDistribution.findUnique({ where: { id: distributionId } })
    summary.finalStatus = after?.status ?? null
  }
  return summary
}

// Safety net (2026-09-28 incident): payouts strand invisibly once their
// distribution leaves the calendar-week idempotency window (as soon as its UTC
// week ends) — QUEUED rows are never re-driven (no cron path owns out-of-window
// distributions) and terminal FAILED rows are alerted once at failure, then
// never again. This read-only check runs at the top of every distribution run
// and nags until a human recovers them with requeueFailedPayouts. Best-effort
// by design: a check failure must never break the distribution itself. 8d is
// safely beyond the longest possible calendar week, so nothing the current
// run's idempotency guard still owns is flagged. Dev caveat: real-DB test
// residue can trigger this until ./scripts/clean-rewards-test-residue.sh runs.
export async function warnUndeliveredDistributions (models) {
  try {
    const cutoff = new Date(Date.now() - (WEEK_MS + DAY_MS))
    const stranded = await models.rewardDistribution.findMany({
      where: {
        periodEnd: { lt: cutoff },
        payouts: { some: { OR: [{ state: 'QUEUED' }, { state: 'FAILED', txHash: null }] } }
      },
      include: { payouts: true },
      orderBy: { id: 'asc' }
    })
    for (const dist of stranded) {
      const rows = dist.payouts.filter(p => p.state === 'QUEUED' || (p.state === 'FAILED' && p.txHash === null))
      const piconeros = rows.reduce((acc, p) => acc + p.piconeros, 0n)
      logError({ distributionId: dist.id, undeliveredCount: rows.length, piconeros: piconeros.toString() }, 'rewardsDistributor: CRITICAL — undelivered payouts stranded outside the weekly window')
      alert('critical', 'rewards payouts undelivered (stranded)',
        `distribution ${dist.id} (period ${dist.periodStart?.toISOString()} -> ${dist.periodEnd?.toISOString()}) holds ${rows.length} undelivered payout(s) [${rows.map(p => p.id).join(', ')}], ${piconeros.toString()} piconeros — QUEUED rows are never re-driven automatically and FAILED rows need re-entry. Recover with: sndev monero requeue ${dist.id} --confirm (dev) or the loader-wrapped scripts/requeue-failed-payouts.js (VPS).`,
        { dedupeKey: `dist-${dist.id}-undelivered` })
    }
  } catch (err) {
    logError({ errorClass: errorLabel(err) }, 'rewardsDistributor: undelivered-payouts check failed (non-fatal)')
  }
}

// R02: how long a distribution may stay SENDING before the watchdog declares
// it stranded. Worst-case genuine send = singleton wallet open (restore-height
// sync dominates — minutes to low hours) + per-run incremental syncs + <=6
// bucket create/relay cycles + row persists. 24h is ~10-100x that margin; it
// is the ONLY bound against flipping a genuinely-live sender (which would let
// a second sendPayouts double-pay), so never configure it within an order of
// magnitude of a plausible send duration.
const REWARDS_SENDING_STALE_HOURS = Number(process.env.REWARDS_SENDING_STALE_HOURS) || 24

// R02 watchdog: a process death between the SENDING CAS and the terminal
// write (OOM, deploy restart, host crash) strands the row forever — the weekly
// run early-returns on SENDING, the CLI takes the same path, and opsSweep
// skips it. Flip stale rows to FAILED (the finalize CAS resumes FAILED) and
// re-drive them immediately: sendPayouts re-sends only QUEUED rows and its
// wallet-history reconciliation (reconcileUnpersistedPayouts) absorbs
// relayed-but-unpersisted rows from the dead process without re-sending.
// Runs at the top of runDistributionOnce (weekly cron + manual/CLI runs); no
// self-requeue, no new schedule row. Each recovered row goes through the shared
// completion path, so an eligible COMPLETE latest row also schedules its
// delayed sweep (and a missing scheduler boss throws before any mutation when
// scheduling is enabled).
export async function recoverStaleDistributions (models, { sendPayouts, staleHours = REWARDS_SENDING_STALE_HOURS, boss, scheduleOpsSweep = true, getWallet } = {}) {
  if (scheduleOpsSweep && !boss) throw new Error('ops sweep scheduler boss required')
  const staleBefore = new Date(Date.now() - staleHours * 60 * 60 * 1000)
  const stale = await models.rewardDistribution.findMany({
    where: { status: 'SENDING', startedAt: { lt: staleBefore } },
    orderBy: { id: 'asc' }
  })
  for (const dist of stale) {
    try {
      // The staleness predicate is part of the CAS, not just the read above:
      // two overlapping runs can both read this stale row, run A's re-drive
      // gives it a fresh SENDING + startedAt (TOCTOU), and run B's CAS — issued
      // from its earlier read — must not flip that newer owner back to FAILED
      // and re-drive the same QUEUED rows (double pay).
      const flipped = await models.$queryRaw`
        UPDATE "RewardDistribution" SET status = 'FAILED'
        WHERE id = ${dist.id} AND status = 'SENDING' AND "startedAt" < ${staleBefore} RETURNING id`
      if (!flipped || flipped.length === 0) continue // state moved underneath us
      moneroDistributionStatus.set(DISTRIBUTION_STATUS_GAUGE.FAILED)
      logError({ distributionId: dist.id, startedAt: dist.startedAt }, 'rewardsDistributor: CRITICAL — distribution stuck SENDING; watchdog failed it, re-driving now')
      alert('critical', 'rewards distribution stuck SENDING — watchdog failed it',
        `distribution ${dist.id} has been SENDING since ${dist.startedAt?.toISOString()} (> ${staleHours}h). The watchdog flipped it FAILED and is re-driving the send now. If some payouts were already relayed before the crash, wallet-history reconciliation prevents a double pay.`,
        { dedupeKey: `dist-${dist.id}-stale-sending` })
      const fresh = await models.rewardDistribution.findUnique({ where: { id: dist.id }, include: { payouts: true } })
      await completeAndEnqueue(models, fresh, sendPayouts || defaultSendPayouts, { boss, scheduleOpsSweep, getWallet })
    } catch (err) {
      logError({ distributionId: dist.id, errorClass: errorLabel(err) }, 'rewardsDistributor: stale-SENDING recovery failed')
      alert('critical', 'rewards stale-SENDING recovery failed',
        `distribution ${dist.id}: recovery failed (diagnostic withheld; see the worker log errorClass); the row stays FAILED-resumable and the next run retries`,
        { dedupeKey: `dist-${dist.id}-stale-recovery-failed` })
    }
  }
}

// Delay between the payout run and the ops sweep. The payout tx's change is
// 10-block locked (~20 min at Monero's 2-min block target) and the shared
// wallet is mid-churn right after a send — the exact window that made the
// inline sweep throw wallet2 "tx not possible" on 2026-09-14 and fail a
// fully-paid distribution. One hour clears the lock with wide margin.
export const OPS_SWEEP_DELAY_SECONDS = 60 * 60

// Enqueue the one-shot delayed sweep for a settled distribution. No retryLimit:
// a thrown sweep error is almost always pre-relay, and re-driving after a
// partial relay would over-target without cumulative opsSwept accounting — the
// weekly distribution re-enqueues (rollover) instead. singletonKey collapses
// duplicate enqueues of the same row (idempotent across same-week reruns).
// An eligible COMPLETE row with no boss is a programming error: it throws
// rather than silently omitting the follow-up (a non-COMPLETE row remains a
// no-op — no sweep is owed).
export async function enqueueOpsSweep (boss, distribution) {
  if (distribution?.status !== 'COMPLETE') return
  if (!boss) throw new Error('ops sweep scheduler boss required')
  await boss.send('opsSweep', { distributionId: distribution.id }, {
    startAfter: OPS_SWEEP_DELAY_SECONDS,
    singletonKey: `opsSweep-${distribution.id}`
  })
}

// pg-boss handler. Runs one weekly distribution. Recurring scheduling is owned
// by the pgboss.schedule row (cron 0 0 * * 1 UTC, added by migration
// 20260807160000_schedule_rewards_distributor), NOT a relative self-requeue — so
// runs land on the same Monday 00:00 UTC the rewards resolver counts down to
// (api/resolvers/rewards.js). `sndev monero distribute` also runs the shared
// completion path (with its own send-only queue client) for out-of-band runs.
// The delayed ops-earmark sweep is enqueued INSIDE the shared completion path
// (runDistributionOnce -> completeAndEnqueue) — when the run settles COMPLETE
// and is eligible — so the handler must not enqueue a second time.
export async function rewardsDistributor ({ models, boss } = {}) {
  return await runDistributionOnce({ models, boss })
}
