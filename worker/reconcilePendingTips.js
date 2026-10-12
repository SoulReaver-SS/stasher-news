import { Prisma } from '@prisma/client'
import { lwsClient } from '@/api/monero/lwsClient'
import { daemonClient } from '@/api/monero/daemonClient'
import { decryptViewKey } from '@/api/monero/viewkey'
import { paymentIdCandidates } from '@/api/monero/pidDecrypt'
import { getReconciliationRawReader } from '@/worker/reconciliationRawTransactions'
import { applyTipDetected } from '@/api/monero/ranking'
import { shouldExcludeTip, resolveItemSubName } from '@/api/monero/selfTip'
import { RECONCILE_PENDING_AGE_MS, PENDING_EXPIRY_MS } from '@/lib/constants'
import { alert } from '@/lib/alert'
import { isUniqueViolation } from '@/lib/error'
import { moneroPendingTips, moneroTipsRecoveredTotal, moneroTipsExpiredTotal } from '@/lib/metrics'

// reconcilePendingTips — recover tips stranded in PENDING by a missed 0-conf webhook.
//
// A tip is PENDING from initiateTip until the lws 0-conf callback flips it DETECTED. If
// that callback is lost (app downtime, network), confirmFinalizer will NEVER mature it
// (it only scans DETECTED rows). This job, every 2 min (cron-owned —
// pgboss.schedule row reconcilePendingTips, */2 * * * *), finds PENDING tips
// older than RECONCILE_PENDING_AGE_MS, re-scans the author account via lws
// get_address_txs, and if the payment_id is on chain, performs the same PENDING->DETECTED
// transition the webhook receiver would have (atomic claim + applyTipDetected). Tips that
// were never paid are expired after PENDING_EXPIRY_MS so the table cannot grow unbounded.
//
// Race safety: a tip could be recovered here AND by a belated webhook at the same instant.
// The recovery uses an atomic conditional UPDATE (... WHERE state = 'PENDING') inside a
// Serializable transaction: exactly one flipper wins (rowCount > 0) and only it applies the
// ranking delta — so the tip is never double-counted. This is the same idempotency contract
// the webhook receiver relies on, made race-proof via the conditional claim.
//
// get_address_txs returns the full history when sinceBlockHash is null, so this re-scan is
// exhaustive for the account (the job is infrequent + state-filtered to PENDING, so the
// cost is bounded by the number of accounts with stranded tips, not all accounts).
//
// WRONG-PID FALLBACK (mainnet incident 2026-09-12):
// monero-lws decrypts a tx's encrypted payment id ONCE — with the derivation of the
// FIRST registered account that matches an output — and stores those bytes on every
// matching account's row. When both sender and recipient are lws-registered (payer
// change output) and the sender scans first (a reorg reset re-sorts accounts into
// exactly that order), the recipient's row carries the SENDER-side decryption: the
// webhook never fires and the pid-keyed match finds nothing. For unmatched PENDING
// tips, the fallback fetches the raw txs from monerod and decrypts the encrypted
// pid with the RECIPIENT's view key (api/monero/pidDecrypt.js) — the same ECDH
// the sender's wallet used — then claims through the identical state machine. A
// fallback match is cryptographic proof of payment: only the view-key holder can
// compute the mask. Daemon/view-key failures never abort the run and DEFER the
// expiry decision for that account's unmatched tips (a paid tip must not be
// expired because a lookup was down); the next 2-min run retries. INCOMPLETE
// raw evidence defers just the same: a response missing candidate hashes is
// "not established now", never proof of nonpayment — proven matches still
// claim, the unmatched remainder stays PENDING.

// Alert tiers: recoveries ARE missed webhooks (unpaid checkouts can never be
// recovered — nothing on chain to find), so the operator page fires on the
// post-scan recovered count, never on the raw PENDING pool. Small batches are
// a blip (deploy window with exhausted lws retries); large batches mean a
// systemic webhook outage. Wrong-pid fallback recoveries page separately:
// they mean lws's stored rows are corrupt, not that webhooks were missed.
const RECONCILE_RECOVERED_WARN = Number(process.env.RECONCILE_RECOVERED_WARN) || 1
const RECONCILE_RECOVERED_CRITICAL = Number(process.env.RECONCILE_RECOVERED_CRITICAL) || 10

// Fixed classification for raw-lookup failures. Only the reader's typed codes
// are surfaced; every other failure (transport/HTTP/RPC/view-key) collapses to
// RAW_LOOKUP_FAILED, so arbitrary exception text — which can embed view-key
// material or raw payloads — never reaches operator alerts.
const RAW_LOOKUP_ERROR_CATEGORIES = new Set([
  'DAEMON_TIMEOUT',
  'RAW_SCAN_BUDGET_EXHAUSTED',
  'RAW_EVIDENCE_RESPONSE_INVALID'
])

function rawLookupCategory (err) {
  return err && RAW_LOOKUP_ERROR_CATEGORIES.has(err.code) ? err.code : 'RAW_LOOKUP_FAILED'
}

// The atomic PENDING claim shared by the pid-keyed pass and the raw-decrypt
// fallback: DETECTED or EXCLUDED, exactly-once vs the webhook and each other.
// Duplicate-hash fold (review follow-up): the global ObservedTip.txHash unique
// (one tx = one credit) must never turn a hash already credited to another tip
// into an unhandled error that fails the cron run — the DETECTED claim guards
// it with NOT EXISTS (a collision means the credit is taken: refuse cleanly,
// the tip stays PENDING and expires at PENDING_EXPIRY_MS), the EXCLUDED claim
// writes the hash only when free (the exclusion is the load-bearing effect;
// the AbuseSignal keeps its own txHash copy), and the catch folds the
// concurrent-race violation into the same clean no-op with a deduped alert
// (same dedupeKey as the webhook's collision alert, so both collapse).
async function claimTip ({ models, apply, tip, tx, amount, direct, isExcluded }) {
  try {
    if (isExcluded) {
      let excluded = false
      await models.$transaction(async (txdb) => {
        // Atomic conditional claim: only the first flipper (us or the
        // webhook) wins. EXCLUDED is terminal — no apply, no streaks.
        const claimed = await txdb.$executeRaw`
          UPDATE "ObservedTip"
          SET state = 'EXCLUDED', "exclusionReason" = ${direct ? 'DIRECT_SELF_TIP' : 'SELF_SEND'}::"TipExclusionReason",
              "txHash" = CASE WHEN EXISTS (
                SELECT 1 FROM "ObservedTip" o
                WHERE o."txHash" = ${tx.hash} AND o.id <> ${tip.id}
              ) THEN "txHash" ELSE ${tx.hash} END,
              height = ${tx.height ?? null}, piconeros = ${amount}, confirmations = 0
          WHERE id = ${tip.id} AND state = 'PENDING'`
        if (claimed > 0) {
          const subName = await resolveItemSubName(tip.postId, txdb)
          await txdb.abuseSignal.create({
            data: {
              kind: direct ? 'SELF_TIP_EXCLUDED' : 'SELF_SEND_EXCLUDED',
              subjectUserId: tip.post?.userId,
              actorUserId: tip.tipperId ?? null,
              tipId: tip.id,
              postId: tip.postId,
              subName,
              piconeros: amount,
              txHash: tx.hash,
              paymentId: tip.paymentId,
              details: direct
                ? undefined
                : { note: 'amount recorded as lws reported it (change-output inflation possible)' }
            }
          })
          excluded = true
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return { excluded }
    }
    // Atomic conditional claim: only the first flipper (us or the webhook) wins.
    // The recovery is an lws scan by construction, so the DETECTED row is
    // stamped amountVerifiedAt: the credit path treats it as bound evidence and
    // never trust-corrects it (a bound mismatch is forgery, not a correction).
    // The NOT EXISTS is the duplicate-hash guard: a hash already credited to
    // another tip loses the claim here (0 rows, recovered stays false) — the
    // tip is left PENDING and expires at PENDING_EXPIRY_MS like any never-paid
    // tip (the webhook's detection claim guards the same class).
    let recovered = false
    await models.$transaction(async (txdb) => {
      const claimed = await txdb.$executeRaw`
        UPDATE "ObservedTip"
        SET state = 'DETECTED', "txHash" = ${tx.hash},
            height = ${tx.height ?? null}, piconeros = ${amount}, confirmations = 0,
            "amountVerifiedAt" = NOW()
        WHERE id = ${tip.id} AND state = 'PENDING'
          AND NOT EXISTS (
            SELECT 1 FROM "ObservedTip" o
            WHERE o."txHash" = ${tx.hash} AND o.id <> ${tip.id}
          )`
      if (claimed > 0) {
        const rankDelta = await apply(tip.postId, tip.tipperId, amount, txdb)
        await txdb.$executeRaw`
          UPDATE "ObservedTip" SET "rankPiconeros" = ${rankDelta}
          WHERE id = ${tip.id} AND state = 'DETECTED'`
        recovered = true
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    return { recovered }
  } catch (err) {
    // Two concurrent claims for different pids can still collide inside the
    // Serializable transaction (the NOT EXISTS above loses the common race).
    // Either way the verdict is the same: the hash is already credited —
    // refuse, alert (deduped with the webhook's collision alert), continue.
    if (isUniqueViolation(err)) {
      alert('warn', 'tip txHash collision refused',
        `tip ${tip.id} recovery replayed tx ${tx.hash} already credited to another tip — no-op`,
        { dedupeKey: `tip-collision-${tx.hash}` })
      return { recovered: false, excluded: false, collision: true }
    }
    throw err
  }
}

// One account's wrong-pid pass: match unmatched PENDING tips against the
// recipient-side decryption of every scanned tx's encrypted pid. Returns claim
// counts + the set of tip ids THIS pass claimed (so the caller does not expire
// them) + `complete`: every candidate hash had usable raw evidence right now.
// THROWS on daemon/view-key failure so the caller can defer the expiry decision
// (a paid tip must never be expired because a lookup failed).
async function recoverByRawDecrypt ({ models, apply, rawReader, account, transactions, tips }) {
  const pendingPids = new Set(tips.map(t => String(t.paymentId).toLowerCase()))
  const rowByHash = new Map()
  for (const row of transactions || []) {
    if (!row.hash) continue
    const h = String(row.hash).toLowerCase()
    if (!rowByHash.has(h)) rowByHash.set(h, row)
  }
  // Candidate txs: scan rows whose served pid matches none of OUR pending
  // pids (a row whose pid matched was handled by the pid-keyed pass above).
  const candidateHashes = []
  for (const [h, row] of rowByHash) {
    if (!pendingPids.has(String(row.payment_id ?? '').toLowerCase())) candidateHashes.push(h)
  }
  // Zero candidates is a COMPLETE pass: there is nothing this account could
  // still prove. No RPC, no deferral — the caller's expiry pass runs.
  if (!candidateHashes.length) return { recovered: 0, excluded: 0, claimedTipIds: new Set(), complete: true }

  const startedAt = Date.now()
  const { raws, missingHashes, stats } = await rawReader.read(candidateHashes)
  // Safe acquisition summary: counts + elapsed only, never hashes/keys/payloads.
  console.log(`reconcilePendingTips: raw acquisition summary account=${account.id} requested=${stats.requested} cached=${stats.cached} fetched=${stats.fetched} missing=${missingHashes.length} batches=${stats.batches} retries=${stats.retries} elapsedMs=${Date.now() - startedAt}`)
  // Only decrypt when there is evidence to decrypt: an all-missing response
  // is classified as INCOMPLETE (defer), regardless of the view-key envelope
  // — with zero raws there is nothing a view key could prove.
  const viewKeyHex = raws.length > 0 ? decryptViewKey(account.viewKey) : null

  // recipient-side pid -> tx row (first hit wins; 8-byte pid collisions
  // between different txs of one account are 2^-64-negligible)
  const rowByCandidatePid = new Map()
  for (const raw of raws) {
    const row = rowByHash.get(String(raw.hash).toLowerCase())
    if (!row) continue
    for (const pid of paymentIdCandidates(raw.extra, viewKeyHex)) {
      if (!rowByCandidatePid.has(pid)) rowByCandidatePid.set(pid, row)
    }
  }

  let recovered = 0
  let excluded = 0
  const claimedTipIds = new Set()
  for (const tip of tips) {
    const row = rowByCandidatePid.get(String(tip.paymentId).toLowerCase())
    if (!row) continue
    const amount = row.piconeros ?? tip.piconeros
    const direct = tip.tipperId != null && tip.tipperId === tip.post?.userId
    const isExcluded = shouldExcludeTip({
      tipperId: tip.tipperId,
      postUserId: tip.post?.userId,
      account,
      tx: row
    })
    const out = await claimTip({ models, apply, tip, tx: row, amount, direct, isExcluded })
    if (out.recovered) recovered += 1
    if (out.excluded) excluded += 1
    if (out.recovered || out.excluded) claimedTipIds.add(tip.id)
  }
  // A partial response still yields every positively proven claim above, but
  // the missing subset means the remaining unmatched tips are NOT proven
  // nonpayers: the caller defers their expiry to the next 2-min run.
  return { recovered, excluded, claimedTipIds, complete: missingHashes.length === 0 }
}

export async function runReconcilePendingTipsOnce ({
  models, lwsClient: client = lwsClient, apply = applyTipDetected, daemonClient: daemon = null, rawReader = null
}) {
  // Injected reader wins; otherwise the shared per-daemon reader; with neither
  // the raw pass keeps its legacy no-op (existing core callers/tests).
  const reader = rawReader ?? (daemon ? getReconciliationRawReader(daemon) : null)
  const now = Date.now()
  const reconcileBefore = new Date(now - RECONCILE_PENDING_AGE_MS)
  const expireBefore = new Date(now - PENDING_EXPIRY_MS)

  const eligible = await models.observedTip.findMany({
    where: { state: 'PENDING', detectedAt: { lt: reconcileBefore } },
    include: { post: { select: { userId: true } } }
  })
  moneroPendingTips.set(eligible.length)
  if (eligible.length === 0) return { recovered: 0, expired: 0, excluded: 0, pidFallback: 0 }

  // Group stranded tips by the author account whose address lws must scan.
  const byAccount = new Map()
  for (const tip of eligible) {
    if (!byAccount.has(tip.recipientAccountId)) byAccount.set(tip.recipientAccountId, [])
    byAccount.get(tip.recipientAccountId).push(tip)
  }
  const accounts = await models.moneroAccount.findMany({
    where: { id: { in: [...byAccount.keys()] } },
    include: { viewKey: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
  })

  let recovered = 0
  let expired = 0
  let excluded = 0
  let pidFallback = 0
  for (const account of accounts) {
    const tips = byAccount.get(account.id) || []
    // Unregistered/soft-deleted accounts (view key wiped, status INACTIVE) can't be
    // scanned — walletLogin throws on a missing viewKey relation, which would abort
    // the entire run and strand every other account's tips. Skip the scan but still
    // expire this account's tips below (byPid stays empty, so each tip falls to expiry).
    const unscannable = !account.viewKey || account.status !== 'ACTIVE'
    const byPid = new Map()
    let scanTxs = []
    if (!unscannable) {
      const resp = await client.getAddressTxs(account, 0, null)
      scanTxs = resp.transactions || []
      for (const tx of scanTxs) {
        if (tx.payment_id) byPid.set(String(tx.payment_id).toLowerCase(), tx)
      }
    }

    // Pass 1 — pid-keyed claims (today's behavior, byte-for-byte).
    const unmatched = []
    for (const tip of tips) {
      const tx = byPid.get(String(tip.paymentId).toLowerCase())
      if (!tx) {
        unmatched.push(tip)
        continue
      }
      const amount = tx.piconeros ?? tip.piconeros
      const direct = tip.tipperId != null && tip.tipperId === tip.post?.userId
      const isExcluded = shouldExcludeTip({
        tipperId: tip.tipperId,
        postUserId: tip.post?.userId,
        account,
        tx
      })
      const out = await claimTip({ models, apply, tip, tx, amount, direct, isExcluded })
      if (out.recovered) recovered += 1
      if (out.excluded) excluded += 1
    }

    // Pass 2 — wrong-pid raw-decrypt fallback for the unmatched remainder
    // (no reader/daemon -> legacy no-op). A failure or a PARTIAL evidence
    // response defers this account's expiry decisions to the next run
    // (anti-strand), never aborts the job.
    let fallbackClaimed = new Set()
    if (unmatched.length && reader && !unscannable) {
      try {
        const out = await recoverByRawDecrypt({
          models, apply, rawReader: reader, account, transactions: scanTxs, tips: unmatched
        })
        recovered += out.recovered
        excluded += out.excluded
        pidFallback += out.recovered + out.excluded
        fallbackClaimed = out.claimedTipIds
        if (!out.complete) {
          // Some candidate hashes had no usable raw evidence right now.
          // Caught claims stand (each is cryptographically proven), but the
          // still-unmatched tips must not be judged from an incomplete
          // response: defer their expiry; the next 2-min run retries.
          alert('warn', 'lws raw-decrypt fallback incomplete',
            `account ${account.id}: raw evidence unavailable; unmatched tip expiry deferred`,
            { dedupeKey: `lws-pid-fallback-incomplete-${account.id}` })
          continue
        }
      } catch (err) {
        // Fixed-category classification only — never the arbitrary error text.
        alert('warn', 'lws raw-decrypt fallback failed',
          `${rawLookupCategory(err)} — expiry deferred for ${unmatched.length} tip(s) on account ${account.id}; next run retries`,
          { dedupeKey: 'lws-pid-fallback-error' })
        // nothing on this account expires this run
        continue
      }
    }

    // Pass 3 — expire the still-unmatched, now past PENDING_EXPIRY_MS.
    for (const tip of unmatched) {
      if (fallbackClaimed.has(tip.id)) continue
      if (tip.detectedAt >= expireBefore) continue
      await models.observedTip.updateMany({
        where: { id: tip.id, state: 'PENDING' },
        data: { state: 'EXPIRED' }
      })
      expired += 1
    }
  }
  moneroTipsRecoveredTotal.inc(recovered)
  moneroTipsExpiredTotal.inc(expired)
  if (recovered >= RECONCILE_RECOVERED_WARN) {
    const level = recovered >= RECONCILE_RECOVERED_CRITICAL ? 'critical' : 'warn'
    alert(level, 'missed tip webhooks',
      `${recovered} tips recovered by reconciliation scan — webhooks missed`,
      { dedupeKey: 'missed-tip-webhooks' })
  }
  if (pidFallback > 0) {
    alert('warn', 'lws payment-id misattribution recovered',
      `${pidFallback} tip(s) recovered by raw-decrypt fallback — lws is serving wrong payment ids for multi-account txs`,
      { dedupeKey: 'lws-pid-misattribution' })
  }
  return { recovered, expired, excluded, pidFallback }
}

export async function reconcilePendingTips ({ models }) {
  // Recurrence is cron-owned (pgboss.schedule row reconcilePendingTips); no
  // self-requeue.
  const out = await runReconcilePendingTipsOnce({ models, daemonClient })
  if (out.recovered || out.expired || out.excluded) {
    console.log(`reconcilePendingTips: recovered ${out.recovered}, expired ${out.expired}, excluded ${out.excluded}`)
  }
}
