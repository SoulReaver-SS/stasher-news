/* eslint-env jest */

// Contract tests for the portable lws cursor rules (spec §3,
// docs/superpowers/specs/2026-10-23-lws-v1-adoption-design.md).
//
// monero-lws v1.0.4 /get_address_txs serializes transaction `id` as the
// response-position index and appends mempool rows after mined rows. The
// durable lastTxId watermark must therefore be advanced by MINED rows only;
// pending rows stay eligible on every poll regardless of their ID.
//
// This module is the FCMP portability unit: two pure functions, no imports,
// no I/O, no mutation. Keep this test file dependency-free so the pair can
// be cherry-picked together.

import { freshLwsTransactions, nextLwsCursor } from '../../../api/monero/lwsCursor'

describe('blocker: pending positions cannot advance the watermark', () => {
  test('pending IDs never hide a later mined fee, even above the mined ID space', () => {
    const pending = [{ id: 10, height: null, mempool: true }, { id: 5000, height: null, mempool: true }]
    // An all-row max would advance to 5000n and suppress the id-10 mined fee.
    const next = nextLwsCursor(pending, 9n)
    expect(next).toBe(9n)
    const fee = { id: 10, height: 100, mempool: false }
    expect(freshLwsTransactions([fee], next)).toEqual([fee])
  })
})

describe('initialization', () => {
  test('mined zero initializes the cursor; pending-only does not', () => {
    const first = { id: 0, height: 0 }
    expect(freshLwsTransactions([first], null)).toEqual([first])
    expect(nextLwsCursor([first], null)).toBe(0n)
    expect(nextLwsCursor([{ id: 99, height: null }], null)).toBeNull()
  })

  test('a null cursor includes every usable mined row', () => {
    const rows = [{ id: 0, height: 5 }, { id: 7, height: 9 }, { id: 3, height: null }]
    expect(freshLwsTransactions(rows, null)).toEqual(rows)
    expect(nextLwsCursor(rows, null)).toBe(7n)
  })
})

describe('usable IDs are replayable, never durable progress', () => {
  test.each([undefined, '11', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'an unusable ID is replayable, not durable progress: %s', id => {
      const row = { id, height: 100 }
      expect(freshLwsTransactions([row], 10n)).toEqual([row])
      expect(nextLwsCursor([row], 10n)).toBe(10n)
    }
  )
})

describe('mining metadata validation', () => {
  test.each([
    { height: -1 }, { height: '100' }, { height: 1.5 },
    { height: Number.MAX_SAFE_INTEGER + 1 },
    { height: 100, mempool: true }, { height: null, mempool: 'true' }
  ])('invalid mining metadata rejects the whole input', row => {
    expect(() => freshLwsTransactions([row], null)).toThrow(TypeError)
    expect(() => nextLwsCursor([row], null)).toThrow(TypeError)
  })

  test('a mempool row with an omitted height stays eligible (old fixtures)', () => {
    const row = { id: 4, mempool: true }
    expect(freshLwsTransactions([row], 3n)).toEqual([row])
    expect(nextLwsCursor([row], 3n)).toBe(3n)
  })

  test('rows missing the mempool marker default to mined when height is present', () => {
    const row = { id: 5, height: 50 }
    expect(freshLwsTransactions([row], 4n)).toEqual([row])
    expect(nextLwsCursor([row], 4n)).toBe(5n)
  })

  test.each([
    null, undefined, 'rows', 42, [[]]
  ])('malformed row objects reject the input: %p', row => {
    expect(() => freshLwsTransactions([row], null)).toThrow(TypeError)
    expect(() => nextLwsCursor([row], null)).toThrow(TypeError)
  })
})

describe('cursor argument validation', () => {
  test.each([undefined, 9, '9', -1n, 1.5])('invalid cursor input rejects: %p', cursor => {
    expect(() => freshLwsTransactions([], cursor)).toThrow(TypeError)
    expect(() => nextLwsCursor([], cursor)).toThrow(TypeError)
  })

  test('only null and nonnegative BigInt cursors are accepted', () => {
    expect(nextLwsCursor([], null)).toBeNull()
    expect(nextLwsCursor([], 0n)).toBe(0n)
  })

  test('a huge previous cursor survives exactly without Number rounding', () => {
    const huge = 9007199254740993n // 2^53+1: Number(huge) would round down to 2^53
    const lower = { id: 12, height: 300 }
    // Mined below a huge cursor is NOT fresh — and the comparison must be
    // exact BigInt, not Number (where huge would round to 9007199254740992).
    expect(freshLwsTransactions([lower], huge)).toEqual([])
    expect(nextLwsCursor([lower], huge)).toBe(huge)
    // ID equal to Number-rounding of the cursor boundary stays below it.
    expect(nextLwsCursor([{ id: Number(huge), height: 301 }], huge)).toBe(huge)
  })
})

describe('slice and cursor behavior', () => {
  test('an empty response preserves the cursor and yields an empty slice', () => {
    expect(freshLwsTransactions([], 11n)).toEqual([])
    expect(nextLwsCursor([], 11n)).toBe(11n)
  })

  test('pending rows behind and ahead of the cursor both stay fresh', () => {
    const pending = [{ id: 1, height: null }, { id: 99, height: null, mempool: true }]
    expect(freshLwsTransactions(pending, 50n)).toEqual(pending)
  })

  test('mixed rows slice by the mined rule while cursor counts mined only', () => {
    const rows = [
      { id: 10, height: 100 }, // at cursor -> not fresh
      { id: 11, height: 101 }, // above cursor -> fresh
      { id: 12, height: null, mempool: true }, // pending -> fresh
      { id: 13, height: 102 }, // above cursor -> fresh
      { id: 9, height: 99 } // below cursor -> not fresh
    ]
    expect(freshLwsTransactions(rows, 10n)).toEqual([rows[1], rows[2], rows[3]])
    expect(nextLwsCursor(rows, 10n)).toBe(13n)
  })

  test('reordering and eviction of pending rows never regresses the cursor', () => {
    const first = [{ id: 20, height: null, mempool: true }, { id: 12, height: 100 }]
    expect(nextLwsCursor(first, 11n)).toBe(12n)
    const reordered = [{ id: 12, height: 100 }] // pending row evicted, order flipped
    expect(nextLwsCursor(reordered, 12n)).toBe(12n)
  })

  test('a mined row with an ID behind the cursor is not fresh and never regresses it', () => {
    const pending = { id: 10, height: null, mempool: true }
    expect(freshLwsTransactions([pending], 12n)).toEqual([pending])
    const mined = { ...pending, height: 300, mempool: false }
    expect(freshLwsTransactions([mined], 12n)).toEqual([])
    expect(nextLwsCursor([mined], 12n)).toBe(12n)
  })

  test('shortened/stale history never auto-clamps the cursor', () => {
    expect(nextLwsCursor([{ id: 3, height: 9 }], 900n)).toBe(900n)
    expect(nextLwsCursor([{ id: 901, height: 9 }], 900n)).toBe(901n)
  })
})

describe('purity', () => {
  test('inputs are not mutated; order and row identity are preserved', () => {
    const rows = Object.freeze([
      Object.freeze({ id: 2, height: null, mempool: true }),
      Object.freeze({ id: 1, height: 50 })
    ])
    const fresh = freshLwsTransactions(rows, 0n)
    expect(fresh).toEqual([rows[0], rows[1]])
    expect(fresh[0]).toBe(rows[0])
    expect(nextLwsCursor(rows, 0n)).toBe(1n)
    expect(rows).toEqual([{ id: 2, height: null, mempool: true }, { id: 1, height: 50 }])
  })
})
