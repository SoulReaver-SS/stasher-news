import { Prisma } from '@prisma/client'
import { daemonClient } from '@/api/monero/daemonClient'
import { lwsClient } from '@/api/monero/lwsClient'
import { findRewardsAccount } from './rewardsWalletObserver'
import { applyDownvoteTransition } from '@/api/monero/downvote'
import { driveBountyFunding, recordBountyReceipt } from '@/api/monero/bountyFunding'
import { bountyFeePiconeros } from '@/api/monero/bounties'
import { DETECTED_NULL_HEIGHT_BACKSTOP_AGE_MS, REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { createReorgDetector } from '@/lib/reorgDetector'
import { maybeGrantVerifiedBadge } from '@/api/verifiedBadge'
import { recheckDetectedTip } from '@/api/monero/selfTip'
import { alert } from '@/lib/alert'

// confirmFinalizer — matures provisional tips (Task 7 / spec §5.5, Q5).
//
// moneroIndexer records each observed tip as DETECTED the moment lws first
// reports it (0-conf), and applyTipDetected (Task 5) has ALREADY bumped the
// post's ranking columns at that point — DETECTED credit is provisional. A
// tip becomes final once it is buried under REQUIRED_CONFIRMATIONS (10) blocks
// (spec Q7: Monero reorgs are shallow, so 10 confs is effectively final).
//
// This job is the counterpart that flips the mature ones DETECTED -> CONFIRMED.
// It reads the current chain height from monerod (get_info) ONCE per run (one
// daemon call per run — never per tip), scans DETECTED ObservedTips
// whose height is set (mempool tips have height == null and cannot be
// confirmed yet), and for each mature tip flips state and bumps the author's
// stackedPiconeros lifetime-received denorm (spec Q5: stackedPiconeros = sum
// of CONFIRMED ObservedTip.piconeros, mirroring SN's stackedMsats).
//
// NULL-height backstop: a tip detected at 0-conf (daemon level) is left
// DETECTED with height NULL, and if every later mined webhook is lost nothing
// scans it (the maturity scans require height NOT NULL; reconcilePendingTips
// and webhookMissCheck are PENDING-only) — until the 48h stale sweep reverses
// it. runConfirmFinalizerOnce therefore runs a bounded pass over DETECTED
// height-NULL tips older than DETECTED_NULL_HEIGHT_BACKSTOP_AGE_MS and
// re-checks them through recheckDetectedTip (anchored-hash lookup: backfill
// height, correct the amount, defer, or corroborated exclusion). The pass runs
// AFTER the credit pass and never credits: a backfilled row matures on a later
// tick through the normal height-not-null pass.
//
// ATOMICITY (deliberate): the state flip and the author denorm bump run in a
// SINGLE Prisma $transaction. Unlike a create+side-effect split (which has a
// known partial-failure hazard elsewhere), the flip+denorm here must never
// diverge — a CONFIRMED tip with an unbumped author (or vice versa) would
// desync the reputation calc. The transaction guarantees they commit together.
//
// Scope: ObservedTip, FeeObservation, ObservedSubFee, AND ObservedDownvote. The
// tip flip is coupled to the author stackedPiconeros denorm (atomic); the fee,
// sub-fee (turf-owner), and downvote flips are ledger-only. Downvote penalties
// are applied by the shared NULL->height transition (applyDownvoteTransition),
// not here; fee/sub-fee gating effects apply at DETECTION.
// Reorg reversal is NOT implemented — deferred as an accepted v1 limitation
// (consistent with the tip flow; a >10-block Monero reorg is negligible).
//
// ObservedBounty is the EXCEPTION to "ledger-only": a bounty funding whose
// webhook N-conf CONFIRMED callback was missed (e.g. the pid-map gate bug behind
// item 2808) must not stay provisional. The finalizer runs driveBountyFunding —
// the SAME funding effects as the webhook CONFIRMED path (Item -> FUNDED with
// the fee terms frozen on the Item; no hot-wallet cash row) — so the funding
// completes even when no callback ever fired. It also reconciles lws receipts
// for still-short DETECTED bounties (and backfills a NULL height from lws when
// every callback was missed). See backfillNullBountyHeights.
//
// This module exports FOUR things (mirrors worker/moneroIndexer.js):
//   - runConfirmFinalizerOnce: the testable per-run core (no pg-boss). Takes
//     injectable daemonClient + lwsClient so tests never touch the network.
//   - backfillNullBountyHeights: the lws reconcile helper for still-short
//     DETECTED bounties (receipt folding + NULL-height resolution; exported
//     for unit testing).
//   - backfillNullObservationHeights: the lws height-resolution helper for
//     NULL-height poll-detected DETECTED ObservedDownvote/FeeObservation rows
//     (exported for unit testing).
//   - confirmFinalizer: the pg-boss handler. Runs the core once; recurrence
//     is cron-owned (pgboss.schedule row confirmFinalizer, every 60s).

// Bounded batch so the job stays latency-bounded even if a large backlog of
// DETECTED tips accrues (e.g. a long lws outage followed by catch-up). 500 is
// well above any realistic per-block tip volume and leaves headroom; the next
// poll picks up the overflow. Pagination by cursor is unnecessary because the
// query is state-filtered (DETECTED) and DETECTED rows only shrink over time.
const SCAN_BATCH_SIZE = 500

// Smaller bound for the NULL-height tip backstop: each scanned tip costs an
// lws lookup (and possibly a monerod corroboration), and this pass heals an
// exceptional condition (lost webhook chain), not a normal flow. 100/run at
// the 60s cadence drains any realistic backlog within a few ticks.
const NULL_HEIGHT_BACKSTOP_BATCH_SIZE = 100

// Per-worker reorg detector (Task D5). Tracks the last chain height seen by
// this job across runs and fires a debounced critical alert on regression.
// Injectable on runConfirmFinalizerOnce so tests never trip the module-level
// baseline (and can assert the wiring directly).
const detectReorg = createReorgDetector()

// One run of the confirmFinalizer. Returns the count of tips flipped to
// CONFIRMED (useful for logs/metrics; not asserted by tests).
export async function runConfirmFinalizerOnce ({ models, daemonClient: client = daemonClient, detectReorg: detect = detectReorg, lwsClient: lws = lwsClient } = {}) {
  const chainHeight = await client.getHeight()
  // Cache the chain tip for read-path depth derivations (monerowall rating
  // tier). Best-effort: a failed write leaves the previous tip; readers
  // treat stale tips as absent (CHAIN_TIP_MAX_AGE_MS).
  try {
    await models.chainState.upsert({
      where: { id: 1 },
      create: { id: 1, chainHeight },
      update: { chainHeight }
    })
  } catch (err) {
    console.warn('confirmFinalizer: chainState upsert failed:', err)
  }
  detect(chainHeight)

  // PASS 0 (backfill): resolve NULL heights for poll-detected DETECTED rows so
  // the maturity passes below can see them (they filter height NOT NULL).
  const nullHeightDownvotes = await models.observedDownvote.findMany({
    where: { state: 'DETECTED', height: null },
    take: SCAN_BATCH_SIZE
  })
  // PID-bound integrated fee receipts are excluded: their height must come
  // with a verified amount and a gate replay, which only the shared applier
  // (webhook / observer / reconcileOwnerFeeLegs) performs — a bare height
  // stamp here would make a provisional callback amount count.
  const nullHeightFees = await models.feeObservation.findMany({
    where: { state: 'DETECTED', height: null, walletReceipt: true, paymentId: null },
    take: SCAN_BATCH_SIZE
  })
  if (nullHeightDownvotes.length || nullHeightFees.length) {
    await backfillNullObservationHeights({ models, lws, downvotes: nullHeightDownvotes, fees: nullHeightFees })
  }

  // Mempool tips (height == null) carry no block height to confirm against, so
  // they are excluded here — they become eligible the moment lws reports them
  // confirmed (height set) on a later indexer poll.
  const tips = await models.observedTip.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    // recipientAccount fields feed the confirm-time re-check
    // (recheckDetectedTip): viewKey/status gate the lws scan, subaddresses
    // feed isSelfSend, id anchors the cursor advance.
    include: {
      post: { select: { userId: true } },
      recipientAccount: { select: { id: true, label: true, address: true, status: true, viewKey: true, lastTxId: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } } }
    },
    take: SCAN_BATCH_SIZE
  })

  let confirmed = 0
  for (const tip of tips) {
    const confirmations = chainHeight - tip.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue

    // Confirm-time re-check before the credit (the 0-conf gap): lws cannot
    // see spent_outputs for the tx while it sat in the mempool, so the
    // detection-time self-send check can have failed open. The tx is mined
    // now (height is set), so the evidence exists — this is the last gate
    // before stackedPiconeros. The SAME check binds the stored amount/txHash
    // to the chain tx: a BOUND row that disagrees with the chain
    // (CHAIN_MISMATCH) is excluded here instead of credited, while an UNBOUND
    // row (amountVerifiedAt null) is trust-corrected to the chain amount and
    // that corrected amount is what gets credited below. The webhook N-conf
    // callback races us for the claim and runs the same check, so a wash or
    // forged tip is excluded regardless of which claimer wins. An lws failure
    // skips the tip this run (fail closed on the credit path); recurrence is
    // cron-owned, so the next tick retries. A 'deferred' verdict means the
    // lws miss was corroborated by (or could not be cleared against) monerod:
    // never credit or exclude on it — alert and retry next tick.
    let recheck
    try {
      recheck = await recheckDetectedTip({ models, monero: lws, daemon: client, tip, confirmations })
    } catch (err) {
      console.warn(`confirmFinalizer: self-send recheck failed for tip ${tip.id}: ${err && err.message}`)
      continue
    }
    if (recheck.action === 'excluded') continue
    if (recheck.action === 'deferred') {
      alert('warn', 'tip credit deferred: lws miss with on-chain tx',
        `tip ${tip.id}: ${recheck.reason} — no credit this pass; will retry`,
        { dedupeKey: `tip-credit-deferred-${tip.id}` })
      continue
    }
    // Credit the amount the re-check reports when it carries one: the corrected
    // chain amount, or — when it lost the binding race to the webhook — the
    // amount the winner bound. Only the unscannable early-clean has no amount,
    // and that documented fail-open edge falls back to the row snapshot.
    const creditAmount = recheck.piconeros ?? tip.piconeros

    // Resolve the author via the tipped post. The ObservedTip.postId FK is
    // ON DELETE RESTRICT (non-nullable), so the Item cannot be deleted while
    // the tip exists — post is always present. The guard is defensive only.
    const authorId = tip.post?.userId
    await models.$transaction(async (tx) => {
      const claimed = await tx.$executeRaw`
        UPDATE "ObservedTip"
        SET state = 'CONFIRMED', confirmations = ${confirmations}, "confirmedAt" = NOW()
        WHERE id = ${tip.id} AND state = 'DETECTED'`
      if (claimed > 0 && authorId != null && tip.recipientAccount?.label !== 'platform_rewards') {
        await tx.user.update({
          where: { id: authorId },
          data: { stackedPiconeros: { increment: creditAmount } }
        })
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (authorId != null && tip.recipientAccount?.label !== 'platform_rewards') {
      try {
        await maybeGrantVerifiedBadge(models, authorId)
      } catch (err) {
        console.error('verified badge check failed (confirmFinalizer):', err)
      }
    }
    if (authorId == null) {
      console.warn(`confirmFinalizer: tip ${tip.id} flipped to CONFIRMED but author could not be resolved (post ${tip.postId}); stackedPiconeros NOT bumped`)
    }
    if (authorId != null && tip.recipientAccount?.label === 'platform_rewards') {
      console.log(`confirmFinalizer: tip ${tip.id} flipped to CONFIRMED (rewards-pool recipient); stackedPiconeros not bumped`)
    }
    confirmed += 1
  }

  // PASS 1b (NULL-height backstop): a DETECTED tip whose height is still NULL
  // after the grace period may have lost every mined webhook. Nothing else
  // scans it (maturity requires height NOT NULL; reconcilePendingTips and
  // webhookMissCheck are PENDING-only) and the 48h stale sweep would reverse a
  // real, paid tip. Re-check it through the same recheckDetectedTip gate the
  // credit paths use: an anchored-hash lookup that backfills the height,
  // trust-corrects the amount, defers (lws miss corroborated by monerod), or
  // claims the corroborated TX_NOT_FOUND exclusion. Deliberately placed AFTER
  // the credit pass and this pass does NOT credit: the next tick's
  // height-not-null pass re-reads the row fresh and re-runs the same gate
  // before any credit. Only anchored (64-hex) hashes are scanned — the
  // fail-closed TX_NOT_FOUND corroboration is hash-keyed, so a row without a
  // valid anchor is left to the existing sweeps rather than excluded on an
  // uncheckable lws miss. Bounded by NULL_HEIGHT_BACKSTOP_BATCH_SIZE.
  const backstopBefore = new Date(Date.now() - DETECTED_NULL_HEIGHT_BACKSTOP_AGE_MS)
  const nullHeightTips = (await models.observedTip.findMany({
    where: { state: 'DETECTED', height: null, detectedAt: { lt: backstopBefore } },
    include: {
      post: { select: { userId: true } },
      recipientAccount: { select: { id: true, label: true, address: true, status: true, viewKey: true, lastTxId: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } } }
    },
    take: NULL_HEIGHT_BACKSTOP_BATCH_SIZE
  })).filter(tip => /^[0-9a-f]{64}$/i.test(tip.txHash))
  for (const tip of nullHeightTips) {
    try {
      await recheckDetectedTip({ models, monero: lws, daemon: client, tip })
    } catch (err) {
      // Same fail-closed posture as the credit pass's re-check: skip this tip
      // this run (recurrence is cron-owned, the next tick retries).
      console.warn(`confirmFinalizer: NULL-height backstop re-check failed for tip ${tip.id}: ${err && err.message}`)
    }
  }

  // Fee observations (rewardsWalletObserver): mature DETECTED fee
  // observations to CONFIRMED at the same confirmation threshold. The gated
  // Item/Sub already went live on DETECTION; CONFIRMED just finalizes the ledger
  // row so Phase 4's rewardsDistributor can sum paid fees per period. The linked
  // PayIn's own state is left untouched (it is the ITEM_CREATE bookkeeping state).
  // Wallet-receipt eligibility is required (rewards accounting repair §3.2): an
  // ineligible legacy accrual row (walletReceipt = false) is historical evidence,
  // not cash, and must never be matured into a hot-wallet consumer sum.
  const fees = await models.feeObservation.findMany({
    where: { state: 'DETECTED', height: { not: null }, walletReceipt: true },
    take: SCAN_BATCH_SIZE
  })
  for (const fee of fees) {
    const confirmations = chainHeight - fee.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue
    // Conditional: a concurrent refusal/reversal (EXCLUDED/REORGED) wins.
    await models.feeObservation.updateMany({
      where: { id: fee.id, state: 'DETECTED' },
      data: { state: 'CONFIRMED', confirmations, confirmedAt: new Date() }
    })
  }

  // ObservedSubFee (turf-owner fee legs): ledger-only maturity, mirroring the
  // FeeObservation pass. The lws webhook N-conf callback is the primary
  // maturer; this is the safety net for missed callbacks (deploy restarts,
  // swept stragglers) — without it a missed callback strands the receipt at
  // DETECTED forever, invisible to revenue notifications/leaderboard/
  // earnedPiconeros (all filter CONFIRMED). Revenue notifications are
  // query-side (the notifications resolver reads CONFIRMED rows) — no effects
  // here. The conditional updateMany (state: 'DETECTED' guard) makes a race
  // with a late webhook CONFIRMED callback a count-0 no-op instead of a
  // confirmedAt overwrite. NULL-height DETECTED rows are the reconcile
  // chain's job, not this pass's.
  const subFees = await models.observedSubFee.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    select: { id: true, height: true },
    take: SCAN_BATCH_SIZE
  })
  let subFeeConfirmed = 0
  for (const subFee of subFees) {
    const confirmations = chainHeight - subFee.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue
    const res = await models.observedSubFee.updateMany({
      where: { id: subFee.id, state: 'DETECTED' },
      data: { state: 'CONFIRMED', confirmations, confirmedAt: new Date() }
    })
    subFeeConfirmed += res.count
  }
  if (subFeeConfirmed > 0) {
    console.log(`confirmFinalizer: matured ${subFeeConfirmed} ObservedSubFee receipt(s) DETECTED -> CONFIRMED (missed N-conf callback safety net)`)
  }

  // ObservedDownvote (rewardsWalletObserver): mature DETECTED downvotes to
  // CONFIRMED at the same confirmation threshold. The ranking penalty
  // (weightedDownVotes/downPiconeros) is applied by the shared verified
  // NULL->height transition (applyDownvoteTransition), NOT at DETECTION: every
  // insert path writes height NULL, so by the time a row is height-set here the
  // transition whose CAS won has already applied the penalty exactly once.
  // CONFIRMED just finalizes the ledger row. Reorg reversal is deferred
  // (consistent with the tip flow: a >10-block Monero reorg is negligible;
  // consequence is minor ranking drift, not fund loss).
  const downvotes = await models.observedDownvote.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    take: SCAN_BATCH_SIZE
  })
  for (const downvote of downvotes) {
    const confirmations = chainHeight - downvote.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue
    await models.observedDownvote.update({
      where: { id: downvote.id },
      data: { state: 'CONFIRMED', confirmations, confirmedAt: new Date() }
    })
  }

  // ObservedBounty (A-13) — TRUE backstop for a missed webhook CONFIRMED
  // callback. The pid-map gate bug (item 2808) stranded the first real funding
  // at DETECTED: the 0-conf callback consumed the pid map, so every later
  // callback (including the N-conf CONFIRMED one that runs driveBountyFunding)
  // was a 200 no-op, and height was never backfilled (NULL at 0-conf). Two
  // passes close both gaps so the funding cannot stay provisional:
  //   PASS 1 (reconcile): fold lws receipts for every still-short DETECTED
  //     bounty REGARDLESS of height (plus every NULL-height one, for the
  //     height backfill) so a top-up whose callbacks were all lost still
  //     opens the gate.
  //   PASS 2 (fund): run driveBountyFunding for mature DETECTED bounties — the
  //     SAME funding effects as the webhook CONFIRMED path (Item -> FUNDED with
  //     the fee terms frozen on the Item; no hot-wallet cash row), not just a
  //     row flip. Idempotent vs a late webhook replay (CONFIRMED state guard +
  //     the deterministic funding writes) and vs the webhook itself (Serializable
  //     isolation serializes any overlap; a loser aborts and retries next run).
  const detectedBounties = await models.observedBounty.findMany({
    where: { state: 'DETECTED' },
    include: {
      post: { select: { bountyPiconeros: true } },
      receipts: { select: { piconeros: true, height: true } }
    },
    take: SCAN_BATCH_SIZE
  })
  if (detectedBounties.length) {
    // Skip fully-covered, fully-verified height-set bounties to bound the lws
    // work — they only await the funding pass below. Eligibility is keyed off
    // the COUNT-ELIGIBLE receipts (height-verified), never the display fold:
    // ANY provisional (height-NULL) receipt needs this pass to claim its height
    // from lws, and a mixed funding whose display fold crosses the quote while
    // the counted sum does not would otherwise strand that top-up forever
    // (PASS 2 refuses to fund; the 7-day sweep refunds the verified portion
    // only). Shortness is computed the same way the 7-day sweep computes it
    // (fee on the DECLARED amount, one config read).
    const bountyConfig = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
    const reconcileBounties = detectedBounties.filter(b => {
      if (b.height == null || b.receipts.some(r => r.height == null)) return true
      const expected = b.post.bountyPiconeros + bountyFeePiconeros(b.post.bountyPiconeros, bountyConfig)
      const counted = b.receipts.reduce((sum, r) => r.height != null ? sum + r.piconeros : sum, 0n)
      return counted < expected
    })
    if (reconcileBounties.length) {
      await backfillNullBountyHeights({ models, lws, bounties: reconcileBounties })
    }
  }

  const bounties = await models.observedBounty.findMany({
    where: { state: 'DETECTED', height: { not: null } },
    take: SCAN_BATCH_SIZE
  })
  for (const bounty of bounties) {
    const confirmations = chainHeight - bounty.height + 1
    if (confirmations < REQUIRED_CONFIRMATIONS) continue
    await models.$transaction(async (tx) => {
      // driveBountyFunding self-computes its gate from the COUNT-ELIGIBLE
      // receipts (height-verified). A bounty whose receipts are all provisional
      // (daemon-level, amount-unverified) stays DETECTED until an lws sight
      // claims their height via the atomic CAS.
      await driveBountyFunding(tx, bounty, {
        txHash: bounty.txHash, height: bounty.height, confirmations
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  return confirmed
}

// Fold lws receipts and resolve NULL heights for the still-short DETECTED
// bounties the caller passes (every NULL-height one plus every height-set one
// not yet fully covered). A top-up whose webhook callbacks were ALL lost is
// recorded by nothing else — the observer watches only the rewards wallet and
// reconcilePendingTips is tips-only — so EVERY matching lws tx becomes a
// receipt (idempotent by txHash) and ObservedBounty.piconeros folds to the
// cumulative sum. lws watches the bounty escrow account and reports each
// incoming tx's block height, so a single get_address_txs scan per account
// recovers every stranded bounty on it. Mirrors the reconcilePendingTips
// lws-resolution pattern. The height column is ADVANCED-ONLY here: a NULL row
// is resolved to the max matched tx height and a height-set row advances to a
// later top-up's height, but a matched tx below the stored anchor never lowers
// it. The funding decision runs in
// runConfirmFinalizerOnce's funding pass (which re-fetches height-not-null
// rows), so a still-mempool tx (height null on lws too) is left untouched and
// retries next run.
export async function backfillNullBountyHeights ({ models, lws, bounties }) {
  if (!bounties.length) return
  // Group by escrow account for one lws scan per account.
  const byAccount = new Map()
  for (const b of bounties) {
    if (!byAccount.has(b.recipientAccountId)) byAccount.set(b.recipientAccountId, [])
    byAccount.get(b.recipientAccountId).push(b)
  }
  const accounts = await models.moneroAccount.findMany({
    where: { id: { in: [...byAccount.keys()] } },
    include: { viewKey: true }
  })
  for (const account of accounts) {
    // Unscannable accounts (view key wiped / INACTIVE) can't be queried — lws
    // walletLogin would throw and abort the whole run. Skip; retry next run
    // (same guard as reconcilePendingTips).
    if (!account.viewKey || account.status !== 'ACTIVE') continue
    let resp
    try {
      resp = await lws.getAddressTxs(account, 0, null)
    } catch (err) {
      console.warn(`confirmFinalizer: lws bounty height resolve failed for account ${account.id}: ${err && err.message}`)
      continue
    }
    const byPid = new Map()
    for (const tx of (resp.transactions || [])) {
      if (!tx.payment_id) continue
      const pid = String(tx.payment_id).toLowerCase()
      if (!byPid.has(pid)) byPid.set(pid, [])
      byPid.get(pid).push(tx)
    }
    for (const bounty of byAccount.get(account.id) || []) {
      const txs = byPid.get(String(bounty.paymentId).toLowerCase()) || []
      let maxHeight = bounty.height
      for (const tx of txs) {
        if (tx.height == null) continue
        await recordBountyReceipt(models, bounty, { txHash: tx.hash, piconeros: tx.piconeros, height: tx.height })
        if (maxHeight == null || tx.height > maxHeight) maxHeight = tx.height
      }
      // Advance the bounty's height to the max matched lws height (a NULL row
      // is resolved; a height-set row with a later top-up advances to the
      // newest receipt, so the maturity pass below is computed from the
      // shallowest receipt). A still-mempool tx (height null) stays untouched
      // and retries next run. Receipts themselves carry the count-eligible
      // heights — this column is the funding row's display/maturity anchor.
      if (maxHeight != null && (bounty.height == null || maxHeight > bounty.height)) {
        await models.observedBounty.update({
          where: { id: bounty.id },
          data: { height: maxHeight }
        })
      }
    }
  }
}

// Resolve NULL heights for poll-detected DETECTED rows (ObservedDownvote,
// FeeObservation). The rewardsWalletObserver records these rows the moment lws
// first reports a tx; if that report was a mempool-shaped row (height omitted —
// structurally possible per the lwsClient parser), the maturity passes skip the
// row forever (height: { not: null }) and nothing else backfills it. One
// get_address_txs scan of the platform rewards account resolves every stranded
// row on it, matched by txHash. Still-mempool txs (height null on lws too) are
// left untouched and retry next run. Mirrors backfillNullBountyHeights.
// The downvote height resolution runs through applyDownvoteTransition, which
// owns the ranking penalty on that NULL->height transition (Task 13) — a row
// already transitioned by the webhook/observer CAS is a no-op here.
// FeeObservation heights remain a plain ledger backfill (no ranking effect).
export async function backfillNullObservationHeights ({ models, lws, downvotes, fees }) {
  if (!downvotes.length && !fees.length) return
  const account = await findRewardsAccount(models)
  // Unscannable account (view key wiped / INACTIVE) can't be queried — lws
  // walletLogin would throw and abort the whole run. Skip; retry next run.
  if (!account || !account.viewKey) return
  let resp
  try {
    resp = await lws.getAddressTxs(account, 0, null)
  } catch (err) {
    console.warn(`confirmFinalizer: lws observation height resolve failed for account ${account.id}: ${err && err.message}`)
    return
  }
  const byHash = new Map()
  for (const tx of (resp.transactions || [])) {
    if (tx.hash) byHash.set(String(tx.hash).toLowerCase(), tx)
  }
  for (const dv of downvotes) {
    const tx = byHash.get(String(dv.txHash).toLowerCase())
    if (tx && tx.height != null) {
      // The shared transition owns the penalty: this lws sight is the first
      // verified height, so it also applies the LOG-scaled ranking penalty
      // exactly once (the CAS is the gate — a webhook or observer that already
      // transitioned the row makes this a no-op). The lws amount/txHash are the
      // chain-verified values; any provisional callback amount is corrected here.
      await applyDownvoteTransition({
        models,
        dv,
        height: tx.height,
        piconeros: tx.piconeros,
        confirmations: tx.confirmations ?? 0
      })
    }
  }
  for (const fee of fees) {
    const tx = byHash.get(String(fee.txHash).toLowerCase())
    if (tx && tx.height != null) {
      await models.feeObservation.update({
        where: { id: fee.id },
        data: { height: tx.height, confirmations: tx.confirmations ?? 0 }
      })
    }
  }
}

// pg-boss handler. Runs one scan per invocation; recurrence is cron-owned
// (pgboss.schedule row confirmFinalizer, every 60s) — no self-requeue. The
// one-shot seed in worker/index.js only covers an empty queue at boot.
export async function confirmFinalizer ({ models }) {
  // Recurrence is cron-owned (pgboss.schedule row confirmFinalizer); no
  // self-requeue.
  await runConfirmFinalizerOnce({ models })
}
