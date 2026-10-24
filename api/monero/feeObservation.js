import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { moneroUriAmountPiconeros } from '@/lib/format'
import { alert } from '@/lib/alert'
import { applySubFeeReceipt } from '@/api/monero/subFeeObservation'
import { applyBoostDetected, flipPendingToLive } from '@/worker/rewardsWalletObserver'

// Shared integrated-fee receipt entry point — the ONLY writer of receipts for
// SubFeePidMap intents. Callers (lws webhook, rewardsWalletObserver,
// reconcileOwnerFeeLegs) verify the receipt first and pass the intent; the
// intent decides the ledger:
//   - owner intent (feeType NULL)    -> ObservedSubFee via applySubFeeReceipt
//   - platform intent (feeType set)  -> FeeObservation at recipient (0,0)
// Every frozen column of a platform receipt (feeType, postId, subName,
// paymentId) is copied from the intent, never from the PayIn's current links,
// env, or the caller's scan context. feePayIn may be null (abandoned PayIn,
// late payment): cash is still recorded with payInId NULL and no gate runs.
export async function applyFeeReceipt (models, { feeMap, feePayIn, txHash, piconeros, height, confirmations }) {
  if (feeMap.feeType == null) {
    return await applySubFeeReceipt(models, { feePayIn, paymentId: feeMap.paymentId, txHash, piconeros, height, confirmations })
  }
  return await applyPlatformFeeReceipt(models, { feeMap, feePayIn, txHash, piconeros, height, confirmations })
}

// Platform receipt: the applySubFeeReceipt state machine on the platform
// ledger. Inserted PROVISIONALLY (height NULL — a daemon-verified 0-conf claim
// is display-only); a chain-verified sight claims the height through the
// atomic NULL->height CAS, which is the exactly-once signal for the boost bump.
// Every statement below is keyed by (txHash, (0,0), issued paymentId), so a
// pre-existing (hash,0,0) row bound to anything else is never touched.
async function applyPlatformFeeReceipt (models, { feeMap, feePayIn, txHash, piconeros, height, confirmations }) {
  const paymentId = feeMap.paymentId
  await models.$queryRaw`
    INSERT INTO "FeeObservation" ("txHash","paymentId","payInId","feeType","postId","subName","recipientMajor","recipientMinor","piconeros","height","confirmations","state","detectedAt","walletReceipt")
    VALUES (${txHash}, ${paymentId}, ${feePayIn?.id ?? null}, ${feeMap.feeType}::"FeeType", ${feeMap.postId ?? null}, ${feeMap.subName ?? null}, 0, 0, ${piconeros}, NULL, 0, 'DETECTED'::"ObservedState", NOW(), true)
    ON CONFLICT ("txHash","recipientMajor","recipientMinor") DO NOTHING`
  const [bound] = await models.$queryRaw`
    SELECT piconeros, height FROM "FeeObservation"
    WHERE "txHash" = ${txHash} AND "recipientMajor" = 0 AND "recipientMinor" = 0 AND "paymentId" = ${paymentId}`
  if (!bound) {
    // The (hash,0,0) receipt already exists under another binding (another
    // pid, or a non-fee receipt): one output is one ledger row, never rebound.
    alert('critical', 'integrated fee receipt binding conflict',
      `fee intent ${feeMap.id} (pid ${paymentId}): tx ${txHash} at (0,0) is already booked under a different binding; nothing recorded`,
      { dedupeKey: `fee-binding-conflict-${txHash}` })
    return { transitioned: false, cumulative: 0n }
  }

  let transitioned = false
  if (height != null) {
    // The state guard keeps a refused (EXCLUDED) or reversed (REORGED) row
    // unclaimable forever; the amount is corrected to the verified value.
    const claimed = await models.$queryRaw`
      UPDATE "FeeObservation"
      SET height = ${height}, piconeros = ${piconeros}, confirmations = ${confirmations}
      WHERE "txHash" = ${txHash} AND "recipientMajor" = 0 AND "recipientMinor" = 0 AND "paymentId" = ${paymentId}
        AND height IS NULL AND state = 'DETECTED'::"ObservedState"
      RETURNING id`
    transitioned = claimed.length > 0
    if (transitioned && bound.height == null && bound.piconeros !== piconeros) {
      alert('warn', 'platform fee receipt amount corrected at height transition',
        `fee intent ${feeMap.id} tx ${txHash}: verified at ${piconeros} piconeros vs provisional ${bound.piconeros} piconeros; counted amount corrected`,
        { dedupeKey: `fee-receipt-corrected-${txHash}` })
    }
  }

  let cumulative = 0n
  if (feeMap.feeType === 'BOOST') {
    // No quote gate: the bump is the actual verified amount, on the exactly-
    // once CAS transition only (never provisional, never on replay). Boost
    // PayIns are never deleted, so the item resolves through it.
    if (transitioned && feePayIn) {
      try {
        await applyBoostDetected(models, feePayIn, piconeros)
      } catch (err) {
        console.error(`feeObservation: boost bump failed for payIn ${feePayIn.id}:`, err?.message || err)
      }
    }
  } else if (feePayIn) {
    // Cumulative gate over COUNT-ELIGIBLE (height-bearing, live-state)
    // receipts against the stored FULL quote, re-evaluated on every replay so
    // a receipt whose flip previously failed self-heals. Integrated invoices
    // never inherit the legacy any-payment-on-unparseable-URI fallback: the
    // URI quote must be positive and agree with the intent.
    const expected = feePayIn.moneroUri ? moneroUriAmountPiconeros(feePayIn.moneroUri) : null
    const counted = await models.feeObservation.aggregate({
      _sum: { piconeros: true },
      where: { payInId: feePayIn.id, height: { not: null }, state: { in: ['DETECTED', 'CONFIRMED'] } }
    })
    cumulative = counted._sum.piconeros ?? 0n
    if (expected == null || expected <= 0n || expected !== feeMap.amountPiconeros) {
      alert('critical', 'integrated fee quote unreadable — settlement refused',
        `payIn ${feePayIn.id} (fee intent ${feeMap.id}): URI quote ${expected} vs intent ${feeMap.amountPiconeros}; receipt recorded, gate not opened`,
        { dedupeKey: `fee-quote-mismatch-${feePayIn.id}` })
    } else if (cumulative >= expected) {
      await flipPendingToLive(models, feePayIn, cumulative)
    }
  }

  // N-conf maturity of THIS receipt: verified height + chain-derived depth
  // only (callers never pass a callback-claimed count). Replays no-op.
  if (confirmations >= REQUIRED_CONFIRMATIONS) {
    await models.$executeRaw`
      UPDATE "FeeObservation"
      SET state = 'CONFIRMED', confirmations = ${confirmations}, "confirmedAt" = NOW()
      WHERE "txHash" = ${txHash} AND "recipientMajor" = 0 AND "recipientMinor" = 0 AND "paymentId" = ${paymentId}
        AND height IS NOT NULL AND state = 'DETECTED' AND "walletReceipt" = true`
  }
  return { transitioned, cumulative }
}

// Self-send refusal for a fee intent: exclude any still-provisional receipt of
// this tx in the intent's own ledger. Returns the excluded row count.
export async function excludeProvisionalFeeReceipt (models, feeMap, txHash) {
  if (feeMap.feeType == null) {
    return await models.$executeRaw`
      UPDATE "ObservedSubFee" SET state = 'EXCLUDED'::"ObservedState"
      WHERE "tx_hash" = ${txHash} AND "payment_id" = ${feeMap.paymentId} AND height IS NULL`
  }
  return await models.$executeRaw`
    UPDATE "FeeObservation" SET state = 'EXCLUDED'::"ObservedState"
    WHERE "txHash" = ${txHash} AND "recipientMajor" = 0 AND "recipientMinor" = 0
      AND "paymentId" = ${feeMap.paymentId} AND height IS NULL`
}
