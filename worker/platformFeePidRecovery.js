import { applyFeeReceipt } from '@/api/monero/feeObservation'
import { isSelfSend } from '@/api/monero/selfTip'
import { decryptViewKey } from '@/api/monero/viewkey'
import { createReconciliationCheckpoint, scanRawPaymentIds } from '@/worker/reconciliationScan'
import { alert } from '@/lib/alert'

// Raw-payment-id recovery for integrated PLATFORM fee receipts, run by
// rewardsWalletObserver every minute over the full rewards-wallet history it
// already fetches (no extra lws call).
//
// Why: monero-lws decrypts an encrypted payment id ONCE per transaction and
// stores those bytes on every registered account the tx touches. When the
// payer's wallet is also lws-registered and is decrypted first, the rewards
// wallet's row carries the payer-side bytes (random), so the served-pid
// branch (attributeIntegratedFee) never matches the fee. Here we re-derive
// the pid from the tx's raw extra with the REWARDS view key
// (api/monero/pidDecrypt.js) — cryptographic proof of addressing — and book
// the receipt through the shared applier. Raw evidence proves identity only:
// the amount and mined height still come from the rewards account's own lws
// row. Not window-bound: a late wrong-pid payment is still recovered.
//
// Cost control:
//   - candidates are MINED primary-address (0,0) rows only (an integrated
//     address always pays the primary; gates only open on mined receipts);
//   - hashes already booked at (0,0) (FeeObservation, ObservedDownvote) are
//     skipped, and every settled decision is memoized process-locally, so a
//     steady-state tick only examines NEW unbooked primary rows;
//   - raw extras come through the shared bounded reader/cache that the
//     reconcilers use (one daemon fetch per hash per process lifetime).
// A memoized "no fee pid" decision is sound: an intent row always exists
// before its invoice is shown (createFeeLeg), so a pid that names no intent
// when its tx is mined never will.

const MEMO_LIMIT = 100_000
const settledHashes = new Set()

function settle (hash) {
  if (settledHashes.size >= MEMO_LIMIT) settledHashes.clear() // recompute once
  settledHashes.add(hash)
}

// test seam: a fresh process starts with an empty memo
export function __resetPlatformFeePidRecoveryForTests () {
  settledHashes.clear()
}

const HASH_QUERY_CHUNK = 1000

async function bookedHashes (models, hashes) {
  const booked = new Set()
  for (let i = 0; i < hashes.length; i += HASH_QUERY_CHUNK) {
    const chunk = hashes.slice(i, i + HASH_QUERY_CHUNK)
    const [fees, downvotes] = await Promise.all([
      models.feeObservation.findMany({ where: { txHash: { in: chunk }, recipientMajor: 0, recipientMinor: 0 }, select: { txHash: true } }),
      models.observedDownvote.findMany({ where: { txHash: { in: chunk } }, select: { txHash: true } })
    ])
    for (const r of [...fees, ...downvotes]) booked.add(String(r.txHash).toLowerCase())
  }
  return booked
}

export async function recoverPlatformFeePids ({ models, account, transactions, rawReader, checkpoint = createReconciliationCheckpoint() }) {
  if (!account?.viewKey || !rawReader) return { candidates: 0, recovered: 0 }

  const rowsByHash = new Map()
  for (const tx of transactions || []) {
    if (!tx.hash || tx.height == null) continue
    if ((tx.recipient?.maj_i ?? 0) !== 0 || (tx.recipient?.min_i ?? 0) !== 0) continue
    const hash = String(tx.hash).toLowerCase()
    if (settledHashes.has(hash) || rowsByHash.has(hash)) continue
    rowsByHash.set(hash, { ...tx, hash })
  }
  if (rowsByHash.size === 0) return { candidates: 0, recovered: 0 }

  const booked = await bookedHashes(models, [...rowsByHash.keys()])
  for (const hash of booked) {
    rowsByHash.delete(hash)
    settle(hash)
  }
  if (rowsByHash.size === 0) return { candidates: 0, recovered: 0 }

  // Acquisition/decryption only — no money effects — so a daemon or
  // view-key failure defers the whole pass (next tick retries) without a
  // partial write. Never a nonpayment verdict.
  const { raws, missingHashes } = await rawReader.read([...rowsByHash.keys()])
  const viewKeyHex = decryptViewKey(account.viewKey)
  const pidsByHash = new Map()
  for await (const { raw, pids } of scanRawPaymentIds(raws, viewKeyHex, checkpoint)) {
    const hash = String(raw.hash ?? '').toLowerCase()
    if (rowsByHash.has(hash) && !pidsByHash.has(hash)) pidsByHash.set(hash, [...new Set(pids)])
  }
  if (missingHashes.length > 0) {
    alert('warn', 'platform fee raw transaction evidence incomplete',
      `rewards account ${account.id}: ${missingHashes.length} of ${rowsByHash.size} raw transactions unavailable; next tick retries`,
      { dedupeKey: `platform-fee-pid-recovery-incomplete-${account.id}` })
  }

  const allPids = [...new Set([...pidsByHash.values()].flat())]
  const intents = allPids.length
    ? await models.subFeePidMap.findMany({ where: { paymentId: { in: allPids }, feeType: { not: null } } })
    : []
  const intentByPid = new Map(intents.map(m => [m.paymentId, m]))

  let subaddresses = null
  let recovered = 0
  for (const [hash, pids] of pidsByHash) {
    const matches = pids.filter(pid => intentByPid.has(pid))
    if (matches.length !== 1) {
      if (matches.length > 1) {
        alert('warn', 'platform fee ambiguous raw payment id refused',
          `rewards account ${account.id}, tx ${hash}: multiple fee intents match; no receipt booked`,
          { dedupeKey: `platform-fee-pid-ambiguous-${hash}` })
      }
      settle(hash) // decoded, not (unambiguously) a platform fee
      continue
    }
    const feeMap = intentByPid.get(matches[0])
    const tx = rowsByHash.get(hash)
    if (feeMap.recipientAccountId !== account.id || feeMap.recipientAddress !== account.address) {
      alert('critical', 'integrated fee pid seen on a non-recipient account',
        `fee intent ${feeMap.id} (recipient account ${feeMap.recipientAccountId}) raw-matched tx ${hash} on account ${account.id}; not credited`,
        { dedupeKey: `fee-wrong-account-${feeMap.id}-${hash}` })
      settle(hash)
      continue
    }
    subaddresses ??= await models.subaddressIndex.findMany({ where: { accountId: account.id }, select: { majorIndex: true, minorIndex: true } })
    if (isSelfSend({ ...account, subaddresses }, tx)) {
      alert('warn', 'platform fee self-payment refused',
        `fee intent ${feeMap.id} tx ${hash}: payer shares the rewards account (change-inflated); no receipt booked`,
        { dedupeKey: `fee-selfpay-${feeMap.id}-${hash}` })
      settle(hash)
      continue
    }
    const feePayIn = await models.payIn.findUnique({ where: { moneroPaymentId: feeMap.paymentId } })
    const result = await applyFeeReceipt(models, {
      feeMap,
      feePayIn,
      txHash: tx.hash,
      piconeros: tx.piconeros,
      height: tx.height,
      confirmations: 0 // never fabricated — confirmFinalizer matures height-bearing rows
    })
    settle(hash)
    if (result?.transitioned) recovered += 1
  }
  if (recovered > 0) {
    alert('warn', 'platform fee payment-id misattribution recovered',
      `rewards account ${account.id}: ${recovered} platform fee receipt(s) booked by raw payment-id recovery`,
      { dedupeKey: `platform-fee-pid-misattribution-${account.id}` })
  }
  return { candidates: rowsByHash.size, recovered }
}
