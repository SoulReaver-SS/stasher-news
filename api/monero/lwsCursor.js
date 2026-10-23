// Cursor rules for monero-lws /get_address_txs responses (spec
// docs/superpowers/specs/2026-10-23-lws-v1-adoption-design.md §3).
//
// lws v1.0.4 IDs are response positions and mempool rows follow mined rows, so
// advancing a durable watermark from pending rows suppresses later mined
// receipts. Only mined rows with usable IDs may advance; pending rows stay
// eligible on every poll. Pure functions, no I/O or mutation: the returned
// cursor is a proposal, not authorization to write it. (FCMP portability unit.)

function validate (transactions, cursor) {
  if (!Array.isArray(transactions) ||
      (cursor !== null && (typeof cursor !== 'bigint' || cursor < 0n))) {
    throw new TypeError('Invalid lws cursor input')
  }
  for (const tx of transactions) {
    if (!tx || typeof tx !== 'object' || Array.isArray(tx) ||
        (tx.mempool !== undefined && typeof tx.mempool !== 'boolean') ||
        (tx.height != null && (!Number.isSafeInteger(tx.height) || tx.height < 0)) ||
        (tx.mempool === true && tx.height != null)) {
      throw new TypeError('Invalid lws transaction metadata')
    }
  }
}

// A usable ID is a safe nonnegative integer. Fractions, strings, negatives and
// unsafe magnitudes are never coerced into durable progress; such rows stay
// replayable instead.
function usableId (tx) {
  return Number.isSafeInteger(tx.id) && tx.id >= 0
}

// Rows to process this poll: pending rows (any ID), rows without a usable ID,
// everything when the cursor is uninitialized, and mined rows strictly above
// the previous cursor. Input order and row identity are preserved.
export function freshLwsTransactions (transactions, previousCursor) {
  validate(transactions, previousCursor)
  return transactions.filter(tx => tx.height == null || !usableId(tx) ||
    previousCursor === null || BigInt(tx.id) > previousCursor)
}

// Candidate next watermark: the maximum of the previous cursor and usable IDs
// from mined rows only. null when neither exists. Empty/pending-only responses
// preserve the previous cursor; shortened history never clamps it.
export function nextLwsCursor (transactions, previousCursor) {
  validate(transactions, previousCursor)
  let next = previousCursor
  for (const tx of transactions) {
    if (tx.height != null && usableId(tx)) {
      const id = BigInt(tx.id)
      if (next === null || id > next) next = id
    }
  }
  return next
}
