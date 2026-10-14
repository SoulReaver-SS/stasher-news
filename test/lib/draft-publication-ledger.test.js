/* eslint-env jest */
// lib/draft-publication-ledger.js — client-side ledger for fee-gated draft
// publications. The server-side draft deletion for a fee-gated publish runs
// ONLY from the posting-fee modal's onPaid (components/posting-fee-modal.js):
// if the modal/tab closes before Item.feeStatus flips PENDING_FEE -> FEE_PAID
// (~1 block), the draft orphans until the 90-day TTL sweep. The ledger records
// { draftId, itemId, at } at fee-gated submit so any later MY_DRAFTS load can
// resolve the outcome: FEE_PAID -> delete the draft; item soft-deleted /
// abandoned (query returns null) -> keep the draft, drop the entry; still
// PENDING_FEE -> retry next load until a max age past abandonFeeItems'
// 1-day abandonment cutoff.
import {
  DRAFT_PUBLICATION_LEDGER_CAP,
  DRAFT_PUBLICATION_LEDGER_KEY,
  DRAFT_PUBLICATION_MAX_AGE_MS,
  recordDraftPublication,
  clearDraftPublication,
  readDraftPublications,
  resolveDraftPublications,
  writeDraftPublications
} from '@/lib/draft-publication-ledger'
import { FEE_ITEM_ABANDON_DAYS } from '@/lib/constants'

// in-memory localStorage stand-in: ledger code must only ever rely on
// getItem/setItem (SSR-safe guards live in the components, not here)
const makeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v))
  }
}

const HOUR = 60 * 60 * 1000

describe('recordDraftPublication', () => {
  test('appends a draftId/itemId/at entry', () => {
    const storage = makeStorage()
    recordDraftPublication(storage, { draftId: '7', itemId: '42', now: 1000 })
    expect(readDraftPublications(storage)).toEqual([
      { draftId: '7', itemId: '42', at: 1000 }
    ])
  })

  test('re-recording the same draft replaces its entry (no duplicates)', () => {
    const storage = makeStorage()
    recordDraftPublication(storage, { draftId: '7', itemId: '42', now: 1000 })
    recordDraftPublication(storage, { draftId: '7', itemId: '43', now: 2000 })
    expect(readDraftPublications(storage)).toEqual([
      { draftId: '7', itemId: '43', at: 2000 }
    ])
  })

  test('keeps only the most recent entries at the cap', () => {
    const storage = makeStorage()
    for (let i = 0; i < DRAFT_PUBLICATION_LEDGER_CAP + 5; i++) {
      recordDraftPublication(storage, { draftId: String(i), itemId: String(i), now: i })
    }
    const entries = readDraftPublications(storage)
    expect(entries).toHaveLength(DRAFT_PUBLICATION_LEDGER_CAP)
    // oldest five dropped, newest kept in order
    expect(entries[0].draftId).toBe('5')
    expect(entries[entries.length - 1].draftId).toBe(String(DRAFT_PUBLICATION_LEDGER_CAP + 4))
  })

  test('tolerates corrupt stored JSON (returns empty, overwriteable)', () => {
    const storage = makeStorage({ [DRAFT_PUBLICATION_LEDGER_KEY]: '{not json' })
    expect(readDraftPublications(storage)).toEqual([])
    recordDraftPublication(storage, { draftId: '1', itemId: '2', now: 3 })
    expect(readDraftPublications(storage)).toEqual([{ draftId: '1', itemId: '2', at: 3 }])
  })
})

describe('clearDraftPublication', () => {
  test('removes the entry for a draft and leaves others', () => {
    const storage = makeStorage()
    recordDraftPublication(storage, { draftId: '7', itemId: '42', now: 1 })
    recordDraftPublication(storage, { draftId: '8', itemId: '43', now: 2 })
    clearDraftPublication(storage, '7')
    expect(readDraftPublications(storage)).toEqual([
      { draftId: '8', itemId: '43', at: 2 }
    ])
  })

  test('is a no-op for an unknown draft', () => {
    const storage = makeStorage()
    recordDraftPublication(storage, { draftId: '7', itemId: '42', now: 1 })
    clearDraftPublication(storage, '999')
    expect(readDraftPublications(storage)).toHaveLength(1)
  })
})

describe('writeDraftPublications', () => {
  test('persists a sweep resolution', () => {
    const storage = makeStorage()
    writeDraftPublications(storage, [{ draftId: '2', itemId: '12', at: 5 }])
    expect(readDraftPublications(storage)).toEqual([{ draftId: '2', itemId: '12', at: 5 }])
  })

  test('a throwing setItem (storage full / private mode) is never fatal', () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }
    expect(() => writeDraftPublications(storage, [])).not.toThrow()
    expect(() => recordDraftPublication(storage, { draftId: '7', itemId: '42', now: 1 })).not.toThrow()
  })

  test('retry window exceeds the 1-day abandonment cutoff (lib/constants FEE_ITEM_ABANDON_DAYS)', () => {
    // the whole give-up design assumes the item is already abandoned (draft
    // kept, entry dropped) by the time the window closes — see the module
    // comment on DRAFT_PUBLICATION_MAX_AGE_MS
    expect(DRAFT_PUBLICATION_MAX_AGE_MS).toBeGreaterThan(FEE_ITEM_ABANDON_DAYS * 24 * 60 * 60 * 1000)
  })
})

describe('resolveDraftPublications', () => {
  const entry = over => ({ draftId: '7', itemId: '42', at: 0, ...over })

  test('FEE_PAID item -> delete the draft, drop the entry', () => {
    const out = resolveDraftPublications([entry()], {
      draftIds: new Set(['7']),
      itemStatusById: { 42: 'FEE_PAID' },
      now: HOUR
    })
    expect(out.deleteDraftIds).toEqual(['7'])
    expect(out.remainingEntries).toEqual([])
  })

  test('any non-PENDING_FEE status counts as live (delete)', () => {
    const out = resolveDraftPublications([entry()], {
      draftIds: new Set(['7']),
      itemStatusById: { 42: 'FEE_NOT_REQUIRED' },
      now: HOUR
    })
    expect(out.deleteDraftIds).toEqual(['7'])
  })

  test('item gone (null: author-deleted or abandoned) -> keep draft, drop entry', () => {
    const out = resolveDraftPublications([entry()], {
      draftIds: new Set(['7']),
      itemStatusById: { 42: null },
      now: HOUR
    })
    expect(out.deleteDraftIds).toEqual([])
    expect(out.remainingEntries).toEqual([])
  })

  test('still PENDING_FEE within max age -> keep draft and entry (retry later)', () => {
    const out = resolveDraftPublications([entry()], {
      draftIds: new Set(['7']),
      itemStatusById: { 42: 'PENDING_FEE' },
      now: HOUR
    })
    expect(out.deleteDraftIds).toEqual([])
    expect(out.remainingEntries).toEqual([entry()])
  })

  test('PENDING_FEE past max age -> give up (keep draft, drop entry)', () => {
    const out = resolveDraftPublications([entry()], {
      draftIds: new Set(['7']),
      itemStatusById: { 42: 'PENDING_FEE' },
      now: DRAFT_PUBLICATION_MAX_AGE_MS + 1
    })
    expect(out.deleteDraftIds).toEqual([])
    expect(out.remainingEntries).toEqual([])
  })

  test('max age boundary: exactly at the limit gives up (age >= maxAge)', () => {
    const out = resolveDraftPublications([entry()], {
      draftIds: new Set(['7']),
      itemStatusById: { 42: 'PENDING_FEE' },
      now: DRAFT_PUBLICATION_MAX_AGE_MS
    })
    expect(out.deleteDraftIds).toEqual([])
    expect(out.remainingEntries).toEqual([])
  })

  test('unknown status (undefined: query failed) -> keep entry untouched', () => {
    const out = resolveDraftPublications([entry()], {
      draftIds: new Set(['7']),
      itemStatusById: {},
      now: DRAFT_PUBLICATION_MAX_AGE_MS * 10
    })
    expect(out.deleteDraftIds).toEqual([])
    expect(out.remainingEntries).toEqual([entry()])
  })

  test('draft already gone from myDrafts -> drop entry without a delete', () => {
    const out = resolveDraftPublications([entry()], {
      draftIds: new Set([]),
      itemStatusById: { 42: 'FEE_PAID' },
      now: HOUR
    })
    expect(out.deleteDraftIds).toEqual([])
    expect(out.remainingEntries).toEqual([])
  })

  test('resolves each entry independently', () => {
    const entries = [
      { draftId: '1', itemId: '11', at: 0 }, // published
      { draftId: '2', itemId: '12', at: 0 }, // pending
      { draftId: '3', itemId: '13', at: 0 }, // gone
      { draftId: '4', itemId: '14', at: 0 } // draft deleted elsewhere
    ]
    const out = resolveDraftPublications(entries, {
      draftIds: new Set(['1', '2', '3']),
      itemStatusById: { 11: 'FEE_PAID', 12: 'PENDING_FEE', 13: null, 14: 'FEE_PAID' },
      now: HOUR
    })
    expect(out.deleteDraftIds).toEqual(['1'])
    expect(out.remainingEntries).toEqual([{ draftId: '2', itemId: '12', at: 0 }])
  })

  test('string/number id forms match across entry and myDrafts data', () => {
    const out = resolveDraftPublications([entry({ draftId: 7, itemId: 42 })], {
      draftIds: new Set(['7']),
      itemStatusById: { 42: 'FEE_PAID' },
      now: HOUR
    })
    expect(out.deleteDraftIds).toEqual([7])
  })
})
