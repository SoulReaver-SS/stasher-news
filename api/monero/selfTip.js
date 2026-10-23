import { Prisma } from '@prisma/client'
import { applyTipDetected, reverseTip } from '@/api/monero/ranking'
import { nextLwsCursor } from '@/api/monero/lwsCursor'
import { alert } from '@/lib/alert'
import { moneroTxNotFoundExclusionsTotal } from '@/lib/metrics'

// lws spent_outputs are ring-member candidates, including decoys: a view key
// cannot verify actual spends. Require sum(own candidates) - fee == received
// before excluding. This is a heuristic, not cryptographic proof; extra
// candidates or a foreign destination can break closure on a real self-send.
// Missing/invalid amounts fail open; unclosed own candidates warn for review.
// Wire shape: sender.{maj_i,min_i}, amount as a decimal string. See the probe
// script for deployed shape/fee availability; only top-level amounts are parsed.

function ownSubaddressSet (account) {
  const set = new Set(['0,0']) // the primary address is always (0,0)
  for (const s of account?.subaddresses || []) {
    set.add(`${s.majorIndex},${s.minorIndex}`)
  }
  return set
}

// Missing/invalid evidence is unavailable, never implicitly zero.
function parsePiconeros (v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v)
  return null
}

function ownCandidates (account, tx) {
  if (!tx || !Array.isArray(tx.spent_outputs)) return []
  const own = ownSubaddressSet(account)
  return tx.spent_outputs.filter(so => {
    const maj = so?.sender?.maj_i
    const min = so?.sender?.min_i
    return maj != null && min != null && own.has(`${maj},${min}`)
  })
}

// Review signal only: account-owned ring references need not be real spends.
export function hasOwnSpendCandidates (account, tx) {
  return ownCandidates(account, tx).length > 0
}

export function isSelfSend (account, tx) {
  const candidates = ownCandidates(account, tx)
  if (candidates.length === 0) return false
  let sum = 0n
  for (const so of candidates) {
    const amount = parsePiconeros(so?.amount)
    if (amount == null) return false // unavailable evidence is not zero
    sum += amount
  }
  const fee = parsePiconeros(tx.fee)
  const received = parsePiconeros(tx.piconeros)
  if (fee == null || received == null) return false
  return sum - fee === received
}

export function shouldExcludeTip ({ tipperId, postUserId, account, tx }) {
  if (tipperId != null && tipperId === postUserId) return true
  return isSelfSend(account, tx)
}

// Resolve an item's turf name with the same COALESCE(root, item) logic the
// ranking/trust code uses; null when the item has no subNames. Rare-path
// helper (only called on exclusions), one indexed-PK query.
export async function resolveItemSubName (postId, handle) {
  const q = Prisma.sql`
    SELECT COALESCE(r."subNames"[1], i."subNames"[1]) AS "subName"
    FROM "Item" i
    LEFT JOIN "Item" r ON r.id = i."rootId"
    WHERE i.id = ${postId}::INTEGER`
  const rows = await handle.$queryRaw(q)
  return rows?.[0]?.subName ?? null
}

// Find the lws tx row for a payment id on a scannable recipient account.
// HASH-FIRST (review finding 1): when the caller names a tx hash, only that
// exact tx counts as evidence — a tx selected by payment id alone is NOT
// evidence for the named hash, because same-pid dust collisions must not
// resolve to the wrong tx. With no named hash the pid lookup is unchanged
// (last-wins is fine for hash-free claims). lookupTipTxMeta returns
// { tx, blockchainHeight, collision }; `collision` is true when a named hash
// missed while a different same-pid tx exists (the pid-reuse signal — callers
// alert deduped; it is never itself evidence for the named hash).
// Incremental scan via the account's lastTxId cursor (full history was
// O(account age) per tip callback). Guarantee: if the incremental response
// does not contain OUR tx/pid, fall back to one full scan — the detection
// semantics can only match today's, never regress. A mempool tx may lack an
// id / be excluded from since_tx_id responses, and the fallback covers that
// too (worst case = fail-open non-exclusion, same as when the account is
// unscannable). The cursor advance is forward-only and best-effort (a lost
// advance only costs one fuller scan) — and is SKIPPED entirely for the
// platform rewards account, whose lastTxId belongs to the
// rewardsWalletObserver (see the guard below). Errors propagate to the caller.
export async function lookupTipTxMeta (models, monero, account, paymentId, { txHash = null } = {}) {
  const match = (txs) => {
    const byHash = new Map()
    const byPid = new Map()
    for (const t of (txs || [])) {
      if (t.hash) byHash.set(String(t.hash).toLowerCase(), t)
      if (t.payment_id) byPid.set(String(t.payment_id).toLowerCase(), t)
    }
    // Hash-first (review finding 1): when the claim/row names a hash, a tx
    // selected by pid is NOT evidence for it — same-pid dust collisions must
    // not resolve to the wrong tx.
    if (txHash != null) {
      const exact = byHash.get(String(txHash).toLowerCase()) ?? null
      const samePid = byPid.get(String(paymentId).toLowerCase()) ?? null
      return { tx: exact, collision: exact == null && samePid != null }
    }
    return { tx: byPid.get(String(paymentId).toLowerCase()) ?? null, collision: false }
  }
  let resp = await monero.getAddressTxs(account, account.lastTxId ?? 0, null)
  let hit = match(resp.transactions)
  // A locally-declared 'full' adapter returns the account's complete history
  // in one response, so a miss is definitive: no second fetch and no
  // lookup-only cursor write. Unknown/missing mode keeps the real fallback.
  const fullSnapshot = monero.addressTxsMode === 'full'
  if (!hit.tx && !fullSnapshot && account.lastTxId != null) {
    resp = await monero.getAddressTxs(account, 0, null)
    const full = match(resp.transactions)
    hit = { tx: full.tx, collision: hit.collision || full.collision }
  }
  // Forward-only cursor advance (never regresses on concurrent/lws re-sends)
  // — but NEVER for the platform rewards account: its lastTxId is the
  // rewardsWalletObserver's incremental watermark, and the observer is the
  // ONLY attributor for fee-subaddress outputs, DONATE payIns, and
  // upload-paid flips (none register lws webhooks). A webhook/finalizer
  // lookup advancing this cursor permanently skips every tx between the old
  // watermark and the response's newest id (lws since_tx_id never
  // re-delivers them) with no re-attribution backstop — starved fees leave
  // items PENDING_FEE until abandonFeeItems deletes them. The observer
  // itself advances the cursor every minute, so verification lookups stay
  // incremental without this write. (Audit 2026-09-11, finding 1.)
  if (account.label !== 'platform_rewards' && !fullSnapshot) {
    // Mined-only candidate progress: lws v1.0.4 mempool IDs are response
    // positions and must never advance a durable watermark (the observer
    // shares this rule via the same helper). Lookup-only callers on a
    // full-snapshot adapter never write progress at all — the observer owns it.
    const next = nextLwsCursor(resp.transactions || [], account.lastTxId ?? null)
    if (next !== null && (account.lastTxId == null || next > account.lastTxId)) {
      await models.moneroAccount.updateMany({
        where: { id: account.id, OR: [{ lastTxId: null }, { lastTxId: { lt: next } }] },
        data: { lastTxId: next }
      }).catch(() => {}) // best-effort: a lost advance only costs one fuller scan
    }
  }
  return { tx: hit.tx, blockchainHeight: resp.blockchain_height ?? null, collision: hit.collision }
}

export async function lookupTipTx (models, monero, account, paymentId, opts) {
  return (await lookupTipTxMeta(models, monero, account, paymentId, opts)).tx
}

// True when a DETECTED tip's stored amount/txHash disagree with the chain tx
// found for its payment id — evidence of a forged pre-verification callback
// (audit 2026-09-11, finding 2). Hash comparison only when BOTH are present: a
// NULL stored txHash is not itself forgery evidence (callbacks may omit
// tx_hash; verifyReceiptAmount tolerates that at detection). A multi-pid
// single-tx compares against the whole-tx amount — the same accepted posture
// as verifyReceiptAmount. Exported for the audit script
// (scripts/audit-detected-tips.js).
export function chainMismatch (tip, tx) {
  if (!tx) return false
  if (tx.piconeros != null && BigInt(tx.piconeros) !== BigInt(tip.piconeros)) return true
  if (tip.txHash != null && tx.hash != null &&
      String(tip.txHash).toLowerCase() !== String(tx.hash).toLowerCase()) return true
  return false
}

// Confirm-time re-check (the 0-conf gap). At detection the tx is in the
// mempool and lws get_address_txs carries no spent_outputs for it, so the
// self-send check fails open — the documented worst case. Once MINED the
// evidence exists, so this re-check runs at the last gate before CONFIRMED
// credit (the webhook N-conf callback and the confirmFinalizer maturity pass —
// the only two claimers of DETECTED -> CONFIRMED) and at the webhook's first
// callback that carries a block height.
//
// RETURN CONTRACT: { action, reason?, piconeros?, txHash?, rankDelta? }
//   - 'clean'     — nothing to do (unscannable account, another claimer won
//                   the transition, or a bound row that matches the chain).
//                   When a caller loses the correctAndBind binding race, the
//                   return carries `piconeros` = the amount the winning
//                   claimer bound, so credit callers never use their stale
//                   in-memory snapshot (which can be the pre-correction
//                   provisional amount — a wrong-money credit).
//   - 'excluded'  — THIS caller claimed DETECTED -> EXCLUDED (reason:
//                   DIRECT_SELF_TIP | SELF_SEND | CHAIN_MISMATCH |
//                   TX_NOT_FOUND); the ranking delta was reversed and the
//                   AbuseSignal written inside the same Serializable tx.
//   - 'corrected' — THIS caller bound an unbound row (amountVerifiedAt null)
//                   to the chain tx: reversed the provisional delta, re-applied
//                   at the chain amount (rankDelta), and stamped
//                   piconeros/txHash/rankPiconeros/height. Two-phase amount
//                   correction — an unbound row is TRUSTED-CORRECTED, never
//                   CHAIN_MISMATCH-excluded; only a BOUND row that still
//                   disagrees with the chain is forged evidence.
//   - 'deferred'  — no exclusion claimed; retry later (reason:
//                   'daemon_unreachable' | 'lws_miss_monerod_has_tx' |
//                   'amount_unavailable').
//
// HASH-FIRST ANCHOR (review finding 1): the row's own txHash — when a valid
// 64-hex hash — is the only tx that counts as evidence; a same-pid tx selected
// by payment id alone never resolves for a named hash (lookupTipTxMeta
// collision signal, alert deduped by pid).
//
// FAIL-CLOSED TX_NOT_FOUND: a plain lws miss no longer fails open. Before
// excluding, the anchored hash is corroborated against monerod (the `daemon`
// client): monerod unreachable -> 'deferred' (retry next run); monerod still
// has the tx (lws lag) -> 'deferred'; absent from BOTH -> TX_NOT_FOUND
// exclusion claim (Serializable, state-guarded, reverseTip + AbuseSignal with
// the TX_NOT_FOUND_EXCLUDED kind and stored-vs-chain details).
//
// Exclusion dispositions (spec §2.3, audit 2026-09-11 finding 2):
//   - DIRECT_SELF_TIP: tipper == author, no scan needed.
//   - SELF_SEND: own-index candidates close exactly against the tx's received
//     amount (not the provisional tip amount) -> claim
//     EXCLUDED from DETECTED (atomic conditional UPDATE, race-safe vs the
//     CONFIRMED claim), reverse the detection-applied ranking delta via
//     reverseTip, write the AbuseSignal. Unclosed candidates warn, not exclude.
//   - CHAIN_MISMATCH: a BOUND row whose stored piconeros/txHash disagree with
//     the chain tx — forged through the pre-verification webhook; same
//     EXCLUDED + reverseTip + AbuseSignal disposition.
// All exclusion claims in ONE Serializable transaction.
//
// Guards mirror the detection-time check: unscannable accounts (view key
// wiped / INACTIVE) return 'clean' (documented fail-open posture); the
// DIRECT_SELF_TIP case needs no scan. `prefetchedTx` lets a caller that
// already fetched the tx (the webhook's C4 receipt verification) share its
// lookup — one lws call per callback; a prefetched tx whose hash is foreign
// to the row's anchored hash is discarded (it is not evidence).
// `daemon` (monerod client, optional) powers the TX_NOT_FOUND corroboration;
// when null the lws miss goes straight to the exclusion claim (dormant until
// production wiring lands).
// Streaks granted at DETECTED are an accepted residual (same as REORGED).
// lws errors propagate (webhook: non-200 so lws retries; finalizer: skip the
// tip, retry next run).
async function claimExclusion ({ models, tip, reason, confirmations, height, tx }) {
  let claimed = 0
  await models.$transaction(async (txh) => {
    claimed = await txh.$executeRaw`
      UPDATE "ObservedTip"
      SET state = 'EXCLUDED', "exclusionReason" = ${reason}::"TipExclusionReason",
          confirmations = ${confirmations}, height = COALESCE("height", ${height}::INT)
      WHERE id = ${tip.id} AND state = 'DETECTED'`
    if (claimed > 0) {
      await reverseTip(tip.postId, tip.tipperId, tip.piconeros, tip.rankPiconeros, txh)
      const subName = await resolveItemSubName(tip.postId, txh)
      const details = { lateRecheck: true }
      if (reason === 'SELF_SEND') details.note = 'amount recorded as lws reported it (change-output inflation possible)'
      if (reason === 'CHAIN_MISMATCH' || reason === 'TX_NOT_FOUND') {
        details.storedPiconeros = String(tip.piconeros)
        details.onChainPiconeros = tx?.piconeros == null ? null : String(tx.piconeros)
        details.storedTxHash = tip.txHash ?? null
        details.onChainTxHash = tx?.hash ?? null
      }
      await txh.abuseSignal.create({
        data: {
          kind: reason === 'CHAIN_MISMATCH'
            ? 'CHAIN_MISMATCH_EXCLUDED'
            : reason === 'TX_NOT_FOUND'
              ? 'TX_NOT_FOUND_EXCLUDED'
              : (tip.tipperId != null && tip.tipperId === tip.post?.userId ? 'SELF_TIP_EXCLUDED' : 'SELF_SEND_EXCLUDED'),
          subjectUserId: tip.post.userId,
          actorUserId: tip.tipperId ?? null,
          tipId: tip.id,
          postId: tip.postId,
          subName,
          piconeros: tip.piconeros,
          txHash: tip.txHash || tx?.hash || 'unknown',
          paymentId: tip.paymentId,
          details
        }
      })
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  // Terminal TX_NOT_FOUND exclusions only (a won claim, not a lost race or a
  // different reason): the metric is the operator signal for the fail-closed
  // disposition — DETECTED rows that exist on neither lws nor monerod.
  if (claimed > 0 && reason === 'TX_NOT_FOUND') moneroTxNotFoundExclusionsTotal.inc()
  return claimed > 0 ? { action: 'excluded', reason } : { action: 'clean' }
}

async function correctAndBind ({ models, tip, tx, confirmations, height }) {
  // A chain row without an amount is not bindable evidence: binding 0n would
  // trust-correct the row to zero (and reverse/re-apply its ranking at the
  // wrong amount). Treat it as unverifiable — no write, no credit, retry next
  // pass (the same fail-closed posture as an lws miss).
  if (tx.piconeros == null) return { action: 'deferred', reason: 'amount_unavailable' }
  const newAmount = BigInt(tx.piconeros)
  let rankDelta = null
  let claimed = 0
  let boundPiconeros = null
  await models.$transaction(async (txh) => {
    // Atomic binding claim (review finding 4): only one caller may reverse the
    // provisional delta and re-apply it. A concurrent finalizer/webhook that
    // already bound the row loses here (0 rows) instead of double-applying,
    // and does NOT rely on a Serializable abort (which would 500 the webhook).
    claimed = await txh.$executeRaw`
      UPDATE "ObservedTip" SET "amountVerifiedAt" = NOW()
      WHERE id = ${tip.id} AND state = 'DETECTED' AND "amountVerifiedAt" IS NULL`
    if (claimed === 0) {
      // Lost the binding race: the winner bound the row to the chain tx. Read
      // the row's bound amount inside the same transaction so the caller
      // credits THAT, never its stale snapshot (which may still hold the
      // pre-correction provisional amount — a wrong-money credit).
      const rows = await txh.$queryRaw`
        SELECT piconeros FROM "ObservedTip" WHERE id = ${tip.id}`
      boundPiconeros = rows?.[0]?.piconeros == null ? null : BigInt(rows[0].piconeros)
      return
    }
    await reverseTip(tip.postId, tip.tipperId, tip.piconeros, tip.rankPiconeros, txh)
    rankDelta = await applyTipDetected(tip.postId, tip.tipperId, newAmount, txh)
    await txh.$executeRaw`
      UPDATE "ObservedTip"
      SET piconeros = ${newAmount}, "txHash" = ${tx.hash}, "rankPiconeros" = ${rankDelta},
          height = COALESCE(height, ${tx.height ?? null}::INT)
      WHERE id = ${tip.id} AND state = 'DETECTED'`
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  if (claimed === 0) {
    return boundPiconeros == null ? { action: 'clean' } : { action: 'clean', piconeros: boundPiconeros }
  }
  return { action: 'corrected', piconeros: newAmount, txHash: tx.hash, rankDelta }
}

export async function recheckDetectedTip ({ models, monero, daemon = null, tip, confirmations = 0, height = null, prefetchedTx = null }) {
  const account = tip.recipientAccount
  if (!account?.viewKey || account.status !== 'ACTIVE') return { action: 'clean' }
  const direct = tip.tipperId != null && tip.tipperId === tip.post?.userId
  if (direct) return claimExclusion({ models, tip, reason: 'DIRECT_SELF_TIP', confirmations, height, tx: null })

  const anchoredHash = /^[0-9a-f]{64}$/i.test(String(tip.txHash || '')) ? String(tip.txHash).toLowerCase() : null
  let tx = prefetchedTx
  if (tx && anchoredHash && String(tx.hash || '').toLowerCase() !== anchoredHash) tx = null
  let collision = false
  if (!tx) {
    const meta = await lookupTipTxMeta(models, monero, account, tip.paymentId, { txHash: anchoredHash })
    tx = meta.tx
    collision = meta.collision
  }

  if (!tx) {
    if (collision) {
      alert('warn', 'payment-id collision at credit-time recheck',
        `${tip.paymentId}: stored hash absent while a same-pid tx exists on the account (tip ${tip.id})`,
        { dedupeKey: `pid-collision-${tip.paymentId}` })
    }
    if (daemon && anchoredHash) {
      let raws
      try {
        raws = await daemon.getTransactions([anchoredHash])
      } catch {
        return { action: 'deferred', reason: 'daemon_unreachable' }
      }
      if (raws.length > 0) return { action: 'deferred', reason: 'lws_miss_monerod_has_tx' }
    }
    return claimExclusion({ models, tip, reason: 'TX_NOT_FOUND', confirmations, height, tx: null })
  }

  if (isSelfSend(account, tx)) return claimExclusion({ models, tip, reason: 'SELF_SEND', confirmations, height, tx })
  // Decoys and self-sends with foreign outputs can both fail closure: review only.
  if (hasOwnSpendCandidates(account, tx)) {
    alert('warn', 'unclosed Monero spend candidates',
      `tip ${tip.id}: recipient-owned ring candidates do not establish self-send closure; review only`,
      { dedupeKey: `spend-candidate-unclosed-${tx.hash}` })
  }
  if (!tip.amountVerifiedAt) return correctAndBind({ models, tip, tx, confirmations, height })
  if (chainMismatch(tip, tx)) return claimExclusion({ models, tip, reason: 'CHAIN_MISMATCH', confirmations, height, tx })
  // Verified-write rule: a bound row still missing its block height gets it
  // from the lws tx (never from the callback). The finalizer computes maturity
  // from this height, so it must land before the credit pass.
  if (tip.height == null && tx.height != null) {
    await models.observedTip.updateMany({
      where: { id: tip.id, state: 'DETECTED', height: null },
      data: { height: tx.height }
    })
  }
  return { action: 'clean' }
}
