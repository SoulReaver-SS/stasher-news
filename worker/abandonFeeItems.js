import { FEE_ITEM_ABANDON_DAYS } from '@/lib/constants'
import { deleteReminders } from '@/lib/item'

// abandonFeeItems — 1-day abandonment sweep for never-paid fee-gated flows.
//
// (1) PENDING_FEE items: a fee-gated item (post or reply) is created
// PENDING_FEE and is invisible to everyone except its author until
// rewardsWalletObserver observes the posting fee on-chain (flipPendingToLive →
// FEE_PAID). A fee the author never pays would otherwise linger forever:
// author-only visible, no badge, no re-pay path, no expiry. An item already
// soft-deleted by its author (deleteItemByAuthor keeps feeStatus/feePayInId)
// is cleaned too — preserving its existing deletion — so its PayIn stops being
// watched and a late fee cannot flip deleted content live. This sweep
// soft-deletes PENDING_FEE items past FEE_ITEM_ABANDON_DAYS (1 day), deletes
// their fee PayIn (the subaddress pool is ASSIGN-never-freed, so deleting the
// PayIn cannot cause reuse or misattribution — a late payment to the abandoned
// subaddress simply finds no pending PayIn and is ignored, matching the
// observer's tested behavior), and clears queued pgboss jobs for the item.
//
// (2) PendingItemUpdate rows (deferred >10MB-upload edits): a fee-bearing edit
// is stored instead of applied until its upload fee is observed. An edit whose
// fee is never paid would otherwise strand the row forever; the sweep purges
// rows past the same cutoff and deletes their ITEM_UPDATE payIn (same
// late-payment semantics as (1)). The item is untouched — the edit never
// applied — and the unattached upload is reaped by deleteUnusedImages.
//
// This module exports TWO things (mirrors worker/confirmFinalizer.js):
//   - runAbandonFeeItemsOnce: the testable per-sweep core (no pg-boss).
//   - abandonFeeItems: the pg-boss handler; recurrence is cron-owned
//     (pgboss.schedule row abandonFeeItems, hourly) — no self-requeue.

export async function runAbandonFeeItemsOnce ({ models }) {
  const cutoff = new Date(Date.now() - FEE_ITEM_ABANDON_DAYS * 24 * 60 * 60 * 1000)

  // Selection: PENDING_FEE items carrying a fee PayIn, past the abandonment
  // age. Deliberately NOT filtered on deletedAt: an item soft-deleted while
  // PENDING_FEE (deleteItemByAuthor keeps feeStatus/feePayInId) otherwise keeps
  // its fee PayIn watched forever, and a late fee could flip deleted content
  // live. The in-transaction claim below is the single decision point and
  // preserves an existing deletion instead of rewriting it.
  const stale = await models.item.findMany({
    where: {
      feeStatus: 'PENDING_FEE',
      feePayInId: { not: null },
      createdAt: { lt: cutoff }
    },
    select: { id: true, feePayInId: true, userId: true }
  })

  let abandoned = 0
  for (const item of stale) {
    const claimed = await models.$transaction(async tx => {
      // Claim (row lock) + recheck: a flip that landed between the scan and
      // this transaction (feeStatus -> FEE_PAID), a reassigned feePayInId, or
      // a concurrent sweep that already cleaned the row makes this UPDATE
      // match nothing — then nothing (PayIn/jobs/reminders) may be deleted.
      // RETURNING hands back the row's CURRENT PayIn so the stale scan
      // snapshot is never used to delete anything.
      //
      // PostgreSQL SET expressions read the pre-update row, so the CASE guards
      // preserve an already-deleted item's content: only a freshly abandoned
      // (not-yet-deleted) row is blanked, and coalesce keeps an existing
      // deletedAt.
      const [row] = await tx.$queryRaw`
        UPDATE "Item"
        SET "deletedAt" = coalesce("deletedAt", NOW()),
          text = CASE WHEN "deletedAt" IS NULL AND text IS NOT NULL THEN '*deleted by author*' ELSE text END,
          title = CASE WHEN "deletedAt" IS NULL AND title IS NOT NULL THEN 'deleted by author' ELSE title END,
          url = CASE WHEN "deletedAt" IS NULL THEN NULL ELSE url END,
          "pollCost" = CASE WHEN "deletedAt" IS NULL THEN NULL ELSE "pollCost" END
        WHERE id = ${item.id}::int
          AND "feeStatus" = 'PENDING_FEE'
          AND "feePayInId" = ${item.feePayInId}::int
          AND created_at < ${cutoff}
        RETURNING id, "feePayInId"`
      if (!row) return false

      // The fee PayIn is orphaned once the item is gone; delete it so the
      // observer stops watching the subaddress (pool rows stay ASSIGNED).
      // Observation tables (FeeObservation, ObservedSubFee) must keep ON DELETE
      // SET NULL FKs on payInId — a RESTRICT here threw P2003 on underpaid
      // owner-routed legs and wedged this whole sweep (same bug class as the
      // FeeObservation fix 20260814202910). The SubFeePidMap is deliberately
      // retained: a late payment still resolves its leg and is recorded
      // (payInId null) by the webhook's abandoned-fee path.
      await tx.payIn.delete({ where: { id: row.feePayInId } })

      // Clear queued jobs for this item (timestampItem/imgproxy from onPaid;
      // deleteItem/reminder from performBotBehavior) so they don't fire on a
      // deleted item.
      await tx.$queryRaw`
        DELETE FROM pgboss.job
        WHERE (data->>'id' = ${String(item.id)} OR data->>'itemId' = ${String(item.id)})
          AND state <> 'completed'`
      await deleteReminders({ id: item.id, userId: item.userId, models: tx })
      return true
    })
    if (claimed) abandoned += 1
  }

  const staleUpdates = await models.pendingItemUpdate.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, payInId: true }
  })

  let pendingPurged = 0
  for (const update of staleUpdates) {
    // Claim the row first; a concurrent flip that applied the edit wins the
    // deleteMany race, and the payIn must then stay (the edit is live).
    const claimed = await models.pendingItemUpdate.deleteMany({ where: { id: update.id } })
    if (claimed.count === 0) continue
    await models.payIn.deleteMany({ where: { id: update.payInId } })
    pendingPurged += 1
  }

  return { abandoned, pendingPurged }
}

// pg-boss handler. Runs one sweep per invocation; recurrence is cron-owned
// (pgboss.schedule row abandonFeeItems) — no self-requeue.
export async function abandonFeeItems ({ models }) {
  const out = await runAbandonFeeItemsOnce({ models })
  if (out.abandoned || out.pendingPurged) {
    console.log(`abandonFeeItems: soft-deleted ${out.abandoned} unpaid item(s), purged ${out.pendingPurged} deferred edit(s)`)
  }
}
