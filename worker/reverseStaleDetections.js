import { Prisma } from '@prisma/client'
import { lwsClient } from '@/api/monero/lwsClient'
import { reverseTip } from '@/api/monero/ranking'
import { reverseDownvotePenalty } from '@/api/monero/downvote'
import { reverseBoostDetected } from '@/worker/rewardsWalletObserver'
import { STALE_DETECTED_EXPIRY_MS } from '@/lib/constants'
import { alert } from '@/lib/alert'

// reverseStaleDetections — closes the 0-conf double-spend window (audit A-1).
//
// Benefits are granted at 0-conf DETECTION (rank, upvotes, tip totals, boost
// weight, fee-gated item liveness; downvote penalties at the verified
// NULL->height transition, Task 13) and NOTHING previously reversed them:
// confirmFinalizer only scans height-set rows, reverseTip had no
// production caller, and reorg reconciliation is explicitly deferred. A
// double-spent or mempool-evicted tx therefore kept every benefit forever.
//
// This sweep flips DETECTED rows past STALE_DETECTED_EXPIRY_MS (48h — far
// beyond the ~20 min a real tx needs for 10 confirmations, within Monero's
// mempool eviction horizon) to the existing REORGED terminal state (the
// tip/downvote modals already render it) and reverses the effects:
//   ObservedTip       -> reverseTip (rank terms, upvotes, totals, ItemUserAgg,
//                        anon bucket — Task 2 exact inverse); height-NULL only
//   ObservedDownvote  -> reverseDownvotePenalty (Task 3), but ONLY for rows
//                        whose verified height is set: Task 13's transition
//                        (applyDownvoteTransition) is the sole penalty writer,
//                        so a height-NULL row never applied one and is skipped
//                        here (it stays DETECTED awaiting the finalizer's
//                        height backfill). Reversing it anyway would subtract
//                        an amount that was never added, driving
//                        Item.downPiconeros / commentDownPiconeros negative.
//   FeeObservation    -> ledger row to REORGED; BOOST legs give back their
//                        platform-routed boost weight; TERRITORY_* legs revert
//                        Sub.billingStatus PAID->PENDING_FEE (re-arming the
//                        unpaid-territory lifecycle); and if the linked
//                        fee-gated Item is live (FEE_PAID) and the payIn has NO
//                        CONFIRMED receipt, soft-delete the item with
//                        abandonFeeItems semantics + CRITICAL alert (content
//                        removal is operator-visible)
//   ObservedSubFee    -> same, plus reverseBoostDetected for owner-routed BOOST
//                        legs (Task 4)
//
// Money-safety: every claim is a conditional UPDATE (... WHERE state='DETECTED'
// and the branch's height predicate) inside a Serializable transaction; only
// the claimer (rowCount > 0) reverses — the webhook/reconcile/finalizer idiom,
// so a row that mines at the last moment cannot be double-reversed. A tx that
// mines AFTER the flip arrives to a REORGED row the receiver treats as terminal
// (200 no-op); the sweep alerts per-run so operators notice patterns.
//
// Recurrence is cron-owned (pgboss.schedule row reverseStaleDetections, every
// 10 min) — NO self-requeue (the 2026-08-16 dead-chain lesson). Streaks
// granted at DETECTED are an accepted residual (constants.js note).

const SCAN_BATCH_SIZE = 500

export async function runReverseStaleDetectionsOnce ({
  models, monero = lwsClient, reverse = reverseTip
} = {}) {
  const cutoff = new Date(Date.now() - STALE_DETECTED_EXPIRY_MS)
  const out = { tips: 0, downvotes: 0, fees: 0, subFees: 0, itemsAbandoned: 0, territoriesReverted: 0 }

  const stale = { state: 'DETECTED', height: null, detectedAt: { lt: cutoff } }

  // --- ObservedTip ---
  const tips = await models.observedTip.findMany({ where: stale, take: SCAN_BATCH_SIZE })
  for (const tip of tips) {
    let claimed = false
    await models.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE "ObservedTip" SET state = 'REORGED'
        WHERE id = ${tip.id} AND state = 'DETECTED' AND height IS NULL`
      if (n > 0) {
        claimed = true
        await reverse(tip.postId, tip.tipperId, tip.piconeros, tip.rankPiconeros, tx)
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (claimed) {
      out.tips += 1
      if (tip.webhookEventId) {
        try { await monero.deleteWebhook(tip.webhookEventId) } catch { /* best-effort */ }
      }
    }
  }

  // --- ObservedDownvote ---
  // Task 13 moved the penalty onto the verified NULL->height transition
  // (applyDownvoteTransition) — the ONLY penalty writer — so a height-NULL row
  // has nothing to reverse and must be skipped here: reversing it would
  // subtract an amount that was never added, driving the ranking aggregates
  // negative. Only a transitioned row (height set) carries a live provisional
  // penalty; one still DETECTED at 48h is a reorg/stuck-maturity case. The
  // height-NULL rows stay DETECTED awaiting the finalizer's height backfill.
  const staleDownvotes = { state: 'DETECTED', height: { not: null }, detectedAt: { lt: cutoff } }
  const downvotes = await models.observedDownvote.findMany({ where: staleDownvotes, take: SCAN_BATCH_SIZE })
  for (const dv of downvotes) {
    let claimed = false
    await models.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE "ObservedDownvote" SET state = 'REORGED'
        WHERE id = ${dv.id} AND state = 'DETECTED' AND height IS NOT NULL`
      if (n > 0) {
        claimed = true
        const item = await tx.item.findUnique({ where: { id: dv.postId } })
        if (item) {
          await reverseDownvotePenalty(tx, item, dv.downvoterId, dv.piconeros)
        }
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    if (claimed) out.downvotes += 1
  }

  // --- FeeObservation (platform-leg fees: posting fees gate items, TERRITORY_* legs flip Sub billing, BOOST legs carry platform-routed boost weight — owner-routed legs reverse via ObservedSubFee) ---
  // Claim + item-abandon run in ONE Serializable tx so a late confirm racing the
  // sweep cannot leave a live item whose fee row just went REORGED (or vice versa).
  const fees = await models.feeObservation.findMany({ where: stale, take: SCAN_BATCH_SIZE })
  for (const fee of fees) {
    await models.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE "FeeObservation" SET state = 'REORGED'
        WHERE id = ${fee.id} AND state = 'DETECTED' AND height IS NULL`
      if (n === 0) return
      out.fees += 1
      // Integrated (PID-bound) receipts open gates and bump boosts only at the
      // verified height transition, so a stale height-NULL one applied
      // nothing: the ledger flip is the whole reversal.
      if (fee.payInId == null || fee.paymentId != null) return
      const confirmed = await tx.feeObservation.count({ where: { payInId: fee.payInId, state: 'CONFIRMED' } })
      if (confirmed > 0) return // partially-confirmed funding is real — leave the item live
      // Platform-routed boost (fee-pool subaddress receipt): give back the boost
      // weight this 0-conf receipt added — the exact inverse of the observer's
      // applyBoostDetected. BOOST legs gate no Item (flipPendingToLive treats
      // them as no-op), so the abandon SQL below naturally no-ops for them.
      if (fee.feeType === 'BOOST') {
        const payIn = await tx.payIn.findUnique({ where: { id: fee.payInId } })
        if (payIn) {
          try { await reverseBoostDetected(tx, payIn, fee.piconeros) } catch (err) {
            console.error(`reverseStaleDetections: boost reversal failed for payIn ${fee.payInId}:`, err?.message || err)
            try {
              alert('critical', 'boost reversal failed — stale fee flipped REORGED anyway',
                `payIn ${fee.payInId} was flipped REORGED by reverseStaleDetections but its boost-weight reversal threw (${err?.message || err}); the boost this receipt granted is still live. Repair Item.boost/commentBoost manually.`,
                { dedupeKey: `stale-boost-reversal-failed-${fee.payInId}` })
            } catch { /* never mask the reversal-failure handler */ }
          }
        }
      }
      // Territory billing legs flipped Sub.billingStatus PENDING_FEE->PAID at
      // DETECTION (flipPendingToLive) — the exact inverse re-arms the platform's
      // existing unpaid-territory lifecycle. Idempotent: the WHERE on PAID means
      // a re-claim (or a fee re-paid by another path) is a no-op.
      if (['TERRITORY_CREATE', 'TERRITORY_BILLING', 'TERRITORY_UNARCHIVE', 'TERRITORY_UPDATE'].includes(fee.feeType)) {
        const reverted = await tx.sub.updateMany({
          where: { billingPayInId: fee.payInId, billingStatus: 'PAID' },
          data: { billingStatus: 'PENDING_FEE' }
        })
        if (reverted.count > 0) {
          out.territoriesReverted += reverted.count
          alert('critical', 'live territory reverted — billing fee never confirmed',
            `a territory's billingStatus went PAID -> PENDING_FEE because its billing fee was never mined (payIn ${fee.payInId}); reverted by reverseStaleDetections. If this recurs, investigate double-spend attempts.`,
            { dedupeKey: `stale-territory-fee-${fee.payInId}` })
        }
      }
      const abandoned = await abandonUnconfirmedFeeItem(tx, fee.payInId)
      if (abandoned) {
        out.itemsAbandoned += 1
        alert('critical', 'live item reversed — fee never confirmed',
          `item ${abandoned} went live on a fee that was never mined (payIn ${fee.payInId}); soft-deleted by reverseStaleDetections. If this recurs, investigate double-spend attempts.`,
          { dedupeKey: `stale-fee-item-${abandoned}` })
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  // --- ObservedSubFee (owner-leg fees + boosts) ---
  const subFees = await models.observedSubFee.findMany({ where: stale, take: SCAN_BATCH_SIZE })
  for (const sf of subFees) {
    await models.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE "ObservedSubFee" SET state = 'REORGED'
        WHERE id = ${sf.id} AND state = 'DETECTED' AND height IS NULL`
      if (n === 0) return
      out.subFees += 1
      if (sf.payInId == null) return
      const confirmed = await tx.observedSubFee.count({ where: { payInId: sf.payInId, state: 'CONFIRMED' } })
      if (confirmed > 0) return
      const payIn = await tx.payIn.findUnique({ where: { id: sf.payInId } })
      if (payIn?.payInType === 'BOOST') {
        try { await reverseBoostDetected(tx, payIn, sf.piconeros) } catch (err) {
          console.error(`reverseStaleDetections: boost reversal failed for payIn ${sf.payInId}:`, err?.message || err)
          try {
            alert('critical', 'boost reversal failed — stale fee flipped REORGED anyway',
              `payIn ${sf.payInId} was flipped REORGED by reverseStaleDetections but its boost-weight reversal threw (${err?.message || err}); the boost this receipt granted is still live. Repair Item.boost/commentBoost manually.`,
              { dedupeKey: `stale-subfee-boost-reversal-failed-${sf.payInId}` })
          } catch { /* never mask the reversal-failure handler */ }
        }
      }
      const abandoned = await abandonUnconfirmedFeeItem(tx, sf.payInId)
      if (abandoned) {
        out.itemsAbandoned += 1
        alert('critical', 'live item reversed — owner fee never confirmed',
          `item ${abandoned} went live on an owner-routed fee that was never mined (payIn ${sf.payInId}); soft-deleted by reverseStaleDetections.`,
          { dedupeKey: `stale-subfee-item-${abandoned}` })
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  if (out.tips + out.downvotes + out.fees + out.subFees > 0) {
    console.log(`reverseStaleDetections: reversed ${out.tips} tips, ${out.downvotes} downvotes, ${out.fees} fees, ${out.subFees} subFees; abandoned ${out.itemsAbandoned} item(s), reverted ${out.territoriesReverted} territory billing leg(s)`)
    alert('warn', 'stale DETECTED observations reversed',
      `${out.tips} tip(s), ${out.downvotes} downvote(s), ${out.fees} fee(s), ${out.subFees} owner-fee(s) flipped REORGED after ${STALE_DETECTED_EXPIRY_MS / 3600000}h without a block — double-spend or mempool eviction suspected`,
      { dedupeKey: `stale-detections-${new Date().toISOString().slice(0, 13)}` })
  }
  return out
}

// Soft-delete a live fee-gated item whose payIn never saw a CONFIRMED receipt —
// abandonFeeItems semantics (blank text/title/url) with an explicit marker.
// Runs INSIDE the caller's Serializable tx. Returns the item id, or null when
// the item is not live on this payIn.
async function abandonUnconfirmedFeeItem (tx, payInId) {
  const rows = await tx.$queryRaw`
    UPDATE "Item"
    SET "deletedAt" = NOW(),
      text = CASE WHEN text IS NOT NULL THEN '*deleted — fee never confirmed*' ELSE text END,
      title = CASE WHEN title IS NOT NULL THEN 'deleted — fee never confirmed' ELSE title END,
      url = NULL,
      "pollCost" = NULL
    WHERE "feePayInId" = ${payInId}::int AND "feeStatus" = 'FEE_PAID' AND "deletedAt" IS NULL
    RETURNING id`
  return rows?.[0]?.id ?? null
}

export async function reverseStaleDetections ({ models }) {
  await runReverseStaleDetectionsOnce({ models })
}
