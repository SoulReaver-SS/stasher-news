import { Mutex } from 'async-mutex'
import { setTimeout as defaultSleep } from 'node:timers/promises'
import { MAX_TX_HASHES_PER_REQUEST } from '@/api/monero/daemonClient'
import { createReconciliationCheckpoint } from '@/worker/reconciliationScan'

// reconciliationRawTransactions — shared bounded raw-`extra` reader for the
// reconciliation workers (Finding 1).
//
// reconcilePendingTips (every 2 min) and reconcileOwnerFeeLegs (hourly) both
// recover missed lws callbacks by re-deriving payment ids from a raw tx's
// `extra`. They fetch the account's ENTIRE transaction history from monerod
// through daemonClient.getTransactions: on a ~2,700-tx account that is ~54
// sequential 50-hash requests per run, and a single 15 s request deadline
// aborted the whole account pass — so the next run re-fetched everything and
// the workers could make no durable progress.
//
// This reader keeps a bounded, process-local memory of raw-extra evidence and
// makes completed batches durable across runs:
//   - per-batch progress: every successful batch is cached immediately, so a
//     failure in a later batch keeps all earlier batches,
//   - one typed deadline retry (`DAEMON_TIMEOUT`) per batch, then rethrow,
//   - one shared acquisition pass per reader (mutex), so the two workers never
//     issue overlapping duplicate cold scans,
//   - a 90 s scan budget that defers a pathological cold scan to a later tick
//     with progress retained instead of re-fetching from scratch.
//
// The cache holds ONLY `{ hash, extra }` copies of public chain data — no
// account ids, no view/wallet keys, no amounts, heights, PIDs or decrypted
// material — and getPaymentTransactions, receipt verification and payout proof
// verification never read it. A hash without usable evidence means "not
// established now", never a negative payment verdict: acquisition failures are
// never cached as a result.
//
// One reader per daemon client object (WeakMap). The production workers share
// the singleton daemonClient and therefore evidence; a separate client — and a
// restarted process — starts cold. The client must not be hot-reconfigured to
// another network/endpoint while its reader lives.

const DEFAULT_MAX_ENTRIES = 10000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_SCAN_BUDGET_MS = 90000
const RETRY_BASE_MS = 500
const RETRY_JITTER_MS = 500

// Fixed-code reader error. Codes are the interface the workers classify on —
// never echo arbitrary daemon/DB error text through them.
class RawReaderError extends Error {
  constructor (code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'RawReaderError'
    this.code = code
  }
}

// Lowercase, dedupe, retain requested order. An empty/non-string request is a
// caller bug, not a payment verdict, so it refuses with a fixed code.
function normalizeRequestedHashes (hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) {
    throw new RawReaderError('RAW_HASH_LIST_INVALID', 'expected a non-empty array of transaction hashes')
  }
  const requested = []
  const seen = new Set()
  for (const hash of hashes) {
    if (typeof hash !== 'string' || hash === '') {
      throw new RawReaderError('RAW_HASH_LIST_INVALID', 'expected non-empty string transaction hashes')
    }
    const normalized = hash.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    requested.push(normalized)
  }
  return requested
}

/**
 * Build a bounded raw-evidence reader for one daemon client.
 *
 * @param {object} options
 * @param {object} options.daemon     daemon client (getTransactions(hashes) -> Promise<Array<{hash, extra}>>)
 * @param {number} [options.maxEntries] LRU entry cap (default 10000)
 * @param {number} [options.maxBytes]   LRU accounted-byte cap (extra + hash bytes, default 32 MiB)
 * @param {function} [options.now]      clock injection for the scan budget (default Date.now)
 * @param {function} [options.sleep]    retry-delay injection (default node:timers/promises setTimeout)
 * @param {function} [options.random]   retry-jitter injection (default Math.random)
 * @param {number} [options.scanBudgetMs] bounded acquisition budget per read (default 90000)
 * @returns {{ read: function }} reader
 */
export function createReconciliationRawReader ({
  daemon,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  now = Date.now,
  sleep = defaultSleep,
  random = Math.random,
  scanBudgetMs = DEFAULT_SCAN_BUDGET_MS
} = {}) {
  // Insertion order is LRU order: promoting a hit deletes and re-inserts it.
  const cache = new Map()
  let cacheBytes = 0
  const acquisitionMutex = new Mutex()

  const entryBytes = entry => entry.extra.byteLength + Buffer.byteLength(entry.hash)

  function promote (hash) {
    const entry = cache.get(hash)
    cache.delete(hash)
    cache.set(hash, entry)
    return entry
  }

  // Retain a copy of a validated record. A record larger than the byte budget
  // on its own stays usable for this caller but is never retained; every other
  // insertion evicts least-recently-used entries until both caps hold.
  function retain ({ hash, extra }) {
    const bytes = extra.byteLength + Buffer.byteLength(hash)
    if (bytes > maxBytes) return
    const existing = cache.get(hash)
    if (existing) {
      cache.delete(hash)
      cacheBytes -= entryBytes(existing)
    }
    cache.set(hash, { hash, extra: Buffer.from(extra) })
    cacheBytes += bytes
    while ((cache.size > maxEntries || cacheBytes > maxBytes) && cache.size > 0) {
      const oldest = cache.keys().next().value
      const evicted = cache.get(oldest)
      cache.delete(oldest)
      cacheBytes -= entryBytes(evicted)
    }
  }

  // Whole-response validation BEFORE anything is cached: every record must
  // belong to this batch, appear once and carry a Buffer extra. A foreign hash
  // must never warm the cache, and a malformed response is a refusal — not a
  // silent subset.
  function validateResponse (records, batch) {
    if (!Array.isArray(records)) {
      throw new RawReaderError('RAW_EVIDENCE_RESPONSE_INVALID', 'response is not an array')
    }
    const requested = new Set(batch)
    const seen = new Set()
    const valid = []
    for (const record of records) {
      if (!record || typeof record !== 'object') {
        throw new RawReaderError('RAW_EVIDENCE_RESPONSE_INVALID', 'record is not an object')
      }
      const { hash, extra } = record
      if (typeof hash !== 'string' || !requested.has(hash)) {
        throw new RawReaderError('RAW_EVIDENCE_RESPONSE_INVALID', 'record hash was not requested in this batch')
      }
      if (seen.has(hash)) {
        throw new RawReaderError('RAW_EVIDENCE_RESPONSE_INVALID', 'duplicate record in response')
      }
      if (!Buffer.isBuffer(extra)) {
        throw new RawReaderError('RAW_EVIDENCE_RESPONSE_INVALID', 'record extra is not a Buffer')
      }
      seen.add(hash)
      valid.push({ hash, extra })
    }
    return valid
  }

  function budgetExhausted () {
    return new RawReaderError('RAW_SCAN_BUDGET_EXHAUSTED', 'raw-evidence scan budget exhausted')
  }

  // One batch, with AT MOST one retry and only for the typed deadline error.
  // The budget is rechecked before every RPC attempt and before the retry
  // delay, so a pathological scan defers instead of spinning.
  async function acquireBatch (batch, deadline, stats) {
    let retried = false
    for (;;) {
      if (now() >= deadline) throw budgetExhausted()
      stats.batches++
      let records
      try {
        records = await daemon.getTransactions(batch)
      } catch (err) {
        if (!err || err.code !== 'DAEMON_TIMEOUT' || retried) throw err
        retried = true
        stats.retries++
        if (now() >= deadline) throw budgetExhausted()
        await sleep(RETRY_BASE_MS + Math.floor(random() * RETRY_JITTER_MS))
        continue
      }
      return validateResponse(records, batch)
    }
  }

  /**
   * Read raw-extra evidence for the requested transaction hashes.
   *
   * @param {string[]} hashes 64-hex transaction hashes (case-insensitive; duplicates collapse)
   * @returns {Promise<{raws: Array<{hash: string, extra: Buffer}>, missingHashes: string[],
   *   stats: {requested: number, cached: number, fetched: number, batches: number, retries: number}}>}
   *   `raws` in requested order; `missingHashes` are the exact requested hashes
   *   without usable evidence right now. Rejects with fixed `error.code`
   *   RAW_HASH_LIST_INVALID / RAW_EVIDENCE_RESPONSE_INVALID /
   *   RAW_SCAN_BUDGET_EXHAUSTED, or a typed daemon error
   *   (DAEMON_TIMEOUT / DaemonHttpError / DaemonRpcError) untouched.
   */
  async function read (hashes, checkpoint = createReconciliationCheckpoint()) {
    const requested = normalizeRequestedHashes(hashes)
    const stats = { requested: requested.length, cached: 0, fetched: 0, batches: 0, retries: 0 }
    // Caller-local pinned results. Snapshot hits BEFORE fetching so a later
    // insertion's eviction cannot turn a hit into a missing hash, and so a
    // returned Buffer clone never aliases the cache.
    const pinned = new Map()

    for (const hash of requested) {
      const pause = checkpoint()
      if (pause) await pause
      const hit = cache.get(hash)
      if (hit) {
        pinned.set(hash, promote(hash))
        stats.cached++
      }
    }

    const misses = requested.filter(hash => !pinned.has(hash))
    if (misses.length > 0) {
      const deadline = now() + scanBudgetMs
      await acquisitionMutex.runExclusive(async () => {
        if (now() >= deadline) throw budgetExhausted()
        // Another reader may have supplied hashes while this one waited for
        // the acquisition pass; those count as cache hits, not fetches.
        const stillMissing = []
        for (const hash of misses) {
          const pause = checkpoint()
          if (pause) await pause
          const hit = cache.get(hash)
          if (hit) {
            pinned.set(hash, promote(hash))
            stats.cached++
          } else {
            stillMissing.push(hash)
          }
        }
        for (let i = 0; i < stillMissing.length; i += MAX_TX_HASHES_PER_REQUEST) {
          const batch = stillMissing.slice(i, i + MAX_TX_HASHES_PER_REQUEST)
          const records = await acquireBatch(batch, deadline, stats)
          // Retain immediately: a later batch failure must keep this batch.
          for (const record of records) {
            retain(record)
            pinned.set(record.hash, record)
            stats.fetched++
          }
        }
      })
    }

    const raws = []
    const missingHashes = []
    for (const hash of requested) {
      const pause = checkpoint()
      if (pause) await pause
      const record = pinned.get(hash)
      if (record) raws.push({ hash, extra: Buffer.from(record.extra) })
      else missingHashes.push(hash)
    }
    return { raws, missingHashes, stats }
  }

  return { read }
}

// One reader per daemon client object. Both production workers share the
// singleton daemonClient, so they share evidence; separate clients start cold.
const readersByDaemon = new WeakMap()

/**
 * Shared reader for a daemon client. A restarted process starts cold; a client
 * must not be hot-reconfigured to another network/endpoint.
 *
 * @param {object} daemon daemon client object (identity-keyed)
 * @returns {{ read: function }}
 */
export function getReconciliationRawReader (daemon) {
  let reader = readersByDaemon.get(daemon)
  if (reader === undefined) {
    reader = createReconciliationRawReader({ daemon })
    readersByDaemon.set(daemon, reader)
  }
  return reader
}
