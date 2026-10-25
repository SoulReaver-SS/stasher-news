/* eslint-env jest */

// Unit tests for worker/reconciliationRawTransactions (Finding 1).
//
// The reader is a bounded, process-local memory of `{ hash, extra }` evidence
// shared by the two reconciliation workers. These tests inject a daemon double
// and never touch the network or real timers:
//   - `sleep: async () => {}` so deadline retries never wait
//   - `random: () => 0` for a deterministic retry delay (500 + jitter)
//   - `now` is injected wherever the 90 s acquisition budget is exercised
//
// Run via the app container:
//   docker exec -w /app -u apprunner app npm run test -- test/worker/reconciliationRawTransactions.test.js

import { createReconciliationRawReader, getReconciliationRawReader } from '@/worker/reconciliationRawTransactions'

const hash = n => n.toString(16).padStart(64, '0')
const raw = h => ({ hash: h, extra: Buffer.from([0]) })
const rawBytes = (h, bytes) => ({ hash: h, extra: Buffer.from(bytes) })

const stubSleep = () => jest.fn(async () => {})

test('warm raw-cache reads yield without losing cached evidence', async () => {
  const hashes = [hash(1), hash(2)]
  const daemon = makeDaemon(async batch => batch.map(raw))
  const reader = createReconciliationRawReader({ daemon })
  await reader.read(hashes)
  let heartbeat = false
  setImmediate(() => { heartbeat = true })
  const checkpoint = () => new Promise(resolve => setImmediate(resolve))
  const out = await reader.read(hashes, checkpoint)
  expect(heartbeat).toBe(true)
  expect(out.raws.map(r => r.hash)).toEqual(hashes)
  expect(out.stats.cached).toBe(2)
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
})

function makeDaemon (responder) {
  return { getTransactions: jest.fn(responder) }
}

// ---- per-batch progress ----------------------------------------------------

test('a later failed batch does not discard the first batch', async () => {
  const hashes = Array.from({ length: 51 }, (_, n) => hash(n + 1))
  let fail = true
  const daemon = makeDaemon(async batch => {
    if (fail && batch.includes(hashes[50])) {
      throw Object.assign(new Error('deadline'), { code: 'DAEMON_TIMEOUT' })
    }
    return batch.map(raw)
  })
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  await expect(reader.read(hashes)).rejects.toMatchObject({ code: 'DAEMON_TIMEOUT' })

  fail = false
  daemon.getTransactions.mockClear()
  const result = await reader.read(hashes)

  expect(result.missingHashes).toEqual([])
  expect(result.raws).toHaveLength(51)
  expect(result.raws.map(r => r.hash)).toEqual(hashes)
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
  expect(daemon.getTransactions).toHaveBeenCalledWith([hashes[50]])
  expect(result.stats).toEqual({ requested: 51, cached: 50, fetched: 1, batches: 1, retries: 0 })
})

test.each([
  ['empty response', []],
  ['partial response', [raw(hash(1))]]
])('%s is not negative-cached', async (label, firstResponse) => {
  const daemon = {
    getTransactions: jest.fn()
      .mockResolvedValueOnce(firstResponse)
      .mockImplementation(async batch => batch.map(raw))
  }
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {} })

  const first = await reader.read([hash(1), hash(2)])
  expect(first.missingHashes).toContain(hash(2))

  const second = await reader.read([hash(1), hash(2)])
  expect(second.missingHashes).toEqual([])
  // The hash without usable evidence was fetched again, never negative-cached.
  expect(daemon.getTransactions).toHaveBeenCalledTimes(2)
})

test('101 hashes are fetched in [50, 50, 1] batches', async () => {
  const hashes = Array.from({ length: 101 }, (_, n) => hash(n + 1))
  const daemon = makeDaemon(async batch => batch.map(raw))
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  const out = await reader.read(hashes)

  expect(daemon.getTransactions.mock.calls.map(([batch]) => batch.length)).toEqual([50, 50, 1])
  expect(out.raws.map(r => r.hash)).toEqual(hashes)
  expect(out.missingHashes).toEqual([])
  expect(out.stats).toEqual({ requested: 101, cached: 0, fetched: 101, batches: 3, retries: 0 })
})

test('a repeated all-hit read makes no RPC', async () => {
  const daemon = makeDaemon(async batch => batch.map(raw))
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  await reader.read([hash(1), hash(2)])
  daemon.getTransactions.mockClear()

  const second = await reader.read([hash(2), hash(1)])
  expect(daemon.getTransactions).not.toHaveBeenCalled()
  expect(second.raws.map(r => r.hash)).toEqual([hash(2), hash(1)])
  expect(second.stats).toEqual({ requested: 2, cached: 2, fetched: 0, batches: 0, retries: 0 })
})

test('a growing history fetches only the new hashes', async () => {
  const firstHistory = Array.from({ length: 60 }, (_, n) => hash(n + 1))
  const daemon = makeDaemon(async batch => batch.map(raw))
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  await reader.read(firstHistory)
  daemon.getTransactions.mockClear()

  const out = await reader.read([...firstHistory, hash(61)])
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
  expect(daemon.getTransactions).toHaveBeenCalledWith([hash(61)])
  expect(out.raws).toHaveLength(61)
  expect(out.missingHashes).toEqual([])
  expect(out.stats).toEqual({ requested: 61, cached: 60, fetched: 1, batches: 1, retries: 0 })
})

// ---- identity, normalization and response validation ----------------------

test('distinct daemon clients never share cached evidence', async () => {
  const daemonA = makeDaemon(async batch => batch.map(raw))
  const daemonB = makeDaemon(async batch => batch.map(raw))
  const readerA = getReconciliationRawReader(daemonA)
  const readerB = getReconciliationRawReader(daemonB)

  expect(getReconciliationRawReader(daemonA)).toBe(readerA)
  expect(readerB).not.toBe(readerA)

  await readerA.read([hash(1)])
  const out = await readerB.read([hash(1)])

  expect(daemonB.getTransactions).toHaveBeenCalledWith([hash(1)])
  expect(out.stats.cached).toBe(0)
  expect(out.raws).toHaveLength(1)
})

test('duplicate and case-variant requested hashes are fetched once', async () => {
  const lower = 'ab'.repeat(32)
  const upper = 'AB'.repeat(32)
  const daemon = makeDaemon(async batch => batch.map(raw))
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  const out = await reader.read([lower, upper, lower])

  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
  expect(daemon.getTransactions).toHaveBeenCalledWith([lower])
  expect(out.raws.map(r => r.hash)).toEqual([lower])
  expect(out.missingHashes).toEqual([])
  expect(out.stats).toEqual({ requested: 1, cached: 0, fetched: 1, batches: 1, retries: 0 })
})

test.each([
  ['a non-array list', 'nope'],
  ['an empty list', []],
  ['a non-string hash', [null]],
  ['an empty-string hash', ['']]
])('%s refuses with RAW_HASH_LIST_INVALID without RPC', async (label, input) => {
  const daemon = makeDaemon(async batch => batch.map(raw))
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  const err = await reader.read(input).catch(e => e)

  expect(err).toBeInstanceOf(Error)
  expect(err.code).toBe('RAW_HASH_LIST_INVALID')
  expect(daemon.getTransactions).not.toHaveBeenCalled()
})

test.each([
  ['a foreign record', () => [raw(hash(1)), raw(hash(9))]],
  ['a duplicate record', () => [raw(hash(1)), raw(hash(1))]],
  ['a non-Buffer extra', () => [{ hash: hash(1), extra: '00' }]],
  ['a missing extra', () => [{ hash: hash(1) }]],
  ['a non-object record', () => [null]]
])('%s refuses with RAW_EVIDENCE_RESPONSE_INVALID and warms nothing', async (label, respond) => {
  const daemon = makeDaemon(batch => batch.map(raw))
  daemon.getTransactions.mockImplementationOnce(async () => respond())
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  const err = await reader.read([hash(1)]).catch(e => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.code).toBe('RAW_EVIDENCE_RESPONSE_INVALID')

  // The refused batch was not cached — the same read fetches again.
  const out = await reader.read([hash(1)])
  expect(out.missingHashes).toEqual([])
  expect(daemon.getTransactions).toHaveBeenCalledTimes(2)
})

test('returned records carry only hash and extra', async () => {
  const daemon = makeDaemon(async batch => batch.map(h => ({ ...raw(h), vout: ['not', 'copied'] })))
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  const out = await reader.read([hash(1)])

  expect(Object.keys(out.raws[0]).sort()).toEqual(['extra', 'hash'])
})

test('a zero-byte extra is a valid cached transaction', async () => {
  const daemon = makeDaemon(async batch => batch.map(h => rawBytes(h, [])))
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  const first = await reader.read([hash(1)])
  expect(first.missingHashes).toEqual([])
  expect(first.raws[0].extra).toEqual(Buffer.alloc(0))

  daemon.getTransactions.mockClear()
  const second = await reader.read([hash(1)])
  expect(daemon.getTransactions).not.toHaveBeenCalled()
  expect(second.stats.cached).toBe(1)
})

// ---- bounds: capacity, eviction and mutation isolation ---------------------

test('an oversized record is usable but not retained', async () => {
  const small = hash(1)
  const big = hash(2)
  const bigExtra = Buffer.alloc(200, 7)
  const daemon = makeDaemon(async batch =>
    batch.map(h => (h === big ? rawBytes(h, bigExtra) : raw(h))))
  const reader = createReconciliationRawReader({ daemon, maxBytes: 100, sleep: async () => {}, random: () => 0 })

  const first = await reader.read([small, big])
  expect(first.missingHashes).toEqual([])
  expect(first.raws.find(r => r.hash === big).extra.equals(bigExtra)).toBe(true)

  daemon.getTransactions.mockClear()
  const second = await reader.read([small, big])
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
  expect(daemon.getTransactions).toHaveBeenCalledWith([big])
  expect(second.stats).toEqual({ requested: 2, cached: 1, fetched: 1, batches: 1, retries: 0 })
})

test('eviction with maxEntries: 2 still returns all three requested records', async () => {
  const hashes = [hash(1), hash(2), hash(3)]
  const daemon = makeDaemon(async batch => batch.map(raw))
  const reader = createReconciliationRawReader({ daemon, maxEntries: 2, sleep: async () => {}, random: () => 0 })

  const out = await reader.read(hashes)

  // All three are pinned to this caller's result even though the LRU can only
  // retain two — an evicted entry must not turn into a missing hash.
  expect(out.raws.map(r => r.hash)).toEqual(hashes)
  expect(out.missingHashes).toEqual([])

  // The oldest entry was evicted, so it is fetched again next time.
  daemon.getTransactions.mockClear()
  await reader.read([hash(1)])
  expect(daemon.getTransactions).toHaveBeenCalledWith([hash(1)])
})

test('byte-cap eviction evicts the LRU yet still returns every requested record', async () => {
  // Each retained record costs its 100-byte extra + the 64-byte hash = 164
  // bytes, so the third insertion exceeds a 400-byte cap and evicts the
  // oldest. The eviction must not turn the evicted hash into a missing one
  // for the read that caused it.
  const hashes = [hash(1), hash(2), hash(3)]
  const bytes = Buffer.alloc(100, 7)
  const daemon = makeDaemon(async batch => batch.map(h => rawBytes(h, bytes)))
  const reader = createReconciliationRawReader({ daemon, maxBytes: 400, sleep: async () => {}, random: () => 0 })

  const out = await reader.read(hashes)
  expect(out.raws.map(r => r.hash)).toEqual(hashes)
  expect(out.raws.every(r => r.extra.equals(bytes))).toBe(true)
  expect(out.missingHashes).toEqual([])

  // The byte-evicted oldest entry is fetched again; the other two stay cached.
  daemon.getTransactions.mockClear()
  const second = await reader.read(hashes)
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
  expect(daemon.getTransactions).toHaveBeenCalledWith([hash(1)])
  expect(second.raws.map(r => r.hash)).toEqual(hashes)
  expect(second.missingHashes).toEqual([])
  expect(second.stats).toEqual({ requested: 3, cached: 2, fetched: 1, batches: 1, retries: 0 })
})

test('cache hits are promoted so the least-recently-used entry is evicted first', async () => {
  const daemon = makeDaemon(async batch => batch.map(raw))
  const reader = createReconciliationRawReader({ daemon, maxEntries: 2, sleep: async () => {}, random: () => 0 })

  await reader.read([hash(1), hash(2)])
  await reader.read([hash(1)]) // promote hash(1)
  await reader.read([hash(3)]) // evicts the real LRU: hash(2)
  daemon.getTransactions.mockClear()

  const out = await reader.read([hash(2)])
  expect(daemon.getTransactions).toHaveBeenCalledWith([hash(2)])
  expect(out.stats.cached).toBe(0)
})

test('mutating a returned Buffer cannot corrupt the cached copy', async () => {
  const daemon = makeDaemon(async batch => batch.map(h => rawBytes(h, [1, 2, 3])))
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  // Miss path: the returned buffer must not alias the retained copy.
  const first = await reader.read([hash(1)])
  first.raws[0].extra[0] = 0xff
  expect(first.raws[0].extra.equals(Buffer.from([0xff, 2, 3]))).toBe(true)

  // Hit path: a cached entry handed back to a caller must be a clone as well.
  const second = await reader.read([hash(1)])
  expect(second.raws[0].extra.equals(Buffer.from([1, 2, 3]))).toBe(true)
  second.raws[0].extra[1] = 0xff

  const third = await reader.read([hash(1)])
  expect(third.raws[0].extra.equals(Buffer.from([1, 2, 3]))).toBe(true)
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
})

// ---- acquisition sharing and deadline retry --------------------------------

test('simultaneous reads share one acquisition pass', async () => {
  const hashes = [hash(1), hash(2), hash(3)]
  const daemon = makeDaemon(async batch => batch.map(raw))
  const reader = createReconciliationRawReader({ daemon, sleep: async () => {}, random: () => 0 })

  const [first, second] = await Promise.all([reader.read(hashes), reader.read(hashes)])

  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
  expect(first.raws.map(r => r.hash)).toEqual(hashes)
  expect(second.raws.map(r => r.hash)).toEqual(hashes)
  expect(first.missingHashes).toEqual([])
  expect(second.missingHashes).toEqual([])
  expect(first.stats.fetched).toBe(3)
  expect(second.stats).toEqual({ requested: 3, cached: 3, fetched: 0, batches: 0, retries: 0 })
})

test('a deadline is retried once, then surfaces after two attempts', async () => {
  const daemon = makeDaemon(async () => {
    throw Object.assign(new Error('deadline'), { code: 'DAEMON_TIMEOUT' })
  })
  const sleep = stubSleep()
  const reader = createReconciliationRawReader({ daemon, sleep, random: () => 0 })

  const err = await reader.read([hash(1)]).catch(e => e)

  expect(err.code).toBe('DAEMON_TIMEOUT')
  expect(daemon.getTransactions).toHaveBeenCalledTimes(2)
  expect(sleep).toHaveBeenCalledTimes(1)
  expect(sleep).toHaveBeenCalledWith(500)
})

test('a deadline on the first attempt is retried and can succeed', async () => {
  const daemon = makeDaemon(async batch => batch.map(raw))
  daemon.getTransactions.mockImplementationOnce(async () => {
    throw Object.assign(new Error('deadline'), { code: 'DAEMON_TIMEOUT' })
  })
  const sleep = stubSleep()
  const reader = createReconciliationRawReader({ daemon, sleep, random: () => 0.5 })

  const out = await reader.read([hash(1)])

  expect(out.missingHashes).toEqual([])
  expect(out.stats).toEqual({ requested: 1, cached: 0, fetched: 1, batches: 2, retries: 1 })
  expect(sleep).toHaveBeenCalledWith(750)
})

test.each([
  ['an RPC failure', () => Object.assign(new Error('rpc status'), { code: 'DAEMON_RPC' })],
  ['a plain transport failure', () => new Error('socket hang up')]
])('%s is not retried', async (label, makeError) => {
  const failure = makeError()
  const daemon = makeDaemon(async () => { throw failure })
  const sleep = stubSleep()
  const reader = createReconciliationRawReader({ daemon, sleep, random: () => 0 })

  const err = await reader.read([hash(1)]).catch(e => e)

  expect(err).toBe(failure)
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
  expect(sleep).not.toHaveBeenCalled()
})

// ---- scan budget -----------------------------------------------------------

test('budget exhaustion retains successful prefixes', async () => {
  const hashes = Array.from({ length: 101 }, (_, n) => hash(n + 1))
  let clock = 0
  const daemon = makeDaemon(async batch => {
    clock += 60
    return batch.map(raw)
  })
  const reader = createReconciliationRawReader({
    daemon,
    now: () => clock,
    scanBudgetMs: 100,
    sleep: async () => {},
    random: () => 0
  })

  const err = await reader.read(hashes).catch(e => e)
  expect(err.code).toBe('RAW_SCAN_BUDGET_EXHAUSTED')
  // Two 50-hash batches completed before the third was refused.
  expect(daemon.getTransactions).toHaveBeenCalledTimes(2)

  clock = 0
  daemon.getTransactions.mockClear()
  const out = await reader.read(hashes)
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
  expect(daemon.getTransactions).toHaveBeenCalledWith([hashes[100]])
  expect(out.raws).toHaveLength(101)
  expect(out.missingHashes).toEqual([])
})

test('a reader that waited past its scan budget defers without another RPC', async () => {
  let releaseFirstBatch
  let clock = 0
  const hashes = [hash(1), hash(2)]
  const gate = new Promise(resolve => { releaseFirstBatch = resolve })
  const daemon = makeDaemon(async batch => {
    await gate
    clock += 60
    return batch.map(raw)
  })
  const reader = createReconciliationRawReader({
    daemon,
    now: () => clock,
    scanBudgetMs: 100,
    sleep: async () => {},
    random: () => 0
  })

  const firstRead = reader.read(hashes)
  await new Promise(resolve => setImmediate(resolve))
  // Attach the catch at creation: the deferred read may reject while the test
  // is still awaiting firstRead, and an unhandled rejection fails the test on
  // loaded CI runners even though production always awaits read() directly.
  const waitingRead = reader.read(hashes).catch(e => e)
  clock = 100
  releaseFirstBatch()

  const first = await firstRead
  expect(first.missingHashes).toEqual([])

  const err = await waitingRead
  expect(err.code).toBe('RAW_SCAN_BUDGET_EXHAUSTED')
  expect(daemon.getTransactions).toHaveBeenCalledTimes(1)
})
