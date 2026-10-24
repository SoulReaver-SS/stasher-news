import { lwsClient } from '@/api/monero/lwsClient'
import { daemonClient } from '@/api/monero/daemonClient'
import { applyFeeReceipt, excludeProvisionalFeeReceipt } from '@/api/monero/feeObservation'
import { resolveFeeAccount } from '@/api/monero/ownerFeeLeg'
import { isSelfSend } from '@/api/monero/selfTip'
import { decryptViewKey } from '@/api/monero/viewkey'
import { createReconciliationCheckpoint, scanRawPaymentIds } from '@/worker/reconciliationScan'
import { getReconciliationRawReader } from '@/worker/reconciliationRawTransactions'
import { alert } from '@/lib/alert'

// Cron-owned backstop for integrated-address fee legs (the eighth
// money-observation chain). Historically owner-routed only — hence the file
// and pg-boss job name `reconcileOwnerFeeLegs`, kept for persisted
// schedule/queue compatibility — it now also covers PLATFORM fee legs
// (posting/turf/boost invoices paying the rewards wallet primary). Legs are
// grouped by their FROZEN recipient account (SubFeePidMap.recipientAccountId;
// historical owner legs fall back to the owner's ACTIVE account) and the
// shared applier (api/monero/feeObservation.js) picks the ledger. The lws
// tx-confirmation webhook is primary; this chain self-heals:
//   - a missed 0-conf callback (deploy restart across the confirmation
//     window): re-observes receipts via lws and re-runs the cumulative gate,
//     flipping PENDING_FEE items before abandonFeeItems strikes at 1 day;
//   - a missed N-conf callback: backfills the receipt + height (always at
//     confirmations 0 — never fabricated; the confirmFinalizer ObservedSubFee
//     pass matures height-bearing DETECTED rows with exact counts);
//   - a WRONG-PID lws row (mainnet incident 2026-10-08): monero-lws decrypts
//     an encrypted payment id ONCE per scan pass — with the first matching
//     registered account's derivation — and stores those bytes on every
//     matching account's row. When the payer is also lws-registered and scans
//     first, the owner's row carries the payer-side decryption: the webhook
//     never fires and the served-pid match finds nothing. The raw-decrypt
//     fallback (mirroring reconcilePendingTips) fetches the raw txs from
//     monerod and decrypts the encrypted pid with the OWNER's view key
//     (api/monero/pidDecrypt.js) — cryptographic proof of addressing — then
//     replays through the same self-send refusal + shared applier.
// Fee legs differ from tips in one load-bearing way: a leg allows MULTIPLE
// top-up txs under one payment id, so discovery must inspect EVERY remaining
// transaction row — a served-pid hit for one receipt must not stop the search.
// Raw discovery is attribution-only: the amount/height still come from the
// owner account's lws row (a raw extra proves the pid, never the RingCT
// amount), and every receipt keeps the applier's provisional-height discipline.
// It runs through the shared bounded reader (worker/reconciliationRawTransactions.js):
// completed batches survive later failures/ticks, while incomplete evidence
// only warns + defers — it never fabricates a receipt. Never self-requeues —
// a failed run heals at the next hourly cron tick.

// The single receipt path shared by served-pid matches and raw-decrypt
// matches. Extracted so both paths keep byte-identical money effects:
// idempotent applier call, issued-pid binding, exact self-send refusal
// (foreign-index spent_outputs stay legitimate). Returns the applier result,
// or null when the self-send ban refused the receipt.
async function replayFeeReceipt ({ models, account, leg, tx }) {
  const paymentId = leg.feeMap.paymentId
  // Self-payments can inflate receipts with change (2026-09-19). Use the
  // shared closure gate, not candidate presence: lws includes decoy references.
  // Match cleanup by ISSUED pid + hash; raw-discovery rows can have scrambled
  // served PIDs. Only provisional receipts are excluded, as in the webhook.
  if (isSelfSend(account, tx)) {
    const excluded = await excludeProvisionalFeeReceipt(models, leg.feeMap, tx.hash)
    if (excluded > 0) {
      alert('warn', leg.feeMap.feeType != null ? 'platform fee self-payment refused' : 'owner-fee self-payment refused',
        `fee leg ${paymentId} tx ${tx.hash}: payer shares the owner account (change-inflated); provisional receipt excluded by the backstop`,
        { dedupeKey: `subfee-selfpay-${paymentId}-${tx.hash}` })
    }
    return null
  }
  // Replay through the shared applier — idempotent by construction (one
  // receipt row per tx, ON CONFLICT DO NOTHING), so an hourly rescan of an
  // already-replayed receipt only re-runs the cumulative gate.
  return await applyFeeReceipt(models, {
    feeMap: leg.feeMap,
    feePayIn: leg.feePayIn,
    txHash: tx.hash,
    piconeros: tx.piconeros,
    height: tx.height ?? null,
    confirmations: 0 // never fabricated — confirmFinalizer matures height-bearing rows
  })
}

// The wrong-pid discovery pass for ONE owner account. Produces replay
// candidates only — no money effects here, so an acquisition/decryption
// failure can defer the whole pass without a partial write. Raw txs are
// joined back to the EXACT lws rows that requested them (hash-keyed), so a
// response that omits or invents hashes can never stand in for the requested
// transaction. A candidate hash yielding more than one distinct active pid is
// refused outright (ambiguous attribution is not evidence for either leg).
async function findRawFeeMatches ({ rawReader, account, rowsByHash, legByPid, checkpoint }) {
  const hashes = [...rowsByHash.keys()]
  if (!hashes.length) return []
  const startedAt = Date.now()
  const { raws, missingHashes, stats } = await rawReader.read(hashes)
  // Safe acquisition summary: counts + elapsed only, never hashes/keys/payloads.
  console.log(`reconcileOwnerFeeLegs: raw acquisition summary account=${account.id} requested=${stats.requested} cached=${stats.cached} fetched=${stats.fetched} missing=${missingHashes.length} batches=${stats.batches} retries=${stats.retries} elapsedMs=${Date.now() - startedAt}`)
  const viewKeyHex = decryptViewKey(account.viewKey)
  const matches = []
  const seen = new Set()
  for await (const { raw, pids: candidates } of scanRawPaymentIds(raws, viewKeyHex, checkpoint)) {
    const hash = String(raw.hash ?? '').toLowerCase()
    const tx = rowsByHash.get(hash)
    if (!tx || seen.has(hash)) continue
    seen.add(hash)
    const pids = [...new Set(candidates)].filter(pid => legByPid.has(pid))
    if (pids.length === 1) matches.push({ tx, leg: legByPid.get(pids[0]) })
    if (pids.length > 1) {
      alert('warn', 'owner-fee ambiguous raw payment id refused',
        `account ${account.id}, tx ${hash}: multiple active fee PIDs; no receipt replayed`,
        { dedupeKey: `subfee-pid-ambiguous-${account.id}-${hash}` })
    }
  }
  // Missing raw evidence is NOT proof of nonpayment: the applier was never
  // consulted for those rows. Warn so a silently-shrunken response cannot
  // strand a paid leg unnoticed; the next hourly run retries (lws history
  // persists, and a pruned/never-scanned row simply stays unmatched).
  if (missingHashes.length > 0) {
    alert('warn', 'owner-fee raw transaction evidence incomplete',
      `account ${account.id}: ${missingHashes.length} of ${hashes.length} raw transactions unavailable; next hourly run retries`,
      { dedupeKey: `subfee-pid-fallback-incomplete-${account.id}` })
  }
  return matches
}

export async function runReconcileOwnerFeeLegsOnce ({ models, monero = lwsClient, daemonClient: daemon = null, rawReader = null, checkpoint = createReconciliationCheckpoint() }) {
  // Injected reader wins; otherwise the shared per-daemon reader; with neither
  // the raw pass keeps its legacy no-op (existing core callers/tests).
  const reader = rawReader ?? (daemon ? getReconciliationRawReader(daemon) : null)
  // Active legs = intents inside their webhook-retention window. NO
  // payInState filter: fee payIns are created PAID by design (piconeros=0 —
  // the fee-gated Item/Sub lives on Item.feeStatus, not the PayIn; see
  // api/payIn/types/itemCreate.js getInitial). The earlier
  // `payInState: 'PENDING_PAYMENT'` filter could never match, so this backstop
  // never scanned a single leg (2026-09-19 fix). Re-scanning settled legs is
  // harmless: the applier's insert/CAS are idempotent and flipPendingToLive is
  // guarded by WHERE feeStatus = 'PENDING_FEE'. Owner legs still need their
  // PayIn (legacy semantics; the webhook records abandoned owner receipts);
  // platform legs stay eligible without one so an abandoned invoice's
  // receipt is still booked as rewards-wallet cash (payInId NULL, no gate).
  // Past retention, served-pid platform receipts are still booked by
  // rewardsWalletObserver; only raw wrong-pid recovery is window-bound.
  const maps = await models.subFeePidMap.findMany({
    where: { expiresAt: { gt: new Date() } }
  })
  if (maps.length === 0) return { legs: 0, replayed: 0, flipped: 0, pidFallback: 0 }

  const payIns = await models.payIn.findMany({
    where: { moneroPaymentId: { in: maps.map(m => m.paymentId) } }
  })
  const byPid = new Map(payIns.map(p => [p.moneroPaymentId, p]))
  const legs = maps.filter(m => m.feeType != null || byPid.has(m.paymentId))
  if (legs.length === 0) return { legs: 0, replayed: 0, flipped: 0, pidFallback: 0 }

  // Group by recipient account; one full-history scan per account per run.
  const byAccount = new Map()
  for (const leg of legs) {
    const key = leg.recipientAddress != null ? `account ${leg.recipientAccountId}` : `owner ${leg.ownerUserId}`
    if (!byAccount.has(key)) byAccount.set(key, [])
    byAccount.get(key).push(leg)
  }

  let replayed = 0
  let pidFallback = 0
  for (const [accountKey, accountLegs] of byAccount) {
    const pause = checkpoint()
    if (pause) await pause
    const platform = accountLegs.some(leg => leg.feeType != null)
    // Frozen recipient (snapshot-checked) for new legs; the legacy owner
    // fallback for historical ones. Every leg in a group shares the account.
    const account = await resolveFeeAccount(models, accountLegs[0])
    if (!account?.viewKey || (platform && account.status !== 'ACTIVE')) {
      // Owner legs: unscannable, webhook remains primary (legacy). Platform
      // legs fail loudly — their cash and gates depend on this account.
      if (platform) {
        alert('critical', 'platform fee reconciliation unavailable',
          `${accountKey}: not scannable or no longer matches its intent snapshot; ${accountLegs.length} leg(s) deferred`,
          { dedupeKey: `platform-fee-reconcile-unscannable-${accountLegs[0].recipientAccountId}` })
      }
      continue
    }
    let txs
    try {
      txs = (await monero.getAddressTxs(account, 0, null)).transactions || []
    } catch (err) {
      console.warn(`reconcileOwnerFeeLegs: lws scan failed for ${accountKey}: ${err?.message || err}`)
      continue
    }

    // Owner-local lookup keyed by NORMALIZED served pid; the value retains the
    // ISSUED pid (the applier/cryptography key) and the exact PayIn row.
    const legByPid = new Map(accountLegs.map(leg => [String(leg.paymentId).toLowerCase(), {
      feeMap: leg,
      feePayIn: byPid.get(leg.paymentId) ?? null
    }]))

    // Dedup by lowercase hash (lws can repeat rows across scan passes) and
    // anchor each row to its hash for the raw join. Hashless rows cannot be
    // anchored and are never replayed.
    const rowsByHash = new Map()
    for (const row of txs) {
      if (!row.hash) continue
      // An integrated address always pays the PRIMARY (0,0): on the rewards
      // wallet every subaddress-pool row is out of scope (and would only feed
      // the raw pass needless decryption work).
      if (platform && ((row.recipient?.maj_i ?? 0) !== 0 || (row.recipient?.min_i ?? 0) !== 0)) continue
      const hash = String(row.hash).toLowerCase()
      if (!rowsByHash.has(hash)) rowsByHash.set(hash, { ...row, hash })
    }

    // Pass 1 — served-pid matches (the webhook-path case, byte-for-byte).
    // Non-matches (including NULL pids) are collected for raw discovery; a hit
    // never removes the other rows from that search (multi-tx top-ups).
    const rawRows = new Map()
    for (const [hash, tx] of rowsByHash) {
      const leg = legByPid.get(String(tx.payment_id ?? '').toLowerCase())
      if (!leg) {
        rawRows.set(hash, tx)
        continue
      }
      const result = await replayFeeReceipt({ models, account, leg, tx })
      if (result) replayed += 1
    }

    // Pass 2 — wrong-pid raw-decrypt discovery for the remaining rows. Catch
    // ONLY the acquisition/decryption step: a paid leg must not be missed
    // because monerod or the view-key envelope was down (retry next run), but
    // an applier/DB write failure outside this catch must fail the cron run
    // and retry rather than masquerade as a lookup miss.
    let rawMatches = []
    if (reader && rawRows.size) {
      try {
        rawMatches = await findRawFeeMatches({ rawReader: reader, account, rowsByHash: rawRows, legByPid, checkpoint })
      } catch {
        // Fixed-category diagnostics only: transport/crypto error text can
        // embed sensitive input (key material, raw payloads), so neither this
        // log nor the alert below may echo exception content.
        console.warn(`reconcileOwnerFeeLegs: raw-decrypt fallback failed for ${accountKey} (${rawRows.size} candidate(s)); next hourly run retries`)
        alert('warn', 'owner-fee raw-decrypt fallback failed',
          `account ${account.id}: raw acquisition or view-key decryption failed for ${rawRows.size} candidate(s); next hourly run retries`,
          { dedupeKey: `subfee-pid-fallback-error-${account.id}` })
      }
    }
    let ownerRecovered = 0
    for (const { tx, leg } of rawMatches) {
      const result = await replayFeeReceipt({ models, account, leg, tx })
      if (result) replayed += 1
      // Only a NEW height transition is a recovery: provisional inserts,
      // replays, EXCLUDED rows, and already-matured receipts do not re-alert.
      if (result?.transitioned) ownerRecovered += 1
    }
    pidFallback += ownerRecovered
    if (ownerRecovered > 0) {
      alert('warn', 'owner-fee payment-id misattribution recovered',
        `account ${account.id}: ${ownerRecovered} owner-fee receipt(s) newly height-bound by raw PID discovery`,
        { dedupeKey: `subfee-pid-misattribution-${account.id}` })
    }
  }
  // `replayed` counts applier calls and `flipped` is its legacy alias — NOT an
  // actual item-flip count. `pidFallback` counts only newly height-bound raw
  // recoveries (raw path + transitioned).
  return { legs: legs.length, replayed, flipped: replayed, pidFallback }
}

export async function reconcileOwnerFeeLegs ({ models }) {
  // The production wrapper MUST pass the daemon singleton: without it the raw
  // fallback silently no-ops and wrong-pid legs strand again.
  const out = await runReconcileOwnerFeeLegsOnce({ models, daemonClient })
  if (out.replayed > 0) {
    console.log(`reconcileOwnerFeeLegs: ${out.legs} active leg(s) scanned, ${out.replayed} receipt(s) replayed through the cumulative gate`)
  }
  return out
}
