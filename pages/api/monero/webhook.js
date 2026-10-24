import { PrismaClient, Prisma } from '@prisma/client'
import { applyTipDetected } from '@/api/monero/ranking'
import { lwsClient } from '@/api/monero/lwsClient'
import { daemonClient } from '@/api/monero/daemonClient'
import { BOSS_RETRY, REQUIRED_CONFIRMATIONS, WEBHOOK_MISS_CHECK_DELAY_SECONDS } from '@/lib/constants'
import { moneroWebhooksReceivedTotal, moneroDetectionLevelTotal } from '@/lib/metrics'
import { alert } from '@/lib/alert'
import { logInfo, logError } from '@/lib/logger'
import { isUniqueViolation } from '@/lib/error'
import { driveBountyFunding, recordBountyReceipt, bountyExpectedPiconeros } from '@/api/monero/bountyFunding'
import { applyDownvoteTransition } from '@/api/monero/downvote'
import { shouldExcludeTip, resolveItemSubName, lookupTipTx, recheckDetectedTip, isSelfSend } from '@/api/monero/selfTip'
import { applyFeeReceipt, excludeProvisionalFeeReceipt } from '@/api/monero/feeObservation'
import { resolveFeeAccount } from '@/api/monero/ownerFeeLeg'
import { parsePiconeros, verifyReceiptAmount, ReceiptLookupError } from '@/api/monero/receiptVerification'
import { moneroUriAmountPiconeros } from '@/lib/format'
import { maybeGrantVerifiedBadge } from '@/api/verifiedBadge'
import { safeEqual } from '@/lib/domains/auth'
import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/client-ip'

// lws tx-confirmation webhook receiver (spec §4.4).
//
// lws pushes callbacks at 0-conf (detection) and at each subsequent
// confirmation up to the requested ceiling. The receiver drives the
// ObservedTip state machine:
//   PENDING  -> DETECTED  (0-conf callback: record tx, bump Item.msats)
//   DETECTED -> CONFIRMED (N-conf callback: bump User.stackedPiconeros)
//
// Detection has two verification levels (0-conf design, Component C). lws
// reports the tx with its amount and chain height, but its REST API cannot see
// mempool txs — the structural cause of the early-callback miss (not a benign
// race that self-resolves). monerod's daemon level therefore carries 0-conf
// detection: the raw tx (mempool included) must decrypt to the claimed payment
// id under the recipient's view key AND own an output of the recipient. A
// daemon verdict proves tx + pid + recipient output but never the RingCT
// amount, so only detection branches accept it (`allowProvisional: true`); a
// daemon-detected row is left UNSTAMPED (`amountVerifiedAt` NULL) for the first
// lws sight to trust-correct, and credit/confirmation branches accept lws only
// — no value ever moves on a daemon verdict.
//
// Self-tip exclusion (spec §2.3) runs at the 0-conf claim AND is re-run once
// the tx is mined: lws cannot report spent_outputs for a mempool tx, so the
// 0-conf self-send check can fail open. recheckDetectedTip re-runs it at the
// first callback carrying a block height and at the N-conf claim (before any
// author credit) — reversing the provisional ranking delta when a wash tip is
// caught late. The same re-check binds the STORED amount/txHash to the chain
// tx (CHAIN_MISMATCH), closing the credit path for DETECTED rows forged
// through the pre-verification webhook.
//
// Payment IDs that match no tip ("bn:" bounty namespace) fall through to the
// bounty branch, which drives the ObservedBounty state machine:
//   PENDING  -> DETECTED  (0-conf callback: record tx/height/actual piconeros,
//                          consume the BountyPidMap)
//   DETECTED -> CONFIRMED (N-conf callback: flip Item to FUNDED with the
//                          actual on-chain amount and freeze the fee terms on
//                          the Item — see driveBountyFunding)
//
// lws treats any non-200 as a delivery failure and retries, so every path
// returns 200 except auth failures (401) and non-POST requests (405).
// Idempotency: the PENDING->DETECTED transition uses an atomic conditional
// UPDATE (... WHERE state = 'PENDING') inside a Serializable transaction.
// reconcilePendingTips is a second concurrent claimer for the same PENDING
// tip (a missed 0-conf webhook); the conditional claim ensures exactly one
// claimer wins (rowCount > 0) and only it applies the ranking delta, so the
// tip is never double-counted. A retried callback for an already-advanced
// state loses the claim (state is no longer PENDING) and is a no-op.

const prisma = new PrismaClient()

export async function handleWebhook (req, res, models = prisma, monero = lwsClient, daemon = daemonClient) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})

  // monero-lws delivers the auth token in the JSON body ("token" field), not a
  // header; keep x-lws-token as a compat fallback. Fail closed when neither matches.
  const headerToken = req.headers && req.headers['x-lws-token']
  const expected = process.env.LWS_WEBHOOK_TOKEN
  if (!expected) {
    // Fail closed: an unconfigured token must never accept money-moving callbacks.
    // (Task 2's validator makes this unreachable in prod; this is the belt-and-suspenders.)
    if (process.env.NODE_ENV === 'production') return res.status(401).end()
    // dev convenience: no token configured -> open
  } else if (!safeEqual(headerToken, expected) && !safeEqual(body.token, expected)) {
    return res.status(401).end()
  }

  moneroWebhooksReceivedTotal.inc()

  // Schedule the delayed miss check for a tip receipt whose early lookup found
  // no tx (tx_not_found). One-shot, startafter +WEBHOOK_MISS_CHECK_DELAY_SECONDS,
  // singletonKey per paymentId so lws's per-block callbacks and delivery retries
  // collapse into a single job. Best-effort: this is alert instrumentation, so a
  // scheduling failure is logged and never changes the webhook's response.
  async function scheduleWebhookMissCheck ({ paymentId, piconeros, context }) {
    try {
      await models.$executeRaw`
        INSERT INTO pgboss.job (id, name, data, retrylimit, retrydelay, retrybackoff, startafter, singletonkey)
        VALUES (gen_random_uuid(), 'webhookMissCheck',
                jsonb_build_object('paymentId', ${paymentId}, 'piconeros', ${piconeros.toString()}, 'context', ${context}),
                ${BOSS_RETRY.retryLimit}, ${BOSS_RETRY.retryDelay}, ${BOSS_RETRY.retryBackoff},
                now() + ${WEBHOOK_MISS_CHECK_DELAY_SECONDS} * interval '1 second',
                'webhookMissCheck:' || ${paymentId})
        ON CONFLICT DO NOTHING`
    } catch (err) {
      logError('webhook: miss-check schedule failed', err)
    }
  }

  // Verify the callback against the chain before any state change. Returns the
  // verdict on success, or null after responding:
  //   - transient lookup failure -> 503 (lws retries; no alert)
  //   - tx_not_found -> structured log + 200 no-op (BOTH sources missed: lws's
  //     REST API cannot see mempool txs and the daemon fallback either lacks
  //     the hash or is unreachable); tip callers additionally schedule the
  //     delayed miss check
  //   - hash/amount mismatch -> immediate WARN + 200 no-op
  // `daemon` is passed to every caller now: detection callers use it for the
  // provisional (daemon-level) fallback AND every caller uses it to corroborate
  // the claimed payment id when lws reports a different/absent pid (the
  // hash-first lookup binds the hash; pid binding needs the raw tx extra —
  // receiptVerification.js corroborateClaimedPid). Credit callers pass
  // `daemonFallback: false` so the discarded provisional-verdict path never
  // spends the RPC; corroboration itself only fires on a pid mismatch.
  async function verifyOrReject ({ account, paymentId, piconeros, txHash, tx = null, context, deferMiss = false, daemon = null, daemonFallback = true, allowProvisional = false }) {
    let verdict
    try {
      verdict = await verifyReceiptAmount({ models, monero, daemon, daemonFallback, account, paymentId, piconeros, txHash, tx })
    } catch (err) {
      if (err instanceof ReceiptLookupError) {
        res.status(503).end()
        return null
      }
      throw err
    }
    // Observability (single seam for every branch): one increment per verdict.
    // level: lws | daemon | skipped (unscannable, fail-open) | rejected
    // (hash/amount mismatch or both-sources miss). A daemon verdict reaching a
    // credit caller would surface here even though the allowProvisional gate
    // below no-ops it.
    moneroDetectionLevelTotal.inc({ level: verdict.level ?? (verdict.skipped ? 'skipped' : 'rejected') })
    if (!verdict.ok) {
      if (verdict.reason === 'tx_not_found') {
        // Neither source has the tx. That is expected at 0-conf only before
        // lws has mined it into its view (and the daemon is down or the hash
        // is foreign); most cases self-resolve on the next confirmation
        // callback or via reconcilePendingTips. Log only — the delayed check
        // pages if the payment never lands.
        logInfo({ paymentId, piconeros: piconeros.toString(), context }, 'webhook: receipt not visible yet (tx_not_found)')
        if (deferMiss) await scheduleWebhookMissCheck({ paymentId, piconeros, context })
      } else {
        // The reason lives in the alert body, which dev boxes (no
        // ALERT_WEBHOOK_URL) never deliver — mirror it into the log so a
        // rejection is diagnosable from `docker logs app` alone.
        logInfo({ paymentId, piconeros: piconeros.toString(), context, reason: verdict.reason, onChain: verdict.onChain != null ? verdict.onChain.toString() : undefined }, 'webhook: receipt rejected')
        alert('warn', 'webhook receipt rejected',
          `${context}: ${verdict.reason} for paymentId ${paymentId} (callback ${piconeros})`,
          { dedupeKey: `webhook-reject-${paymentId}-${verdict.reason}` })
      }
      res.status(200).end()
      return null
    }
    if (verdict.level === 'daemon' && !allowProvisional) {
      // Detection-only verdict: tx + pid + recipient output are proven, but
      // RingCT leaves the amount unverifiable at this level, so a credit
      // caller acknowledges and does nothing.
      res.status(200).end()
      return null
    }
    return verdict
  }

  const { payment_id: paymentId, confirmations = 0, tx_info: txInfo = {} } = body
  const { tx_hash: txHash, block: height, amount } = txInfo

  // Parses the callback amount; on garbage/zero/negative, alerts (deduped per
  // payment id), answers 200 no-op and returns null. A malformed amount never
  // becomes valid on an lws retry, so the delivery is acknowledged instead of
  // spun in a 503 retry loop.
  function parseOrReject () {
    const piconeros = parsePiconeros(amount)
    if (piconeros == null) {
      alert('warn', 'webhook rejected invalid amount', `${paymentId}: amount=${JSON.stringify(amount)}`, { dedupeKey: `webhook-bad-amount-${paymentId}` })
      res.status(200).end()
      return null
    }
    return piconeros
  }

  if (!paymentId) return res.status(200).end()

  const tip = await models.observedTip.findFirst({
    where: { paymentId },
    include: {
      post: { select: { userId: true } },
      recipientAccount: {
        // id is required by lookupTipTx's cursor advance (WHERE id = ...);
        // viewKey/status gate the scan, subaddresses feed isSelfSend.
        select: { id: true, label: true, ownerUserId: true, address: true, status: true, viewKey: true, lastTxId: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
      }
    }
  })
  if (tip) {
    if (tip.state === 'CONFIRMED') return res.status(200).end()

    if (tip.state === 'EXCLUDED') {
      // Retried lws callbacks for an excluded tip: terminal state, nothing to do.
      if (tip.webhookEventId) {
        try {
          await monero.deleteWebhook(tip.webhookEventId)
        } catch (err) {
          console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
        }
      }
      return res.status(200).end()
    }

    if (tip.state === 'REORGED') {
      // Terminal: the reverseStaleDetections sweep reversed this tip (double-spend
      // or mempool eviction). Retried/late callbacks are no-ops; best-effort
      // webhook delete (the sweep already tried once).
      if (tip.webhookEventId) {
        try {
          await monero.deleteWebhook(tip.webhookEventId)
        } catch (err) {
          console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
        }
      }
      return res.status(200).end()
    }

    if (tip.state === 'PENDING') {
      const piconeros = parseOrReject()
      if (piconeros == null) return
      // Self-tip exclusion (spec §2.3): direct self-tip is a free check from
      // data in hand; the self-send check scans the recipient account via lws
      // (tip callbacks are low-frequency). Fail closed on lws errors: a non-200
      // makes lws retry, and reconcilePendingTips is the backstop.
      const direct = tip.tipperId != null && tip.tipperId === tip.post.userId
      let selfSend = false
      let selfSendTx = null
      if (!direct && tip.recipientAccount?.viewKey && tip.recipientAccount?.status === 'ACTIVE') {
        // Incremental scan via the account's lastTxId cursor + full-scan
        // fallback — see lookupTipTx (api/monero/selfTip.js). Hash-first
        // (review finding 5): only the callback's named tx counts as evidence,
        // so a same-pid dust tx can never drive shouldExcludeTip on the wrong
        // tx. On lws 0.3 a mempool tx carried no spent_outputs (check failed
        // open at 0-conf); on v1.0.4 it can — recheckDetectedTip still
        // re-runs the check once the tx is mined either way.
        const account = tip.recipientAccount
        const tx = await lookupTipTx(models, monero, account, paymentId, { txHash })
        selfSendTx = tx
        selfSend = shouldExcludeTip({ tipperId: tip.tipperId, postUserId: tip.post.userId, account, tx })
      }
      if (direct || selfSend) {
        const exclusionReason = direct ? 'DIRECT_SELF_TIP' : 'SELF_SEND'
        await models.$transaction(async (tx) => {
          // Duplicate-hash fold (review follow-up): the EXCLUSION's effect is
          // load-bearing (blocks the ranking credit, writes the AbuseSignal —
          // which carries its own txHash copy), while the row's txHash is
          // informational. A hash already credited to another tip therefore
          // never blocks the exclusion: it is simply not re-stored (the CASE
          // keeps the row's current value), so this UPDATE can never violate
          // the global txHash unique — no P2002/500 retry loop on this path
          // (the DETECTED claim below guards the same class with NOT EXISTS).
          const claimed = await tx.$executeRaw`
            UPDATE "ObservedTip"
            SET state = 'EXCLUDED', "exclusionReason" = ${exclusionReason}::"TipExclusionReason",
                "txHash" = CASE WHEN EXISTS (
                  SELECT 1 FROM "ObservedTip" o
                  WHERE o."txHash" = ${txHash} AND o.id <> ${tip.id}
                ) THEN "txHash" ELSE ${txHash} END,
                height = ${height ?? null},
                piconeros = ${piconeros}, confirmations = ${confirmations}
            WHERE id = ${tip.id} AND state = 'PENDING'`
          if (claimed > 0) {
            const subName = await resolveItemSubName(tip.postId, tx)
            await tx.abuseSignal.create({
              data: {
                kind: direct ? 'SELF_TIP_EXCLUDED' : 'SELF_SEND_EXCLUDED',
                subjectUserId: tip.post.userId,
                actorUserId: tip.tipperId ?? null,
                tipId: tip.id,
                postId: tip.postId,
                subName,
                piconeros,
                txHash: txHash ?? 'unknown',
                paymentId,
                details: direct ? undefined : { note: 'amount recorded as lws reported it (change-output inflation possible)' }
              }
            })
          }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        if (tip.webhookEventId) {
          try {
            await monero.deleteWebhook(tip.webhookEventId)
          } catch (err) {
            console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
          }
        }
        return res.status(200).end()
      }
      // Chain verification before the DETECTED claim (C4): bind the callback
      // amount/txHash to the verified tx. Reuses the self-send scan's tx when
      // the scan ran, so a scannable account costs one lws lookup per callback.
      // Detection accepts the daemon level too (0-conf mempool detection); a
      // tx_not_found here is a both-sources miss, a 200 no-op that schedules
      // the delayed miss check — the payment is never credited while unverified
      // and never lost from tracking.
      const verdict = await verifyOrReject({
        account: tip.recipientAccount,
        paymentId,
        piconeros,
        txHash,
        tx: selfSendTx,
        context: `tip ${tip.id} detection`,
        deferMiss: true,
        daemon,
        allowProvisional: true
      })
      if (!verdict) return
      // Verified write: only the verdict tx's hash/height are recorded — never
      // the callback's tx_info — and the row is stamped lws-bound ONLY when the
      // verdict is lws (which proves the amount). A daemon verdict proves tx +
      // pid + recipient output but not the RingCT amount, so its row stays
      // UNSTAMPED and keeps height NULL (mempool), letting the first lws sight
      // trust-correct it. Unscannable accounts have no verdict tx (verification
      // skipped — the documented fail-open edge): they keep the callback values
      // and stay UNSTAMPED for the same reason.
      const verifiedTx = verdict.tx ?? null
      const verifiedHash = verifiedTx ? verifiedTx.hash : (txHash ?? null)
      const verifiedHeight = verifiedTx ? (verifiedTx.height ?? null) : (height ?? null)
      const verifiedAt = verdict.level === 'lws' ? new Date() : null
      // Duplicate-hash guard (review follow-up): the global unique on txHash
      // (one tx = one credit) would turn a replayed hash — credible only for
      // unscannable recipients, where verification is skipped and the callback
      // hash is trusted — into an unhandled P2002/500 that lws retries
      // forever. The NOT EXISTS converts the common case into the existing
      // 0-row lost-claim no-op; the catch below folds the concurrent-race
      // violation into the same clean 200.
      try {
        await models.$transaction(async (tx) => {
          const claimed = await tx.$executeRaw`
            UPDATE "ObservedTip"
            SET state = 'DETECTED', "txHash" = ${verifiedHash},
                height = ${verifiedHeight},
                piconeros = ${piconeros}, confirmations = 0,
                "amountVerifiedAt" = ${verifiedAt}
            WHERE id = ${tip.id} AND state = 'PENDING'
              AND NOT EXISTS (
                SELECT 1 FROM "ObservedTip" o
                WHERE o."txHash" = ${verifiedHash} AND o.id <> ${tip.id}
              )`
          if (claimed > 0) {
            const rankDelta = await applyTipDetected(tip.postId, tip.tipperId, piconeros, tx)
            // Persist the applied rank delta for exact reorg reversal (spec §4.3).
            await tx.$executeRaw`
              UPDATE "ObservedTip" SET "rankPiconeros" = ${rankDelta}
              WHERE id = ${tip.id} AND state = 'DETECTED'`
            // Claims mint no streak state: the flame is quest-driven (the daily
            // evaluation owns it — spec 2026-09-23-daily-quests) and the coin
            // badge was removed entirely.
          }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      } catch (err) {
        // The NOT EXISTS above loses the common race; two concurrent callbacks
        // for different pids claiming the same hash can still collide inside
        // the Serializable transaction. Either way the verdict is the same:
        // the hash is already credited — refuse, alert (deduped), 200 no-op.
        if (isUniqueViolation(err)) {
          alert('warn', 'tip txHash collision refused',
            `tip ${tip.id} callback replayed tx ${verifiedHash} already credited to another tip — no-op`,
            { dedupeKey: `tip-collision-${verifiedHash}` })
          return res.status(200).end()
        }
        throw err
      }
      return res.status(200).end()
    }

    if (tip.state === 'DETECTED') {
      const piconeros = parseOrReject()
      if (piconeros == null) return
      // Chain verification before any state change or credit (C4): re-bind the
      // callback to the lws-reported tx. Maturity is then DERIVED from the
      // chain — never the callback's `confirmations` field. A scannable
      // account with an unknown tx/chain height derives 0 (fail closed: no
      // verified maturity, no credit). Unscannable accounts have no chain view
      // at all (verification skipped — the documented fail-open edge), so the
      // callback count remains their maturity source; their tips are still
      // gated by the confirm-time re-check below.
      const verdict = await verifyOrReject({
        account: tip.recipientAccount,
        paymentId,
        piconeros,
        txHash,
        context: `tip ${tip.id} confirmation`,
        // Credit path: no provisional (daemon-level) verdict — daemon is only
        // used to corroborate the claimed pid when lws reports a different one.
        daemon,
        daemonFallback: false,
        allowProvisional: false
      })
      if (!verdict) return
      const verifiedHeight = verdict.tx?.height ?? null
      const derivedConfirmations = verdict.skipped
        ? confirmations
        : (verdict.chainHeight != null && verifiedHeight != null
            ? verdict.chainHeight - verifiedHeight + 1
            : 0)
      if (derivedConfirmations >= REQUIRED_CONFIRMATIONS) {
        // Confirm-time re-check before the credit: the self-send 0-conf scan
        // could not see spent_outputs for the mempool tx (fail-open), but the
        // tx is mined now, so the evidence exists; the same check binds the
        // stored amount/hash to the chain tx and trust-corrects an unbound row
        // to the chain amount. This is the last gate — confirmFinalizer races
        // us for this claim and runs the same check, so whichever claims
        // first, a wash or forged tip is never credited. A 'deferred' verdict
        // (lws miss corroborated by monerod) is a 200 no-op: no credit, no
        // exclusion, no deletion — later callbacks and the finalizer retry.
        const recheck = await recheckDetectedTip({ models, monero, daemon, tip, confirmations: derivedConfirmations, prefetchedTx: verdict.tx ?? null })
        if (recheck.action === 'deferred') return res.status(200).end()
        if (recheck.action === 'excluded') {
          if (tip.webhookEventId) {
            try {
              await monero.deleteWebhook(tip.webhookEventId)
            } catch (err) {
              console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
            }
          }
          return res.status(200).end()
        }
        // Credit the amount the re-check reports when it carries one: the
        // corrected chain amount, or — when it lost the binding race to the
        // finalizer — the amount the winner bound. Only the unscannable
        // early-clean has no amount, and that fail-open edge falls back to the
        // row snapshot.
        const creditAmount = recheck.piconeros ?? tip.piconeros
        await models.$transaction(async (tx) => {
          // Atomic conditional claim: only the first claimer (us or the confirmFinalizer
          // backstop, or a retried lws callback) wins. A retried callback for an already-
          // CONFIRMED tip loses the claim (state no longer DETECTED) and is a no-op, so
          // stackedPiconeros is never double-credited. Mirrors the PENDING->DETECTED guard.
          const claimed = await tx.$executeRaw`
            UPDATE "ObservedTip"
            SET state = 'CONFIRMED', confirmations = ${derivedConfirmations}, "confirmedAt" = NOW()
            WHERE id = ${tip.id} AND state = 'DETECTED'`
          if (claimed > 0 && tip.recipientAccount?.label !== 'platform_rewards' && tip.post?.userId != null) {
            await tx.user.update({
              where: { id: tip.post.userId },
              data: { stackedPiconeros: { increment: creditAmount } }
            })
          }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        // Verified-badge graduation check: a tip that crosses the reputation
        // threshold may newly qualify the author. No-op unless all conditions met.
        if (tip.recipientAccount?.label !== 'platform_rewards') {
          try {
            await maybeGrantVerifiedBadge(models, tip.post.userId)
          } catch (err) {
            console.error('verified badge check failed (webhook):', err)
          }
        }
        if (tip.webhookEventId) {
          try {
            await monero.deleteWebhook(tip.webhookEventId)
          } catch (err) {
            console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
          }
        }
        return res.status(200).end()
      }

      // Not mature yet — no credit, and NO callback tx_info writes (the
      // recheck and the finalizer own every verified write). The first
      // callback carrying a block height (the row still has none) re-runs the
      // self-send check on the now-mined tx to cut the provisional
      // wash-credit window from ~REQUIRED_CONFIRMATIONS blocks to ~1. It
      // shares the already-fetched verified tx (one lws lookup per callback)
      // and, for scannable accounts, backfills the row's height from it when
      // clean — the exception below covers unscannable ones. A 'deferred'
      // verdict changes nothing here either: no exclusion, no credit.
      if (tip.height == null && height != null) {
        const recheck = await recheckDetectedTip({ models, monero, daemon, tip, confirmations: derivedConfirmations, height, prefetchedTx: verdict.tx ?? null })
        if (recheck.action === 'excluded') {
          if (tip.webhookEventId) {
            try {
              await monero.deleteWebhook(tip.webhookEventId)
            } catch (err) {
              console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
            }
          }
          return res.status(200).end()
        }
        // Unscannable accounts (verification skipped: verdict.tx absent) have
        // no chain view — the re-check early-returns clean and never writes a
        // height — so a missed N-conf callback would strand the row
        // height-NULL, invisible to the finalizer's height-not-null scan, and
        // the tip would silently never credit. The documented fail-open
        // posture requires them to keep working, so persist ONLY the
        // callback's block height (never piconeros/txHash/confirmations),
        // state-guarded and only while the row still has none.
        if (verdict.skipped === true) {
          await models.observedTip.updateMany({
            where: { id: tip.id, state: 'DETECTED', height: null },
            data: { height }
          })
        }
      }
    }

    return res.status(200).end()
  }

  // Bounty funding branch (A-13): no tip matched the payment id, so this may
  // be a funding into the bounty ESCROW wallet ("bn:" namespace, reverse
  // mapped through the BountyPidMap). Unknown ids (no ObservedBounty row) are a
  // 200 no-op — lws retries would otherwise pile up for foreign payments.
  //
  // The pid-map liveness gate guards ONLY the PENDING -> DETECTED claim: only a
  // LIVE (unconsumed, unexpired) pid map can authorize the initial funding claim
  // (a consumed map = funding already detected; an expired map = 24h pid expiry,
  // the author may have re-minted). The pid map is consumed at DETECTED, so the
  // subsequent 1-conf .. N-conf callbacks that drive DETECTED -> CONFIRMED
  // (driveBountyFunding) and backfill height MUST NOT be gated on a live pid map
  // — otherwise the N-conf CONFIRMED callback is unreachable and the funding
  // stays stuck at DETECTED forever (the bug behind item 2808). Once DETECTED,
  // idempotency is handled by the CONFIRMED state guard (no-op) and the
  // deterministic funding writes, not by the pid map.
  const bounty = await models.observedBounty.findFirst({
    where: { paymentId },
    include: {
      recipientAccount: {
        // C5 receipt verification: viewKey/status gate the scan, lastTxId +
        // subaddresses feed lookupTipTx's cursor advance and pid matching;
        // label gates lookupTipTx's rewards-account advance skip.
        select: { id: true, label: true, address: true, status: true, viewKey: true, lastTxId: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
      }
    }
  })
  // A missing bounty row falls through to the downvote branch below (dv:
  // pids are never ObservedBounty rows); only an already-CONFIRMED bounty
  // short-circuits here.
  if (bounty?.state === 'CONFIRMED') return res.status(200).end()

  if (bounty?.state === 'PENDING') {
    // Only a LIVE pid map can claim a PENDING bounty (double-funding protection).
    const pidMap = await models.bountyPidMap.findFirst({
      where: { paymentId, consumedAt: null, expiresAt: { gt: new Date() } }
    })
    if (!pidMap) return res.status(200).end()

    const piconeros = parseOrReject()
    if (piconeros == null) return
    // Chain verification before the PENDING -> DETECTED claim (C5): bind the
    // callback amount/txHash to the verified tx on the ESCROW account — a
    // token-holding replay with a fabricated amount must never seed a receipt
    // nor consume the pid map. Unscannable accounts skip (fail-open). Detection
    // accepts the daemon level too (0-conf provisional funding).
    const verdict = await verifyOrReject({
      account: bounty.recipientAccount,
      paymentId,
      piconeros,
      txHash,
      context: `bounty ${bounty.id}`,
      daemon,
      allowProvisional: true
    })
    if (!verdict) return
    // Verified-write rule (mirrors the tip branch): only the verdict tx may
    // supply the row's hash/height. Only an lws verdict proves the RingCT
    // amount and carries the mined block height; a daemon verdict proves tx +
    // pid + recipient output but leaves the amount unverified (and the height
    // unknown), so the callback's attacker-controlled tx_info values must never
    // be written: the funding row keeps height NULL, confirmations 0, and the
    // receipt is inserted PROVISIONAL (display-only) until an lws sight claims
    // the height through the atomic CAS. Unscannable accounts (skipped) have no
    // chain view at all — the documented fail-open edge keeps the callback
    // values, mirroring the tip branch.
    const verifiedTx = verdict.tx ?? null
    const verifiedHash = verifiedTx ? verifiedTx.hash : (txHash ?? null)
    const verifiedHeight = verifiedTx ? (verifiedTx.height ?? null) : (height ?? null)
    await models.$transaction(async (tx) => {
      const claimed = await tx.$executeRaw`
        UPDATE "ObservedBounty"
        SET state = 'DETECTED', "txHash" = ${verifiedHash},
            height = ${verifiedHeight}, piconeros = ${piconeros}, confirmations = 0
        WHERE id = ${bounty.id} AND state = 'PENDING'`
      if (claimed > 0) {
        // Consume the pid map at DETECTED: the funding is on chain, so the
        // payment id can never fund a second bounty. A retried callback loses
        // the claim (state is no longer PENDING) and stays a no-op.
        await tx.bountyPidMap.update({
          where: { paymentId },
          data: { consumedAt: new Date() }
        })
        // first funding receipt: seeds the cumulative total (idempotent)
        await recordBountyReceipt(tx, bounty, { txHash: verifiedHash, piconeros, height: verifiedHeight })
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    return res.status(200).end()
  }

  // DETECTED bounty: every callback re-verifies against the chain and derives
  // maturity from it — never the callback's `confirmations` field, which is
  // attacker-controlled (same discipline as the tip confirmation branch). A
  // derived-mature callback runs the cumulative funding gate; an immature one
  // falls through to the receipt-fold / anchor-advance path below WITHOUT
  // funding. Unscannable escrow accounts (verification skipped — the
  // documented fail-open edge) have no chain view, so the callback count
  // remains their maturity source.
  if (bounty?.state === 'DETECTED') {
    const piconeros = parseOrReject()
    if (piconeros == null) return
    // Chain verification before the cumulative funding transaction (C5): the
    // top-up sum gates the FUNDED flip, so every receipt feeding it must be
    // bound to the lws-reported tx — same fail-open skip for unscannable
    // escrow accounts, same 503/reject semantics as the tip branch (C4). Credit
    // path: lws only, never a provisional (daemon) verdict. Verified-write
    // rule: the verdict tx is the only source for the receipt/funding
    // hash/height — the callback's attacker-controlled tx_info.block never
    // reaches the count-eligible CAS or the row's maturity anchor.
    const verdict = await verifyOrReject({
      account: bounty.recipientAccount,
      paymentId,
      piconeros,
      txHash,
      context: `bounty ${bounty.id}`,
      daemon,
      daemonFallback: false,
      allowProvisional: false
    })
    if (!verdict) return
    const verifiedTx = verdict.tx ?? null
    const verifiedHash = verifiedTx ? verifiedTx.hash : (txHash ?? null)
    const verifiedHeight = verifiedTx ? (verifiedTx.height ?? null) : (height ?? null)
    // Maturity is DERIVED from the chain (mirrors the tip confirmation
    // branch): a forged 10-confirmation replay on a 1-conf funding must never
    // open the gate. A scannable account with an unknown tx/height derives 0
    // (fail closed: no verified maturity, no funding).
    const derivedConfirmations = verdict.skipped
      ? confirmations
      : (verdict.chainHeight != null && verifiedHeight != null
          ? verdict.chainHeight - verifiedHeight + 1
          : 0)
    if (derivedConfirmations >= REQUIRED_CONFIRMATIONS) {
      let funded = false
      await models.$transaction(async (tx) => {
        const receipt = await recordBountyReceipt(tx, bounty, { txHash: verifiedHash, piconeros, height: verifiedHeight })
        const expected = await bountyExpectedPiconeros(tx, bounty)
        // Count-eligible (height-verified) receipts only gate FUNDED: a
        // provisional daemon-level claim is display-only (driveBountyFunding
        // re-computes the same gate inside).
        if (receipt.counted != null && receipt.counted >= expected) {
          funded = await driveBountyFunding(tx, bounty, { txHash: verifiedHash, height: verifiedHeight, confirmations: derivedConfirmations })
        } else {
          // short or still-provisional: keep DETECTED (top-up-able), just
          // advance confirmations to the chain-derived count
          await tx.observedBounty.update({ where: { id: bounty.id }, data: { confirmations: derivedConfirmations } })
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      if (funded && bounty.webhookEventId) {
        try {
          await monero.deleteWebhook(bounty.webhookEventId)
        } catch (err) {
          console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
        }
      }
      return res.status(200).end()
    }

    // Immature callback: fold the (verified) receipt so a top-up's cumulative
    // sum stays current, then ADVANCE-ONLY the maturity anchor — a replay of
    // an older tx (verifiedHeight below the stored anchor) must never lower
    // height, matching the finalizer backfill's advance-only semantics. The
    // row keeps the DERIVED confirmation count, never the callback's.
    await models.$transaction(async (tx) => {
      await recordBountyReceipt(tx, bounty, { txHash: verifiedHash, piconeros, height: verifiedHeight })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(err =>
      console.warn(`webhook: bounty receipt record failed (best-effort): ${err && err.message}`))
    const data = { confirmations: derivedConfirmations }
    if (verifiedHeight != null && (bounty.height == null || verifiedHeight > bounty.height)) data.height = verifiedHeight
    if (verifiedHash) data.txHash = verifiedHash
    await models.observedBounty.update({
      where: { id: bounty.id },
      data
    })
    return res.status(200).end()
  }

  // A payment landed on an ABANDONED bounty's pid after the 7-day window: the
  // escrow holds it but the funding is dead. Record the receipt (ledger
  // visibility) and page the operators — manual reconciliation required.
  if (bounty?.state === 'EXPIRED') {
    const piconeros = parseOrReject()
    if (piconeros == null) return
    // Chain verification before the abandoned-bounty receipt (C5): even a
    // ledger-visibility row must carry a chain-verified amount, or a replayed
    // callback could fabricate escrow balances for manual reconciliation.
    // Credit/ledger path: lws only (a daemon verdict proves no amount), and the
    // verified-write rule supplies the receipt hash/height.
    const verdict = await verifyOrReject({
      account: bounty.recipientAccount,
      paymentId,
      piconeros,
      txHash,
      context: `bounty ${bounty.id}`,
      daemon,
      daemonFallback: false,
      allowProvisional: false
    })
    if (!verdict) return
    const verifiedTx = verdict.tx ?? null
    const verifiedHash = verifiedTx ? verifiedTx.hash : (txHash ?? null)
    const verifiedHeight = verifiedTx ? (verifiedTx.height ?? null) : (height ?? null)
    await models.$transaction(async (tx) => {
      await recordBountyReceipt(tx, bounty, { txHash: verifiedHash, piconeros, height: verifiedHeight })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(err =>
      console.warn(`webhook: abandoned-bounty receipt record failed (best-effort): ${err && err.message}`))
    alert('critical', 'payment arrived after bounty abandonment',
      `bounty item ${bounty.postId}: ${piconeros} piconeros arrived after the underfunded bounty was abandoned; manual reconciliation required`,
      { dedupeKey: `bounty-late-payment-${bounty.postId}` })
    return res.status(200).end()
  }

  // Integrated fee branch ("fee:" namespace): owner-routed fees pay the
  // OWNER's wallet and platform posting/turf/boost fees pay the rewards
  // wallet PRIMARY, both at an integrated address whose pid is the
  // SubFeePidMap intent (and, while it exists, the PayIn's unique
  // moneroPaymentId). One branch for both destinations: verification uses the
  // intent's FROZEN recipient (api/monero/ownerFeeLeg.js resolveFeeAccount),
  // and the shared applier (api/monero/feeObservation.js) picks the ledger and
  // owns the insert/CAS/boost/cumulative gate/maturity — idempotent by
  // construction. A PayIn-less intent is an abandoned leg: the receipt is
  // still recorded (ledger visibility, payInId NULL, no gate) and operators
  // are paged. Unknown pids fall through to the downvote dispatch (200 no-op).
  const feeMapRow = await models.subFeePidMap.findUnique({ where: { paymentId } })
  const feePayIn = await models.payIn.findUnique({ where: { moneroPaymentId: paymentId } })
  if (feeMapRow || feePayIn) {
    const piconeros = parseOrReject()
    if (piconeros == null) return
    const platform = feeMapRow?.feeType != null
    const feeAccount = await resolveFeeAccount(models, feeMapRow)
    const context = feePayIn ? `fee ${feePayIn.id}` : `abandoned fee ${paymentId}`
    // Platform legs register no webhook (rewardsWalletObserver is their
    // per-minute path), so this only runs for a callback lws delivers anyway;
    // it must still be safe. Platform receipts fund rewards and unlock
    // content, so they never take the documented legacy owner fail-open: an unscannable (or no longer
    // snapshot-matching) recipient defers with 503 so lws retries, and the
    // hourly reconciler recovers once it is scannable again.
    if (platform && (!feeAccount?.viewKey || feeAccount.status !== 'ACTIVE')) {
      alert('critical', 'platform fee verification unavailable',
        `fee intent ${feeMapRow.id}: registered recipient account ${feeMapRow.recipientAccountId} is not scannable or no longer matches its snapshot`,
        { dedupeKey: `platform-fee-unscannable-${feeMapRow.id}` })
      return res.status(503).end()
    }
    // Chain verification before the receipt insert (C6): bind the callback
    // amount/txHash to the verified tx on the RECIPIENT's account — a
    // token-holding replay with a fabricated amount must never seed a receipt
    // nor open the cumulative live-flip gate. Detection accepts the daemon
    // level (provisional receipt); the applier's flip/maturity gates are the
    // credit side. Historical owner legs with no ACTIVE account keep the
    // documented fail-open (skipped) edge.
    const verdict = await verifyOrReject({
      account: feeAccount,
      paymentId,
      piconeros,
      txHash,
      context,
      daemon,
      allowProvisional: true
    })
    if (!verdict) return
    if (platform && verdict.skipped) return res.status(503).end()
    // Self-payment change inflated a fee callback in the 2026-09-19 incident.
    // Require the shared closure gate, not ring-candidate presence, before
    // refusing and excluding any provisional receipt seeded at 0-conf.
    if (verdict.tx && isSelfSend(feeAccount, verdict.tx)) {
      if (feeMapRow) await excludeProvisionalFeeReceipt(models, feeMapRow, verdict.tx.hash)
      alert('warn', platform ? 'platform fee self-payment refused' : 'owner-fee self-payment refused',
        `${context} pid ${paymentId} tx ${verdict.tx.hash}: payer shares the recipient account (change-inflated); no receipt credited`,
        { dedupeKey: `subfee-selfpay-${paymentId}-${String(verdict.tx.hash).toLowerCase()}` })
      return res.status(200).end()
    }
    // Same provisional-height discipline as the bounty detection claim: only an
    // lws verdict proves the RingCT amount and carries the mined height, so a
    // daemon verdict (and the attacker-supplied tx_info.block) must not claim a
    // receipt height — the receipt stays display-only until the applier's
    // atomic CAS sees a chain-verified height. Unscannable historical owners
    // (skipped) keep the callback values — the documented fail-open edge.
    // DAEMON OVER-CLAIM BOUND: a daemon verdict proves the tx but not the
    // RingCT amount, and daemon raw txs carry no spent_outputs, so the
    // self-send ban above cannot fire on this level (mempool-only self-sends
    // pass through here). A gated top-up claim can never exceed the quoted fee
    // (partials accumulate), so an over-claim is refused outright instead of
    // seeding a display-only provisional row that shows phantom progress.
    // (Boosts have no quote ceiling — overpaying a boost is legitimate.)
    if (verdict.level === 'daemon' && feeMapRow?.feeType !== 'BOOST') {
      const expected = feePayIn?.moneroUri ? moneroUriAmountPiconeros(feePayIn.moneroUri) : (feeMapRow?.amountPiconeros ?? null)
      if (expected != null && BigInt(piconeros) > expected) {
        alert('warn', platform ? 'platform fee over-claim refused' : 'owner-fee over-claim refused',
          `fee leg ${paymentId} tx ${txHash}: daemon-verdict claim ${piconeros} exceeds the quoted ${expected} — no receipt seeded`,
          { dedupeKey: `subfee-overclaim-${paymentId}` })
        return res.status(200).end()
      }
    }
    const verifiedHash = verdict.tx ? verdict.tx.hash : (txHash ?? null)
    const verifiedHeight = verdict.tx ? (verdict.tx.height ?? null) : (height ?? null)
    // Maturity is DERIVED from the chain (mirrors the tip confirmation
    // branch): the callback's `confirmations` is attacker-controlled, so a
    // forged count must never mature the receipt. A scannable account with an
    // unknown tx/height derives 0 (fail closed; the applier's CAS/flip stay
    // height-gated). Unscannable historical owners have no chain view
    // (verification skipped), so the callback count remains their source.
    const derivedConfirmations = verdict.skipped
      ? confirmations
      : (verdict.chainHeight != null && verifiedHeight != null
          ? verdict.chainHeight - verifiedHeight + 1
          : 0)
    // A pid with a PayIn but no intent row predates intents entirely; the
    // owner applier's map-joined insert records nothing for it (legacy).
    const feeMap = feeMapRow ?? { paymentId, feeType: null }
    const receipt = { feeMap, feePayIn, txHash: verifiedHash, piconeros, height: verifiedHeight, confirmations: derivedConfirmations }
    if (feePayIn) {
      await applyFeeReceipt(models, receipt)
      return res.status(200).end()
    }
    // Money landed on an intent with NO PayIn: the leg was abandoned
    // (underpaid past the window — abandonFeeItems deleted the PayIn) but the
    // intent persists for attribution. Record the receipt (owner legs: the
    // owner keeps the XMR; platform legs: it is rewards-wallet cash) and page
    // operators for manual reconciliation — never revive deleted content.
    try {
      await applyFeeReceipt(models, receipt)
    } catch (err) {
      console.warn(`webhook: abandoned-fee receipt record failed (best-effort): ${err && err.message}`)
    }
    alert('critical', 'payment arrived after fee abandonment',
      `${platform ? `platform ${feeMapRow.feeType} fee` : `turf ${feeMapRow.subName}`}: ${piconeros} piconeros arrived on abandoned fee leg ${paymentId}; manual reconciliation required`,
      { dedupeKey: `subfee-late-payment-${paymentId}` })
    return res.status(200).end()
  }

  // Downvote branch: dv:-namespace payment ids reverse-map through the
  // DownvotePidMap (downvotes pay the rewards PRIMARY address + payment id —
  // the same shape as a wallet-less tip). Unknown ids (no map, or a tip/bounty
  // matched above) are a 200 no-op, mirroring the bounty fall-through.
  const dvMap = await models.downvotePidMap.findUnique({ where: { paymentId } })
  if (!dvMap) return res.status(200).end()

  // The rewards wallet is the verification account for EVERY downvote branch
  // (downvotes pay its PRIMARY address). Resolved once here — viewKey-gated
  // like the observer's findRewardsAccount — and shared by the sub-N DETECTED
  // height transition and the 0-conf insert verification below. No registered
  // account -> unscannable -> verification skipped (fail-open).
  const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  const rewardsAccount = await models.moneroAccount.findFirst({
    where: { label: 'platform_rewards', network, viewKey: { isNot: null } },
    include: { viewKey: true },
    orderBy: { id: 'asc' }
  })

  // Post-DETECTED flows are keyed on the ObservedDownvote row, NEVER on
  // pid-map liveness (the item-2808 lesson: the poll backstop may have
  // consumed the map, and gating the N-conf path on it strands the funding).
  const dv = await models.observedDownvote.findFirst({ where: { paymentId } })
  if (dv) {
    if (dv.state === 'CONFIRMED') return res.status(200).end()

    // The CONFIRMED flip is safe metadata ONLY for a row whose verified
    // transition already ran: height is written exclusively by
    // applyDownvoteTransition's CAS, which also owns the penalty. Flipping a
    // height-NULL row here on the callback's confirmations would pre-empt that
    // transition (the DETECTED branch below is skipped) and leave the penalty
    // unapplied forever — the finalizer only matures height-set rows. A
    // height-NULL row therefore stays DETECTED and waits for the verified
    // transition (observer / webhook-DETECTED / finalizer backfill); the flip
    // happens on a later N-conf callback once the height is set.
    if (dv.state === 'DETECTED' && dv.height != null && confirmations >= REQUIRED_CONFIRMATIONS) {
      // Atomic conditional claim: race-safe vs confirmFinalizer's flip — a
      // loser (either side) sees rowCount 0 and is a no-op.
      const claimed = await models.$executeRaw`
        UPDATE "ObservedDownvote"
        SET state = 'CONFIRMED', confirmations = ${confirmations}, "confirmedAt" = NOW()
        WHERE id = ${dv.id} AND state = 'DETECTED'`
      if (claimed > 0 && dvMap.webhookEventId) {
        try {
          await monero.deleteWebhook(dvMap.webhookEventId)
        } catch (err) {
          console.warn(`webhook: lws deleteWebhook failed (best-effort): ${err && err.message}`)
        }
      }
      return res.status(200).end()
    }

    if (dv.state === 'DETECTED') {
      const piconeros = parseOrReject()
      if (piconeros == null) return
      // The shared NULL->height transition owns the penalty (Task 13), so this
      // callback must present only the lws-verified tx — never the callback
      // tx_info (D9 residual: the callback's attacker-controlled block must not
      // reach the row). Credit-side path: lws only (no daemon RPC), never a
      // provisional verdict.
      const verdict = await verifyOrReject({
        account: rewardsAccount,
        paymentId,
        piconeros,
        txHash,
        context: `downvote ${dv.id} detection`,
        daemon,
        daemonFallback: false,
        allowProvisional: false
      })
      if (!verdict) return
      const verifiedHeight = verdict.tx?.height ?? null
      // Maturity is derived from the chain (mirrors the tip confirmation
      // branch); an unscannable skip has no chain view, so 0.
      const derivedConfirmations = verdict.chainHeight != null && verifiedHeight != null
        ? verdict.chainHeight - verifiedHeight + 1
        : 0
      await applyDownvoteTransition({
        models,
        dv,
        height: verifiedHeight,
        piconeros: verdict.tx?.piconeros ?? piconeros,
        confirmations: derivedConfirmations
      })
    }
    return res.status(200).end()
  }

  // Reject an untrusted amount BEFORE claiming the pid map: a rejected
  // callback must not consume the map (the poll backstop or a corrected
  // re-delivery still needs it to attribute the downvote).
  const piconeros = parseOrReject()
  if (piconeros == null) return

  // Chain verification BEFORE the map claim (C6): a rejected callback must
  // not consume the DownvotePidMap, or the downvote is lost (the poll
  // backstop keys attribution on the map). Detection branch: accepts the
  // daemon level too (provisional 0-conf row). No registered rewards
  // account -> unscannable -> skip (fail-open), matching C4/C5.
  const verdict = await verifyOrReject({
    account: rewardsAccount,
    paymentId,
    piconeros,
    txHash,
    context: 'downvote detection',
    daemon,
    allowProvisional: true
  })
  if (!verdict) return

  // 0-conf detection (mempool — height NULL on the callback). Only a LIVE
  // (unconsumed, unexpired) pid map may claim; the atomic conditional consume
  // makes retried callbacks and a raced poll attribution no-ops.
  const claimedMap = await models.$executeRaw`
    UPDATE "DownvotePidMap"
    SET "consumedAt" = NOW()
    WHERE "paymentId" = ${paymentId} AND "consumedAt" IS NULL AND "expiresAt" > NOW()`
  if (claimedMap === 0) return res.status(200).end()

  // Idempotent vs the observer poll backstop: the unique (txHash, paymentId)
  // constraint + RETURNING make a replayed/raced 0-conf callback a no-op. The
  // row is inserted PROVISIONAL (height NULL) and the verified height/penalty
  // come from the shared transition below — writing the callback's tx_info
  // block here would both forge a height and make the transition CAS
  // unreachable (silent penalty loss; Task 13).
  const verifiedHash = verdict.tx?.hash ?? txHash
  const verifiedHeight = verdict.tx?.height ?? null
  const rows = await models.$queryRaw`
    INSERT INTO "ObservedDownvote" ("txHash","postId","downvoterId","paymentId","piconeros","height","state","detectedAt")
    VALUES (${verifiedHash}, ${dvMap.postId}, ${dvMap.userId}::INT, ${paymentId}, ${piconeros}, NULL, 'DETECTED'::"ObservedState", NOW())
    ON CONFLICT ("txHash","paymentId") DO NOTHING
    RETURNING id`
  if (!rows || rows.length === 0) return res.status(200).end()

  // The shared transition owns the penalty (exactly once). Only an lws verdict
  // carries a verified mined height; a provisional (daemon/skipped) callback
  // leaves the row height-NULL. Recovery is automatic, not lost: while the
  // rewards account is unscannable the finalizer's backfill skips and retries
  // each run; once scannable again, the transition (and penalty) fire exactly
  // once. The rewards system fails loudly meanwhile — observer, fee
  // attribution, and health probe all share the account.
  await applyDownvoteTransition({
    models,
    dv: { id: rows[0].id, postId: dvMap.postId, downvoterId: dvMap.userId },
    height: verifiedHeight,
    piconeros: verdict.tx?.piconeros ?? piconeros
  })

  return res.status(200).end()
}

// driveBountyFunding/recordBountyReceipt/bountyExpectedPiconeros live in
// api/monero/bountyFunding.js (shared with the confirmFinalizer backstop).
// Re-exported here so existing callers/tests that import from the webhook
// module keep working.
export { driveBountyFunding, recordBountyReceipt, bountyExpectedPiconeros } from '@/api/monero/bountyFunding'

export default function handler (req, res) {
  if (req.method !== 'POST') {
    res.status(405).end()
    return
  }
  const rl = rateLimit({
    key: `lws-webhook:${clientIp(req.headers, req.socket?.remoteAddress)}`,
    limit: 600,
    windowMs: 60_000
  })
  if (!rl.allowed) {
    res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000))
    res.status(429).end()
    return
  }
  handleWebhook(req, res)
}
