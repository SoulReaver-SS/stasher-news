// lib/draft-publication-ledger.js — client-side ledger for fee-gated draft
// publications (localStorage, per browser).
//
// Why: a fee-gated publish creates the item PENDING_FEE and deletes its
// server-side draft only from the posting-fee modal's onPaid — i.e. only if
// the modal is still mounted when the fee is observed (~1 block later). The
// modal's own copy tells the user to close it right after sending, so the
// draft regularly orphans until the 90-day TTL sweep (2026-10-14 draft-post
// bug: jerry's drafts 252/256). There is no Draft->Item linkage server-side,
// so the recovery is client-side: at fee-gated submit the client knows both
// ids, records { draftId, itemId, at } here, and any later MY_DRAFTS load
// (components/drafts-menu.js) resolves the entry:
//   - item FEE_PAID (post live)          -> delete the draft, drop the entry
//   - item null (deleted or abandoned)   -> keep the draft, drop the entry
//     (per the H2 rule the draft is the only durable copy of unpaid work;
//     abandonFeeItems soft-deletes unpaid PENDING_FEE items after 1 day and
//     the item query then returns null to the author)
//   - still PENDING_FEE within max age   -> keep the entry, retry next load
//   - query failed / unknown             -> keep the entry, retry next load
// Pure storage-injected helpers: components guard SSR and own the Apollo
// side (fetch, delete mutation); this module is trivially unit-testable.
export const DRAFT_PUBLICATION_LEDGER_KEY = 'pending-draft-publications'
// Retry window for still-PENDING_FEE entries: abandonFeeItems blanks unpaid
// items after 1 day (FEE_ITEM_ABANDON_DAYS); the margin covers sweep cadence
// (hourly) and a slow next visit. Exported so the boundary tests compute the
// cutoff against the real rule instead of a duplicated literal.
export const DRAFT_PUBLICATION_MAX_AGE_MS = 26 * 60 * 60 * 1000
// Bound growth; DRAFT_MAX_COUNT is 10, so 50 is generous headroom.
export const DRAFT_PUBLICATION_LEDGER_CAP = 50

const readEntries = (storage) => {
  try {
    const raw = storage.getItem(DRAFT_PUBLICATION_LEDGER_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeEntries = (storage, entries) => {
  try {
    storage.setItem(DRAFT_PUBLICATION_LEDGER_KEY, JSON.stringify(entries))
  } catch {
    // storage full/blocked: the ledger is best-effort recovery, never fatal
  }
}

// Record that draftId was submitted as a fee-gated item (itemId, PENDING_FEE).
// Re-recording a draft replaces its entry (a retry mints a NEW item).
export function recordDraftPublication (storage, { draftId, itemId, now = Date.now() }) {
  const next = [
    ...readEntries(storage).filter(e => String(e.draftId) !== String(draftId)),
    { draftId: String(draftId), itemId: String(itemId), at: now }
  ].slice(-DRAFT_PUBLICATION_LEDGER_CAP)
  writeEntries(storage, next)
}

// A guaranteed deletion happened through this module's callers (modal onPaid,
// free publish, the drafts-menu sweep). Manual ✕-delete and "discard draft"
// need no call: the sweep's absent-draft check drops their entries silently.
export function clearDraftPublication (storage, draftId) {
  writeEntries(storage, readEntries(storage).filter(e => String(e.draftId) !== String(draftId)))
}

export function readDraftPublications (storage) {
  return readEntries(storage)
}

// Persist a sweep's resolution (entries whose outcome is still pending).
export function writeDraftPublications (storage, entries) {
  writeEntries(storage, entries)
}

// Pure resolution pass.
//
// @param {Array<{draftId: string, itemId: string, at: number}>} entries
// @param {Object} ctx
// @param {Set<string>} ctx.draftIds - ids currently in MY_DRAFTS
// @param {Object} ctx.itemStatusById - itemId -> feeStatus string, null when
//   the item query resolved but the item is gone (deleted/abandoned), or
//   undefined when the query itself failed (unknown)
// @param {number} [ctx.now]
// @param {number} [ctx.maxAgeMs]
// @returns {{ deleteDraftIds: Array<string>, remainingEntries: Array }} the
//   drafts to DELETE_DRAFT (they are provably published) and the entries to
//   persist for the next sweep.
export function resolveDraftPublications (entries, { draftIds, itemStatusById, now = Date.now(), maxAgeMs = DRAFT_PUBLICATION_MAX_AGE_MS }) {
  const deleteDraftIds = []
  const remainingEntries = []
  for (const e of entries) {
    // the draft is already gone (deleted/discard/TTL) — nothing to do
    if (!draftIds.has(String(e.draftId))) continue
    const status = itemStatusById[String(e.itemId)] ?? itemStatusById[e.itemId]
    if (status === undefined) {
      // query failed — keep the entry, retry on a later load
      remainingEntries.push(e)
      continue
    }
    if (status === null) {
      // author-deleted or abandoned: the publish never went live, so the
      // draft stays (only durable copy); the entry has no future to wait for
      continue
    }
    if (status === 'PENDING_FEE') {
      if (now - e.at < maxAgeMs) remainingEntries.push(e) // still waiting
      continue // past max age: assume abandoned, give up (keep draft)
    }
    // any other feeStatus means the item is live — the draft is redundant
    deleteDraftIds.push(e.draftId)
  }
  return { deleteDraftIds, remainingEntries }
}
