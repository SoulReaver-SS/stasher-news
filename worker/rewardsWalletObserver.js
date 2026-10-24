import { lwsClient } from '@/api/monero/lwsClient'
import { freshLwsTransactions, nextLwsCursor } from '@/api/monero/lwsCursor'
import {
  REWARDS_POSTING_MAJOR,
  FEE_MAJORS
} from '@/api/monero/feePool'
import { reverseMapPaymentId, applyDownvoteTransition } from '@/api/monero/downvote'
import { topUpFeePoolIfLow } from '@/api/monero/feePoolDerive'
import { createReorgDetector } from '@/lib/reorgDetector'
import { attributeBountyReceipt, reconcileBountyReceipts } from '@/api/monero/bountyReceipts'
import { moneroUriAmountPiconeros } from '@/lib/format'
import { denormalizeComment, runItemLiveSideEffects } from '@/lib/itemLiveEffects'
import { alert } from '@/lib/alert'
import { logError } from '@/lib/logger'
import { consumeQuotaForFlippedItem, consumeStreakReward } from '@/api/payIn/lib/freebie'
import { applyFeeReceipt, excludeProvisionalFeeReceipt } from '@/api/monero/feeObservation'
import { isSelfSend } from '@/api/monero/selfTip'
import { daemonClient } from '@/api/monero/daemonClient'
import { getReconciliationRawReader } from '@/worker/reconciliationRawTransactions'
import { recoverPlatformFeePids } from '@/worker/platformFeePidRecovery'

const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 15000 }

// rewardsWalletObserver — observes posting/territory fees AND downvote payments paid to
// the platform rewards wallet (Phase 3 Task 5 + Phase 4 Task 4 / spec §3.3, §5.6,
// §6.2). The rewards wallet is the ONLY custodial component; every payment lands
// either on a DEDICATED subaddress (major 1 = posting, major 2 = territory) for
// fees, or on the PRIMARY address (major 0) carrying a payment_id for downvotes.
//
// Each poll fetches incremental outputs from lws for the platform_rewards wallet.
// For each output:
//   - fee subaddress (major 1/2): finds the pending PayIn that reserved that
//     subaddress, idempotently records a FeeObservation (DETECTED), and flips the
//     gated Item.feeStatus PENDING_FEE -> FEE_PAID (or Sub.billingStatus), taking
//     the post/territory live.
//   - primary address + payment_id (Phase 4): reverses the payment_id via the
//     DownvotePidMap, idempotently records an ObservedDownvote (DETECTED), and
//     transitions it to the verified height via applyDownvoteTransition, which
//     owns the LOG-scaled ranking penalty (weightedDownVotes/downPiconeros) —
//     exactly once, on the NULL->height transition (Task 13).
//   - primary address, bounty settlement hash (rewards accounting repair §4):
//     attributes a verified incoming output to its frozen escrow settlement and
//     books the single eligible FeeObservation receipt (BOUNTY_FEE 100% ops, or
//     a BOUNTY_ROLLOVER with an exact mixed split). Unknown/cold outputs and
//     missing settlement metadata book nothing (the latter alerts and retries).
// The confirmFinalizer matures FeeObservation/ObservedDownvote DETECTED -> CONFIRMED
// at REQUIRED_CONFIRMATIONS (separate concern, separate job). Reorg reversal is
// deferred (accepted v1 limitation — consistent with the tip flow).
//
// This module exports TWO things (mirrors worker/confirmFinalizer.js):
//   - runRewardsWalletObserverOnce: the testable per-poll core (no pg-boss). Accepts a
//     `txs` override so tests never touch the network.
//   - rewardsWalletObserver: the pg-boss handler. Fetches txs via lwsClient, runs the
//     core, runs the bounded full-history bounty-receipt recovery pass, and
//     advances the cursor; recurrence is cron-owned (pgboss.schedule row
//     rewardsWalletObserver).

// One poll. `txs` is normally fetched from lws by the handler; tests pass it
// directly. Returns nothing; effects are the FeeObservation/ObservedDownvote rows +
// fee flips / ranking penalties.
export async function runRewardsWalletObserverOnce ({ models, account, txs }) {
  for (const tx of txs || []) {
    await attributeOutput(models, tx, account)
  }
}

// Dispatcher — the single seam the fee, downvote, tip, and bounty branches
// share. The subaddress (fee) branch is Phase 3; the rest are primary-address
// branches distinguished by payment_id / settlement hash.
async function attributeOutput (models, tx, account) {
  if (!account || account.label !== 'platform_rewards') return
  // PHASE 3: attribute posting/territory fees by their receiving subaddress.
  // Short-circuit: a fee subaddress output is never a downvote.
  if (await attributeFeeBySubaddress(models, tx)) return
  // REWARDS ACCOUNTING REPAIR §4: a known bounty settlement hash arriving at
  // the rewards wallet books its receipt. Escrow payouts carry no payment_id,
  // so this is checked before (and independently of) the payment_id branches.
  if (await attributeBountyReceipt({ models, account, tx })) return
  // Integrated platform fees (posting/turf/boost invoices since the
  // integrated-address migration) arrive on the PRIMARY address carrying a
  // "fee:"-namespace payment_id. Checked before the downvote/tip pid branches:
  // a pid that names a fee intent is never reinterpreted as anything else.
  if (tx.payment_id && await attributeIntegratedFee(models, tx, account)) return
  // PHASE 4: downvotes arrive on the PRIMARY address (major 0) carrying a
  // decrypted payment_id that encodes (postId, nonce) via the DownvotePidMap.
  if (tx.payment_id && await attributeDownvoteByPaymentId(models, tx)) return
  // Wallet-less-author tips arrive the same way (primary address + payment_id)
  // but carry a "tip:"-namespace id (disjoint from "dv:"). Attribute them as a
  // TIP_UNWALLETED FeeObservation so the pool + transparency surfaces see them.
  if (tx.payment_id) await attributeTipByPaymentId(models, tx)
}

// Attribute an output to a pending fee by its receiving subaddress. Returns the
// FeeObservation id on a fresh attribution, or null if the output is not at a fee
// subaddress / matches no pending PayIn / was already attributed.
async function attributeFeeBySubaddress (models, tx) {
  const major = tx.recipient?.maj_i
  const minor = tx.recipient?.min_i
  if (!FEE_MAJORS.includes(major)) return null

  const payIn = await models.payIn.findFirst({
    where: { moneroSubaddressMajor: major, moneroSubaddressMinor: minor },
    include: { itemPayIn: true, subPayIn: true }
  })
  if (!payIn) return null

  const feeType = feeTypeFor(major, payIn.payInType)

  // Idempotent insert keyed by @@unique([txHash, recipientMajor, recipientMinor]).
  // ON CONFLICT DO NOTHING means a re-poll of the same tx inserts nothing;
  // RETURNING gives us the row only on the fresh insert. postId/subName are
  // denormalized from the PayIn's ItemPayIn / SubPayIn links for the rewards
  // ledger and the statistics/analytics reads. The flip below runs on BOTH
  // paths: a re-poll of an item whose flip transaction previously failed is
  // how the stranded PENDING_FEE item self-heals.
  const rows = await models.$queryRaw`
    INSERT INTO "FeeObservation" ("txHash","payInId","feeType","postId","subName","recipientMajor","recipientMinor","piconeros","donationRewardsPct","height","state","detectedAt")
    VALUES (${tx.hash}, ${payIn.id}, ${feeType}::"FeeType", ${payIn.itemPayIn?.itemId ?? null}, ${payIn.subPayIn?.subName ?? null}, ${major}, ${minor}, ${tx.piconeros}, ${payIn.donationRewardsPct ?? null}, ${tx.height ?? null}, 'DETECTED'::"ObservedState", NOW())
    ON CONFLICT ("txHash","recipientMajor","recipientMinor") DO NOTHING
    RETURNING id`
  const fresh = rows && rows.length > 0

  // Boost bump fires on a fresh attribution only — a re-poll (conflict) must not
  // re-apply the ranking bump.
  if (fresh && feeType === 'BOOST') {
    try {
      await applyBoostDetected(models, payIn, tx.piconeros)
    } catch (err) {
      // Don't crash the indexer on a ranking-CTE failure; the FeeObservation row
      // already records the boost. (Item columns can be repaired separately.)
      console.error(`rewardsWalletObserver: boost bump failed for payIn ${payIn.id}:`, err?.message || err)
    }
  }

  // Amount gate (underpayment support): the gated Item/Sub only goes live once
  // the CUMULATIVE observed piconeros for this payIn cover the amount its
  // monero: URI quoted (top-ups land as additional FeeObservation rows).
  // A PayIn without a parseable URI is a legacy/ungated fee — keep the old
  // any-payment-flips behavior for it.
  // Runs on BOTH fresh and conflict paths: a re-poll whose observation committed
  // but whose flip transaction failed (timeout/lock contention) is stranded
  // PENDING_FEE, and the flip here is what self-heals it. flipPendingToLive is
  // idempotent (WHERE "feeStatus" = 'PENDING_FEE'), so a re-poll of a healthy
  // paid item is a no-op. On a conflict re-poll of an underpaid tx the same
  // console.warn fires again — simplest consistent behavior, and harmless.
  const expected = payIn.moneroUri ? moneroUriAmountPiconeros(payIn.moneroUri) : null
  // Countable states only (review follow-up): a REORGED row (reorg sweeper) or
  // any other dead state must neither open this flip gate nor inflate the
  // cumulative that feeInvestmentPiconeros records.
  const agg = await models.feeObservation.aggregate({
    _sum: { piconeros: true },
    where: { payInId: payIn.id, state: { in: ['DETECTED', 'CONFIRMED'] } }
  })
  const cumulative = agg._sum.piconeros ?? 0n
  if (expected === null || cumulative >= expected) {
    await flipPendingToLive(models, payIn, cumulative)
  } else {
    console.warn(`rewardsWalletObserver: fee payIn ${payIn.id} underpaid — received ${cumulative} of ${expected} piconeros; awaiting top-up`)
  }
  // Fresh attribution -> the new observation id (callers use it as a truthy
  // short-circuit); re-poll -> null, so attributeOutput falls through to the
  // payment_id branches (a fee subaddress carries no payment_id, so no-op).
  return fresh ? rows[0].id : null
}

// Attribute a primary-address output whose payment_id names an integrated
// platform fee intent. The rewards account's own lws row is the verified
// recipient-side evidence (amount + mined height), so it feeds the shared
// applier directly — the same path as the webhook and the reconciler, with no
// time window (legacy subaddress attribution parity: a late payment is still
// booked). Returns true when the pid belongs to a fee intent (handled or
// refused), so the dispatcher never falls through to the downvote/tip branches;
// false for every other pid, which keeps its existing classification
// (wallet change carries a random dummy pid that matches no intent).
async function attributeIntegratedFee (models, tx, account) {
  const feeMap = await models.subFeePidMap.findUnique({ where: { paymentId: String(tx.payment_id).toLowerCase() } })
  if (!feeMap) return false
  // Owner intents pay the owner's wallet; one surfacing here is not ours.
  if (feeMap.feeType == null) return true
  if (feeMap.recipientAccountId !== account.id || feeMap.recipientAddress !== account.address) {
    alert('critical', 'integrated fee pid seen on a non-recipient account',
      `fee intent ${feeMap.id} (recipient account ${feeMap.recipientAccountId}) matched tx ${tx.hash} on account ${account.id}; not credited`,
      { dedupeKey: `fee-wrong-account-${feeMap.id}-${tx.hash}` })
    return true
  }
  if ((tx.recipient?.maj_i ?? 0) !== 0 || (tx.recipient?.min_i ?? 0) !== 0) return true
  // Exact monetary-closure self-send refusal (never credit rewards-wallet
  // change as an external fee). Subaddresses load only on a fee-pid hit.
  const subaddresses = await models.subaddressIndex.findMany({
    where: { accountId: account.id },
    select: { majorIndex: true, minorIndex: true }
  })
  if (isSelfSend({ ...account, subaddresses }, tx)) {
    const excluded = await excludeProvisionalFeeReceipt(models, feeMap, tx.hash)
    if (excluded > 0) {
      alert('warn', 'platform fee self-payment refused',
        `fee intent ${feeMap.id} tx ${tx.hash}: payer shares the rewards account (change-inflated); provisional receipt excluded`,
        { dedupeKey: `fee-selfpay-${feeMap.id}-${tx.hash}` })
    }
    return true
  }
  const feePayIn = await models.payIn.findUnique({ where: { moneroPaymentId: feeMap.paymentId } })
  await applyFeeReceipt(models, {
    feeMap,
    feePayIn,
    txHash: tx.hash,
    piconeros: tx.piconeros,
    height: tx.height ?? null,
    confirmations: 0 // never fabricated — confirmFinalizer matures height-bearing rows
  })
  return true
}

// Apply the boost ranking bump (A-14): increment the item's persistent boost
// weight 1:1 with the observed on-chain piconeros (the ranktop trigger weighs
// boost at 1, matching tips). Comments also propagate commentBoost to
// ancestors, mirroring the legacy boost onPaid SQL.
export async function applyBoostDetected (models, payIn, piconeros) {
  const { itemId } = await models.itemPayIn.findUnique({ where: { payInId: payIn.id } })
  if (!itemId) return
  await models.$executeRaw`
    WITH item_boosted AS (
      UPDATE "Item"
      SET boost = boost + ${piconeros}::BIGINT
      WHERE id = ${itemId}::INTEGER
      RETURNING *
    )
    UPDATE "Item"
    SET "commentBoost" = "Item"."commentBoost" + ${piconeros}::BIGINT
    FROM (
      SELECT "Item".id
      FROM "Item", item_boosted
      WHERE "Item".path @> item_boosted.path AND "Item".id <> item_boosted.id
      ORDER BY "Item".id
    ) AS ancestors
    WHERE "Item".id = ancestors.id`
}

// Inverse of applyBoostDetected for the reverseStaleDetections sweep (audit
// A-1): give back the boost weight an unconfirmed 0-conf receipt bumped.
// GREATEST(...,0) floors guard against pre-migration drift.
export async function reverseBoostDetected (models, payIn, piconeros) {
  const row = await models.itemPayIn.findUnique({ where: { payInId: payIn.id } })
  if (!row?.itemId) return
  await models.$executeRaw`
    WITH item_unboosted AS (
      UPDATE "Item"
      SET boost = GREATEST(boost - ${piconeros}::BIGINT, 0)
      WHERE id = ${row.itemId}::INTEGER
      RETURNING *
    )
    UPDATE "Item"
    SET "commentBoost" = GREATEST("Item"."commentBoost" - ${piconeros}::BIGINT, 0)
    FROM (
      SELECT "Item".id
      FROM "Item", item_unboosted
      WHERE "Item".path @> item_unboosted.path AND "Item".id <> item_unboosted.id
      ORDER BY "Item".id
    ) AS ancestors
    WHERE "Item".id = ancestors.id`
}

// Attribute a primary-address output carrying a payment_id to a downvote. Looks
// up the payment_id in the DownvotePidMap reverse map; if found, idempotently
// records an ObservedDownvote (DETECTED) and marks the map consumed. The row is
// inserted PROVISIONAL (height NULL) even when lws already reports a height:
// the penalty is owned by applyDownvoteTransition's NULL->height CAS, so writing
// the height into the insert would make that CAS unreachable and silently lose
// the penalty on the observer-first path (Task 13). The insert's ON CONFLICT DO
// NOTHING guard makes a re-poll (or a raced webhook insert) a no-op; only the
// fresh insert reaches the transition.
async function attributeDownvoteByPaymentId (models, tx) {
  const map = await reverseMapPaymentId(tx.payment_id, models)
  if (!map) return null

  const rows = await models.$queryRaw`
    INSERT INTO "ObservedDownvote" ("txHash","postId","downvoterId","paymentId","piconeros","height","state","detectedAt")
    VALUES (${tx.hash}, ${map.postId}, ${map.userId}::INT, ${tx.payment_id}, ${tx.piconeros}, NULL, 'DETECTED'::"ObservedState", NOW())
    ON CONFLICT ("txHash","paymentId") DO NOTHING
    RETURNING id`
  if (!rows || rows.length === 0) return null

  // The shared transition owns the penalty (exactly once). A still-mempool tx
  // (lws height null) stays provisional. Recovery is automatic: while the
  // rewards account is unscannable the finalizer's backfill skips and retries
  // each run; once scannable, the transition (and penalty) fire exactly once —
  // deferred, not lost (observer/fee attribution/health probe share the account
  // and fail loudly meanwhile).
  await applyDownvoteTransition({
    models,
    dv: { id: rows[0].id, postId: map.postId, downvoterId: map.userId },
    height: tx.height,
    piconeros: tx.piconeros
  })

  await models.downvotePidMap.update({ where: { paymentId: tx.payment_id }, data: { consumedAt: new Date() } })
  return rows[0].id
}

// Attribute a primary-address output carrying a "tip:"-namespace payment_id to
// a wallet-less-author tip. Looks the payment_id up on ObservedTip; if found,
// idempotently records a FeeObservation(TIP_UNWALLETED, payInId=null) so the
// rewards pool and transparency surfaces reflect the inflow. confirmFinalizer
// matures it DETECTED -> CONFIRMED like every other fee. Returns the
// FeeObservation id on a fresh attribution, or null if no tip matches / already
// attributed (so the dispatcher can short-circuit).
async function attributeTipByPaymentId (models, tx) {
  const tip = await models.observedTip.findFirst({ where: { paymentId: tx.payment_id } })
  if (!tip) return null

  const major = tx.recipient?.maj_i ?? 0
  const minor = tx.recipient?.min_i ?? 0
  const rows = await models.$queryRaw`
    INSERT INTO "FeeObservation" ("txHash","payInId","feeType","postId","subName","recipientMajor","recipientMinor","piconeros","height","state","detectedAt")
    VALUES (${tx.hash}, NULL, 'TIP_UNWALLETED'::"FeeType", ${tip.postId}, NULL, ${major}, ${minor}, ${tx.piconeros}, ${tx.height ?? null}, 'DETECTED'::"ObservedState", NOW())
    ON CONFLICT ("txHash","recipientMajor","recipientMinor") DO NOTHING
    RETURNING id`
  if (!rows || rows.length === 0) return null
  return rows[0].id
}

function feeTypeFor (major, payInType) {
  if (major === REWARDS_POSTING_MAJOR) return 'POSTING'
  if (payInType === 'DONATE') return 'DONATE'
  if (payInType === 'TIP_UNWALLETED') return 'TIP_UNWALLETED'
  if (payInType === 'BOOST') return 'BOOST'
  // territory major: the PayIn's type tells us which territory fee it is
  if (payInType === 'TERRITORY_BILLING') return 'TERRITORY_BILLING'
  if (payInType === 'TERRITORY_UNARCHIVE') return 'TERRITORY_UNARCHIVE'
  if (payInType === 'TERRITORY_UPDATE') return 'TERRITORY_UPDATE'
  return 'TERRITORY_CREATE'
}

// Flip the gated Item/Sub to live. Idempotent: the WHERE on the PENDING state
// means a second call (or a fee already paid by another path) is a no-op.
export async function flipPendingToLive (models, payIn, feePiconeros) {
  if (payIn.payInType === 'ITEM_CREATE') {
    // The item goes live atomically with its feeStatus/feeInvestment write.
    // Everything else is BEST-EFFORT and runs after the flip commits, each
    // effect isolated so a persistent failure can never roll the flip back nor
    // wedge the cursor (R14: the cursor only advances after a clean poll, so a
    // throw anywhere below would freeze ALL fee attribution — the 2026-08-10
    // incident class). The observed fee is credited as the item's non-tip
    // investment so the item_net_investment trigger produces netInvestment >=
    // 0.001 XMR (the new posts-filter default). The fee NEVER touches
    // Item.piconeros (tip total) or boost (ranking), so tip display and
    // ranktop/ranklit are unaffected.
    const flipped = await models.$transaction(async tx => {
      // A soft-deleted item can never enter the live path: the author's
      // deletion may land between fee issuance and observation (it keeps the
      // PENDING_FEE linkage), and publishing deleted content would fire
      // notifications, consume quota, and denormalize for a removed item. The
      // receipt is still recorded by the caller — only the flip refuses; the
      // sweep later cleans the stale linkage.
      const rows = await tx.$queryRaw`
        UPDATE "Item"
        SET "feeStatus" = 'FEE_PAID',
            "feeInvestmentPiconeros" = GREATEST("feeInvestmentPiconeros", ${feePiconeros}::bigint)
        WHERE "feePayInId" = ${payIn.id} AND "feeStatus" = 'PENDING_FEE'
          AND "deletedAt" IS NULL
        RETURNING id`
      if (!rows || rows.length === 0) return null
      // One fetch, with the includes runItemLiveSideEffects needs. Safe to reuse
      // the in-tx row post-commit: the flip only changes feeStatus /
      // feeInvestmentPiconeros, none of the notification-relevant fields.
      return await tx.item.findFirst({
        where: { id: rows[0].id },
        include: {
          mentions: true,
          itemReferrers: { include: { refereeItem: true } },
          user: true
        }
      })
    }, TRANSACTION_OPTIONS)
    if (flipped) {
      // R01: an item that was in-quota at creation but born PENDING_FEE (its
      // only cost was the upload fee) consumes its free quota HERE — the
      // creation-time increments skip non-freeborn items. Exactly-once (only
      // the winning flip branch reaches this) and best-effort: its OWN
      // transaction, so a failure (a missing/expired credit, or any DB error —
      // it surfaces rather than being swallowed) logs + alerts instead of
      // rolling the flip back or wedging the cursor. The local timeout gives
      // headroom to the quota transaction, which takes the user reward lock,
      // which can legitimately wait behind a concurrent payIn/quest-banking
      // transaction longer than Prisma's 5s default. An over- or under-shot
      // count is inert (free-left clamps at 0; the window reset re-baselines).
      if (flipped.feeQuotaEligible) {
        try {
          await models.$transaction(tx => consumeQuotaForFlippedItem(tx, { item: flipped, userId: payIn.userId }), TRANSACTION_OPTIONS)
        } catch (err) {
          logError('flipPendingToLive: quota consumption failed', err)
          alert('critical', 'flipped item quota consumption failed',
            `payIn ${payIn.id}, item ${flipped.id}, user ${payIn.userId}: ${err?.message || err}`,
            { dedupeKey: `flip-quota-${payIn.id}` })
        }
      }
      // The comment's ancestor denormalization (counters + Reply rows) runs in
      // its own best-effort transaction for the same reason: the flip is the
      // money-relevant state and is already committed; counts are display
      // state, repairable from the alert's payIn/item ids. Moving it out of
      // the flip tx is what makes the internal catch safe for DB-level errors
      // (a poisoned flip tx would fail COMMIT regardless of the catch).
      if (flipped.parentId) {
        try {
          await models.$transaction(tx => denormalizeComment(tx, flipped), TRANSACTION_OPTIONS)
        } catch (err) {
          logError('flipPendingToLive: comment denormalization failed', err)
          alert('critical', 'comment denormalization failed after fee flip',
            `payIn ${payIn.id}, item ${flipped.id}: ${err?.message || err}`,
            { dedupeKey: `flip-denormalize-${payIn.id}` })
        }
      }
      // creation side effects (notifications, verified-badge check) fire once,
      // after the flip commits — onPaidSideEffects suppressed them at creation
      await runItemLiveSideEffects(models, flipped)
    }
  } else if (payIn.payInType === 'ITEM_UPDATE') {
    // Loaded lazily: api/payIn/types/itemUpdate statically imports the
    // ESM-only lexical mention parser (via @/lib/lexical/server/mentions) and
    // the API resolver layer — a static import here breaks every jest suite
    // that imports this module without stubbing the parser, and bloats worker
    // boot. The deferred-apply path is rare (one call per fee-bearing edit
    // whose fee lands), so a cached dynamic import is free.
    //
    // An apply (or import) failure must NEVER fail this run: the observer
    // advances its cursor only after a clean poll, so a throw here would
    // re-process the same tx on every retry (conflict path) and re-run this
    // flip — freezing ALL fee attribution until manual intervention (the
    // 2026-08-10 incident class). Mirrors the applyBoostDetected isolation.
    // The pending edit survives the rolled-back apply and is purged by
    // abandonFeeItems; the fee is already recorded by the FeeObservation.
    try {
      const { applyPendingItemUpdate } = await import('@/api/payIn/types/itemUpdate')
      const applied = await applyPendingItemUpdate(models, payIn)
      if (applied) console.log(`flipPendingToLive: applied deferred ITEM_UPDATE payIn ${payIn.id}`)
    } catch (err) {
      logError('flipPendingToLive: applying deferred ITEM_UPDATE failed', err)
      alert('critical', 'deferred edit apply failed', `payIn ${payIn.id}: ${err?.message || err}`, { dedupeKey: `applyPendingItemUpdate-${payIn.id}` })
    }
  } else if (['DONATE', 'TIP_UNWALLETED', 'BOOST'].includes(payIn.payInType)) {
    // no gated record to flip — the FeeObservation itself is the effect
  } else if (['TERRITORY_CREATE', 'TERRITORY_BILLING', 'TERRITORY_UNARCHIVE', 'TERRITORY_UPDATE'].includes(payIn.payInType)) {
    // Best-effort with its own guard: on failure the row stays PENDING_FEE
    // (visibly unpaid) instead of wedging the cursor.
    try {
      const flipped = await models.sub.updateMany({
        where: { billingPayInId: payIn.id, billingStatus: 'PENDING_FEE' },
        data: { billingStatus: 'PAID' }
      })
      if (flipped.count > 0 && payIn.payInType === 'TERRITORY_CREATE') {
        // The creation's fee was observed: consume the day-7 TURF_DISCOUNT the
        // user held at quote time (spec §5: consumed only on a successful
        // creation — never on a submitted-but-unpaid one). Best-effort, in its
        // own try, mirroring the quota consumption above.
        try {
          await consumeStreakReward(models, payIn.userId, 'TURF_DISCOUNT')
        } catch (err) {
          logError('flipPendingToLive: turf discount consumption failed', err)
          alert('critical', 'turf discount consumption failed after territory flip',
            `payIn ${payIn.id}, user ${payIn.userId}: ${err?.message || err}`,
            { dedupeKey: `flip-turfdiscount-${payIn.id}` })
        }
      }
    } catch (err) {
      logError('flipPendingToLive: territory billing flip failed', err)
      alert('critical', 'territory billing flip failed after fee observation',
        `payIn ${payIn.id}: ${err?.message || err}`,
        { dedupeKey: `flip-territory-${payIn.id}` })
    }
  }

  // The fee that unlocks the >10MB uploads was just observed: flip them paid so
  // uploadFees stops charging them (the paid gate in api/resolvers/upload.js).
  // The UploadPayIn rows live on the MEDIA_UPLOAD beneficiaries of the observed
  // payIn (the benefactor carries the subaddress and the fee), so both shapes
  // are matched. Runs for ANY observed fee (ITEM_CREATE / ITEM_UPDATE /
  // TERRITORY_* / DONATE / ...); it is a no-op when the payIn covers no uploads.
  // Idempotent (SET paid = true), so re-polls that now reach this point on the
  // conflict path are harmless.
  if (payIn?.id != null) {
    try {
      await models.$executeRaw`
        UPDATE "Upload"
        SET "paid" = true
        FROM "UploadPayIn"
        WHERE ("UploadPayIn"."payInId" = ${payIn.id}
          OR "UploadPayIn"."payInId" IN (SELECT id FROM "PayIn" WHERE "benefactorId" = ${payIn.id}))
          AND "Upload"."id" = "UploadPayIn"."uploadId"`
    } catch (err) {
      // Consequence is only that an upload stays chargeable on re-attach
      // (the documented re-attachment path) — never a wedge.
      logError('flipPendingToLive: upload paid-flip failed', err)
      alert('critical', 'upload paid-flip failed after fee observation',
        `payIn ${payIn.id}: ${err?.message || err}`,
        { dedupeKey: `flip-uploads-${payIn.id}` })
    }
  }
}

// pg-boss handler. Fetches incremental txs for the rewards wallet, runs the
// attribution core, and advances the cursor. Recurrence is cron-owned
// (pgboss.schedule row rewardsWalletObserver). The cursor uses the
// same (lastTxId) forward dimension as moneroIndexer; full reorg reconciliation
// for fees is deferred (a reorged fee re-appears in a later poll and the
// idempotent FeeObservation insert handles it; confirmFinalizer gates finality).
// Reorg DETECTION (Task D5) runs here on lws's top-level blockchain_height: a
// regression vs the last poll fires a debounced critical alert. Reversal stays
// deferred (detect+alert only).
const detectReorg = createReorgDetector()

// Select the platform rewards account for polling. Deterministic AND
// viewKey-gated: test suites (boost payIn, the observer suites themselves)
// seed viewKey-less platform_rewards rows against the live DB; a bare
// findFirst can pick one, viewKeyFor throws, and the job run dies failed (in
// the old self-requeue era this froze ALL fee attribution until a worker
// restart — observed live 2026-08-10: item 2755 stuck PENDING_FEE; under
// cron-owned recurrence every tick would just fail the same way).
// The viewKey filter excludes test rows outright; orderBy id asc matches the
// repo's lookup convention (walletless plan Task 2).
export async function findRewardsAccount (models) {
  return models.moneroAccount.findFirst({
    where: {
      label: 'platform_rewards',
      network: (process.env.MONERO_NETWORK || 'STAGENET').toUpperCase(),
      viewKey: { isNot: null }
    },
    orderBy: { id: 'asc' },
    include: { viewKey: true }
  })
}

export async function rewardsWalletObserver ({ models, lws = lwsClient, detectReorg: detect = detectReorg, rawReader = getReconciliationRawReader(daemonClient) }) {
  // Recurrence is cron-owned (pgboss.schedule row rewardsWalletObserver); no
  // self-requeue. A failed run is retried per the schedule options and the
  // next cron tick re-creates the run either way.
  const account = await findRewardsAccount(models)
  if (account) {
    const previousCursor = account.lastTxId ?? null
    const resp = await lws.getAddressTxs(account, account.lastTxId, account.lastBlockHash)
    if (resp && typeof resp.blockchain_height === 'number') detect(resp.blockchain_height)
    const txs = (resp && resp.transactions) || []
    // lws v1.0.4 appends mempool rows with response-position IDs; validating
    // and slicing through the pure helpers BEFORE any attribution aborts the
    // whole poll on malformed metadata and keeps pending rows replayable
    // without letting their IDs touch the durable watermark.
    const fresh = freshLwsTransactions(txs, previousCursor)
    const next = nextLwsCursor(txs, previousCursor)
    await runRewardsWalletObserverOnce({ models, account, txs: fresh })

    // Bounded bounty-receipt recovery (rewards accounting repair §4), BEFORE
    // the cursor advance: a settlement output scanned before the sender's DB
    // persist completed sits behind the cursor and would never re-enter the
    // fresh slice. Recovery therefore scans the FULL history (the incremental
    // response above only covers the cursor window) and attributes only known
    // settlement hashes that still lack a wallet receipt — bounded and
    // oldest-first inside reconcileBountyReceipts. Best-effort: a recovery
    // failure must not wedge ordinary fee/downvote/tip attribution (the
    // 2026-08-10 incident class) — it is alerted and retried next tick.
    let recoveryTxs = null
    try {
      recoveryTxs = account.lastTxId == null || lws.addressTxsMode === 'full'
        ? txs // the incremental fetch was already a full scan
        : (((await lws.getAddressTxs(account, 0, null)) || {}).transactions || [])
      await reconcileBountyReceipts({ models, account, transactions: recoveryTxs })
    } catch (err) {
      logError('rewardsWalletObserver: bounty receipt recovery failed', err)
      alert('critical', 'bounty receipt recovery failed',
        `rewards wallet account ${account.id}: ${err?.message || err} — ordinary attribution continues; recovery retries next tick`,
        { dedupeKey: 'bounty-receipt-recovery-failed' })
    }

    // Integrated platform fee raw-pid recovery over the same full-history
    // response (worker/platformFeePidRecovery.js): books fee receipts whose
    // lws row carries a wrong (payer-side) decrypted pid. Same best-effort
    // isolation as the bounty pass — it is independent of the cursor (full
    // history every tick), so a failed run simply retries next minute.
    if (recoveryTxs) {
      try {
        await recoverPlatformFeePids({ models, account, transactions: recoveryTxs, rawReader })
      } catch (err) {
        logError('rewardsWalletObserver: platform fee pid recovery failed', err)
        alert('critical', 'platform fee pid recovery failed',
          `rewards wallet account ${account.id}: ${err?.message || err} — ordinary attribution continues; recovery retries next tick`,
          { dedupeKey: 'platform-fee-pid-recovery-failed' })
      }
    }

    // The candidate watermark counts MINED rows only (mempool IDs are
    // response positions). Persist forward-only after required processing
    // succeeded and only on an actual advance — a no-op proposal (empty
    // response, mined rows behind the cursor) writes nothing.
    if (next !== null && (previousCursor === null || next > previousCursor)) {
      await models.moneroAccount.updateMany({
        where: { id: account.id, OR: [{ lastTxId: null }, { lastTxId: { lt: next } }] },
        data: { lastTxId: next }
      })
    }
  }
  // Auto top-up: extend the fee subaddress pool when AVAILABLE dips below the
  // threshold (default 100). Runs on every poll; the check is a cheap count and
  // derivation only fires when a major is low. Errors are logged, never fatal.
  try {
    await topUpFeePoolIfLow(models, { account })
  } catch (err) {
    console.error('fee-pool auto top-up failed:', err?.message || err)
  }
}
