// Webhook receipt integrity helpers (H3). Amounts arrive as untrusted strings
// from the lws callback. A missing/garbage/zero/negative amount must never be
// recorded or credited.
import { lookupTipTxMeta } from '@/api/monero/selfTip'
import { alert } from '@/lib/alert'
import { decryptViewKey } from './viewkey'
import { parseTxExtra, paymentIdCandidates, isOutputOwned } from './pidDecrypt'
import { publicSpendKeyFromAddress } from './viewKeyCheck'

export function parsePiconeros (amount) {
  if (amount === null || amount === undefined || amount === '') return null
  let value
  try {
    value = BigInt(amount)
  } catch {
    return null
  }
  if (value <= 0n) return null
  return value
}

export class ReceiptLookupError extends Error {}

// Cross-check a callback against the chain before any state change or credit.
// `lookupTipTxMeta` is account-generic despite the name: it fetches the tx for
// a payment id via the account's lws view key (incremental cursor + full-scan
// fallback). Fail closed for any scannable account:
//   - transient lws failure -> ReceiptLookupError (caller returns non-200 so
//     lws retries; reconcilePendingTips/confirmFinalizer are the backstops)
//   - missing/mismatched tx -> { ok: false } (caller records no credit)
// HASH-FIRST (review finding 1): the callback txHash is BOUND to the chain tx
// by the lookup itself — a tx selected by pid alone is never evidence for a
// named hash, so a fabricated/mismatched hash rejects with tx_not_found (and
// a deduped collision WARN when a same-pid tx coexists) instead of binding the
// pid tx. Without this binding, a token-holding attacker could replay one real
// payment with fabricated txHash values and inflate (txHash, paymentId)-keyed
// receipts. `tx` lets the tip branch reuse the tx it already fetched for the
// self-send check (one lws call per callback); a prefetched tx whose hash
// disagrees with the callback's is discarded the same way.
// On success returns { ok: true, level: 'lws', tx, chainHeight }.
// PID BINDING (2026-09-19 review finding): the hash-first lookup binds the
// claimed tx HASH, but the claimed PAYMENT ID must also be bound to that tx —
// otherwise a token-holding replay can re-attribute a real payment to a
// different pending pid on the same account (duplicate tip credits, bounty
// escrow over-commitment, wrong fee-leg flips). lws's reported pid is the fast
// path; when it differs or is absent, `corroborateClaimedPid` recomputes the
// pid from the raw tx extra with the RECIPIENT's view key — lws shares one pid
// across accounts in a scan pass and can serve the SENDER-side decryption for
// genuine payments (pidDecrypt.js:4-24), so a hard equality check would
// false-reject those. A daemon failure while corroborating DEFERS (503) rather
// than rejecting a genuine payment.
// SELF-SEND AMOUNTS are NOT handled here: when the payer shares the owner
// account, lws reports change-inflated totals AND fires callbacks for the
// change output itself, so the amount is unverifiable at every level. Fee
// branches apply a self-send guard (webhook.js) that refuses to credit such
// txs; verification stays amount-strict for every other caller.
// DAEMON FALLBACK (Task 9): when lws cannot see the named hash, monerod
// (restricted RPC) is consulted for the raw tx. On v1.0.4 a mempool lws hit
// usually satisfies the lookup directly (amount proof, height still null —
// amount proof is NOT mining); the fallback remains for genuine misses, where
// lws's pid attribution is absent on that path. Acceptance requires BOTH
// cryptographic proofs against the account's real keys: (a) the encrypted pid
// decrypts to the claimed payment id under the account view key, and (b) an
// on-chain output is provably owned by the account
// (P = Hs(8·a·R ‖ varint(i))·G + B). Verdict: { ok: true,
// level: 'daemon', tx: { hash, height: null } } — a fallback tx is unconfirmed
// at best, so there is no height to report. Rejections: 'pid_mismatch',
// 'ownership_mismatch', and 'tx_not_found' (daemon unreachable, hash miss, or
// an undecryptable view-key envelope all fail closed identically). Callers that
// only need pid corroboration (credit paths) pass `daemonFallback: false` so a
// discarded provisional verdict never spends the RPC.
// Unscannable accounts (no view key / INACTIVE) return { ok: true, skipped },
// preserving the repo's documented fail-open posture for the one edge where the
// chain cannot be consulted at all (same as the self-send check).
async function corroborateClaimedPid ({ daemon, account, paymentId, tx }) {
  const claimed = String(paymentId).toLowerCase()
  const reported = tx.payment_id != null ? String(tx.payment_id).toLowerCase() : null
  if (reported === claimed) return true
  if (!daemon) return false
  let raws
  try {
    raws = await daemon.getTransactions([tx.hash])
  } catch (err) {
    // Transient daemon failure: DEFER (the caller 503s and lws retries) rather
    // than rejecting a possibly-genuine misattributed payment.
    throw new ReceiptLookupError(`pid corroboration failed for ${tx.hash}: ${err?.message || err}`)
  }
  const raw = (raws || []).find((r) => String(r.hash).toLowerCase() === String(tx.hash).toLowerCase())
  // lws found the tx by hash, so a monerod miss is definitive: the claim is not
  // bound to this tx. Reject (no defer — retrying cannot change it).
  if (!raw) return false
  let viewKeyHex
  try {
    viewKeyHex = decryptViewKey(account.viewKey)
  } catch {
    return false
  }
  const candidates = paymentIdCandidates(raw.extra, viewKeyHex)
  return candidates.includes(claimed)
}

export async function verifyReceiptAmount ({ models, monero, daemon = null, daemonFallback = true, account, paymentId, piconeros, txHash, tx = null }) {
  if (!account?.viewKey || account.status !== 'ACTIVE') {
    return { ok: true, skipped: true }
  }
  let verified = tx
  if (verified && txHash != null && String(verified.hash).toLowerCase() !== String(txHash).toLowerCase()) {
    verified = null
  }
  let chainHeight = null
  let collision = false
  if (!verified) {
    try {
      const meta = await lookupTipTxMeta(models, monero, account, paymentId, { txHash })
      verified = meta.tx
      chainHeight = meta.blockchainHeight
      collision = meta.collision
    } catch (err) {
      throw new ReceiptLookupError(`lws receipt lookup failed for ${paymentId}: ${err?.message || err}`)
    }
  }
  if (verified) {
    if (!verified.hash) return { ok: false, reason: 'hash_unavailable' }
    const pidBound = await corroborateClaimedPid({ daemon, account, paymentId, tx: verified })
    if (!pidBound) return { ok: false, reason: 'pid_mismatch' }
    if (BigInt(verified.piconeros ?? 0) !== BigInt(piconeros)) {
      return { ok: false, reason: 'amount_mismatch', onChain: BigInt(verified.piconeros ?? 0) }
    }
    return { ok: true, level: 'lws', tx: verified, chainHeight }
  }
  if (collision) {
    alert('warn', 'payment-id collision on receipt verification',
      `${paymentId}: named tx hash not found while a different same-pid tx exists on the account — possible dust collision or lws misattribution`,
      { dedupeKey: `pid-collision-${paymentId}` })
  }
  if (daemonFallback && daemon && txHash) {
    let raws
    try {
      raws = await daemon.getTransactions([txHash])
    } catch {
      return { ok: false, reason: 'tx_not_found' }
    }
    const raw = raws.find((r) => String(r.hash).toLowerCase() === String(txHash).toLowerCase())
    if (!raw) return { ok: false, reason: 'tx_not_found' }
    let viewKeyHex
    try {
      viewKeyHex = decryptViewKey(account.viewKey)
    } catch {
      return { ok: false, reason: 'tx_not_found' }
    }
    const candidates = paymentIdCandidates(raw.extra, viewKeyHex)
    if (!candidates.includes(String(paymentId).toLowerCase())) {
      return { ok: false, reason: 'pid_mismatch' }
    }
    const spendKeyHex = publicSpendKeyFromAddress(account.address)
    const pubKeys = parseTxExtra(raw.extra).pubKeys
    if (!isOutputOwned({ voutKeys: raw.vout, txPubKeys: pubKeys, viewKeyHex, spendKeyHex })) {
      return { ok: false, reason: 'ownership_mismatch' }
    }
    return { ok: true, level: 'daemon', tx: { hash: raw.hash, height: null } }
  }
  return { ok: false, reason: 'tx_not_found' }
}
