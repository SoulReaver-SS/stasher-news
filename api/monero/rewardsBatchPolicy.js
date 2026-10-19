// Deterministic batching policy for the rewards hot wallet (rewards payout
// size recovery, Task 1). Pure helpers: no Prisma client and no wallet is
// created here, so importing this module is inert and the policy is testable
// in isolation. Every payout row stays whole; this module only orders and
// splits rows, and recognizes the signer's exact transaction-size rejection.
export const MAX_PAYOUTS_PER_TX = 15

const byPriority = (a, b) => a.piconeros > b.piconeros ? -1 : a.piconeros < b.piconeros ? 1 : a.id - b.id

export function chunkPayouts (rows) {
  const ordered = [...rows].sort(byPriority)
  const chunks = []
  for (let i = 0; i < ordered.length; i += MAX_PAYOUTS_PER_TX) {
    chunks.push(ordered.slice(i, i + MAX_PAYOUTS_PER_TX))
  }
  return chunks
}

export function bisectPayouts (rows) {
  if (rows.length < 2) throw new RangeError('cannot bisect a singleton payout')
  const middle = Math.ceil(rows.length / 2)
  return [rows.slice(0, middle), rows.slice(middle)]
}

// Fixed allowlist for the signer's recognized "too large" rejection. Matching
// is confined to this exact wording so unrelated failures are not retried as
// size errors. The matched message is never emitted.
export function isTransactionSizeError (err) {
  try {
    const message = typeof err === 'string' ? err : err?.message
    return typeof message === 'string' &&
      /^transaction would be too large\. try create_txs\(\)$/.test(message.trim().replace(/\s+/g, ' ').toLowerCase())
  } catch {
    return false
  }
}

// Durable recovery budget for ONE fragmented distribution/source-account pair.
// `rows` are the scoped CONSOLIDATION journal rows for that source account
// (network + wallet, any distribution). A PREPARED row is a reserved or
// attempted cycle that must resolve before any new sweep, regardless of which
// distribution it belongs to. Any durable row for this exact pair means the
// bounded retry was already spent — PREPARED (also caught above) or RELAYED.
export function sizeRecoveryDecision (rows, { distributionId, accountIndex }) {
  const source = rows.filter(row => row.accountIndex === accountIndex)
  if (source.some(row => row.state === 'PREPARED')) return 'blocked'
  if (source.some(row => row.distributionId === distributionId)) return 'exhausted'
  return 'eligible'
}
