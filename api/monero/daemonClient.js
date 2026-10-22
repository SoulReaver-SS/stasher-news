import https from 'node:https'
import http from 'node:http'

// monerod restricted-RPC client (Task 6 / spec §5.5).
//
// monero-lws's /get_address_txs response carries per-tx heights but NO block
// hash (lws source: light_wallet.cpp:494-531), so the
// reorg-safe cursor's `since_tx_block_hash` dimension has to be sourced
// elsewhere. monerod's `get_block_header_by_height` JSON-RPC returns exactly
// that — the hash for a given height — and is a read-only header call the
// restricted RPC permits (the design spec lists MONEROD_URL as
// the restricted RPC endpoint).
//
// This is a SEPARATE daemon from lws (different process, different transport:
// monerod JSON-RPC over plain HTTP vs. lws REST), so it gets its own client
// module rather than growing api/monero/lwsClient.js. The factory mirrors the
// lwsClient DI seam — `createDaemonClient({ transport })` with a default real
// transport on node:http/https — so tests inject a fake transport with the same
// `{status, ok, text()}` shape and never touch the network.
//
// No retry/backoff: a transient failure surfaces as a throw and is retried by
// the indexer's next 20s poll (MONERO_POLL_INTERVAL_MS). Keeping this layer
// single-shot avoids a retry storm against monerod and matches the "small
// helper" remit.

const DEFAULT_TIMEOUT_MS = 15000

// monerod's restricted RPC rejects /get_transactions above 100 hashes (HTTP
// 200 error, no txs array). Batch at 50: half the cap, smaller responses.
// v0.18.5.4 re-probe: >100 did not reproduce with synthetic hashes; the
// non-OK-throw contract is unchanged.
export const MAX_TX_HASHES_PER_REQUEST = 50

// An `extra` blob counts as evidence only when its encoding is VALID before any
// conversion. Buffer.from('01zz', 'hex') silently truncates to [0x01] and
// Buffer.from([2 ** 53]) coerces/truncates out-of-range array entries, so a
// malformed acquisition would otherwise reach the raw-evidence reader as a
// "valid" Buffer and could authorise an expiry verdict. Valid forms: an even
// length hex string (the EMPTY string is legitimate) or an array whose every
// element is a safe 0..255 integer.
const HEX_BYTES_RE = /^(?:[0-9a-fA-F]{2})*$/
const isByteValue = b => Number.isSafeInteger(b) && b >= 0 && b <= 255

// A request that exceeded its deadline aborts with this typed error (Finding
// 1) so callers can tell "monerod did not answer in time" apart from every
// other transport/HTTP/RPC failure. The fixed code is safe to classify
// without echoing arbitrary error text, and the retry decision belongs to the
// caller (the raw-evidence reader retries exactly one deadline per batch).
export class DaemonTimeoutError extends Error {
  constructor () {
    super('monerod request deadline exceeded')
    this.name = 'DaemonTimeoutError'
    this.code = 'DAEMON_TIMEOUT'
  }
}

class DaemonHttpError extends Error {
  constructor (status) {
    super(`monerod JSON-RPC returned HTTP ${status}`)
    this.name = 'DaemonHttpError'
    this.status = status
  }
}

class DaemonRpcError extends Error {
  constructor (method, rpcError) {
    const code = rpcError && rpcError.code != null ? ` (code ${rpcError.code})` : ''
    super(`monerod ${method} RPC error${code}: ${rpcError && rpcError.message ? rpcError.message : 'unknown'}`)
    this.name = 'DaemonRpcError'
    this.method = method
    this.rpcError = rpcError
  }
}

function readEnv (name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

// Real transport on node:http/https — same shape as lwsClient's real transport
// ({status, ok, text}). Honours an AbortSignal so the client response timeout
// can destroy a hung request. Both abort branches destroy with the signal's
// error reason (the client's typed DaemonTimeoutError), never a fresh generic
// error, so the deadline stays classifiable by the time it reaches the caller.
function makeTransport () {
  return function transport (url, { method = 'POST', headers = {}, body, signal } = {}) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https://') ? https : http
      const reqHeaders = { 'content-type': 'application/json', accept: 'application/json', ...headers }
      if (body !== undefined && body !== null) reqHeaders['content-length'] = Buffer.byteLength(body)
      const req = lib.request(url, {
        method,
        headers: reqHeaders
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: async () => text
          })
        })
      })
      req.on('error', reject)
      if (signal) {
        if (signal.aborted) req.destroy(signal.reason)
        else signal.addEventListener('abort', () => req.destroy(signal.reason), { once: true })
      }
      if (body !== undefined && body !== null) req.write(body)
      req.end()
    })
  }
}

function parseJsonText (text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

/**
 * Build a monerod JSON-RPC client.
 *
 * @param {object} [options]
 * @param {string} [options.daemonUrl]   MONEROD_URL. If unset here AND in env, calls throw clearly.
 * @param {number} [options.timeoutMs]   Response timeout (default 15000).
 * @param {function} [options.transport] Injected transport (DI for tests).
 * @returns {object} `{ getBlockHashByHeight, rpc }`
 */
export function createDaemonClient (options = {}) {
  // `undefined` (not a fallback URL) when neither option nor env supplies one,
  // so getBlockHashByHeight can fail clearly instead of silently hitting a
  // fabricated address.
  const daemonUrl = options.daemonUrl !== undefined
    ? options.daemonUrl
    : (readEnv('MONEROD_URL', undefined) || undefined)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const transport = options.transport ?? makeTransport()

  function requireUrl () {
    if (!daemonUrl) {
      throw new Error('monerod: MONEROD_URL is not configured; cannot source block hashes for the reorg cursor')
    }
    return daemonUrl.replace(/\/$/, '')
  }

  async function rpc (method, params) {
    const base = requireUrl()
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new DaemonTimeoutError()), timeoutMs)
    let res
    try {
      res = await transport(`${base}/json_rpc`, { method: 'POST', body, signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new DaemonHttpError(res.status)
    const json = parseJsonText(await res.text())
    if (!json) throw new Error(`monerod ${method}: empty/unparseable response`)
    if (json.error) throw new DaemonRpcError(method, json.error)
    return json.result
  }

  /**
   * Fetch a block hash by height via get_block_header_by_height.
   * @param {number} height
   * @returns {Promise<string>} the block hash (hex)
   */
  async function getBlockHashByHeight (height) {
    const result = await rpc('get_block_header_by_height', { height })
    const hash = result && result.block_header && result.block_header.hash
    if (!hash) throw new Error(`monerod get_block_header_by_height(${height}) returned no block_header.hash`)
    return hash
  }

  async function getHeight () {
    const result = await rpc('get_info', {})
    const height = result && result.height
    if (typeof height !== 'number') throw new Error('monerod get_info returned no height')
    return height
  }

  // One ≤MAX_TX_HASHES_PER_REQUEST batch: POST, HTTP/status validation, raw
  // monerod `txs` array back. Any non-OK status (the restricted-mode cap
  // included) throws — a silent [] here would masquerade as "nothing on
  // chain" and let a paid tip expire (mainnet incident 2026-09-15).
  async function fetchTxBatch (base, hashes) {
    const body = JSON.stringify({ txs_hashes: hashes, decode_as_json: true })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new DaemonTimeoutError()), timeoutMs)
    let res
    try {
      res = await transport(`${base}/get_transactions`, { method: 'POST', body, signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new DaemonHttpError(res.status)
    const json = parseJsonText(await res.text())
    if (!json || json.status !== 'OK') {
      throw new DaemonRpcError('get_transactions', {
        message: `${json && json.status ? json.status : 'empty/unparseable response'} (requested ${hashes.length} hashes)`
      })
    }
    return Array.isArray(json.txs) ? json.txs : []
  }

  /**
   * Fetch raw transactions by hash via the plain (non-json_rpc)
   * /get_transactions endpoint, returning each tx's extra blob plus its vout
   * target keys. The caller (reconcilePendingTips' wrong-pid fallback) needs
   * the tx public key(s) + encrypted payment id from the extra; the vout keys
   * feed the recipient ownership proof (a 0-conf tx is only credited when one
   * of its outputs derives to the claimed recipient). decode_as_json hands
   * back the parsed tx as a JSON string; monerod serializes `extra` as a byte
   * array (older builds: hex string) — both are validated for encoding BEFORE
   * conversion and then normalized to a Buffer; a malformed extra (bad hex,
   * out-of-range array entries) omits the tx like unparseable as_json, so a
   * malformed acquisition is never mistaken for usable evidence. vout
   * entries are reduced to their one-time key (legacy `target.key` or v2
   * `target.tagged_key.key`), with null preserved for entries that carry no
   * key. Restricted RPC permits this endpoint but caps a single request at 100
   * hashes, so hashes are batched at MAX_TX_HASHES_PER_REQUEST and a non-OK
   * status throws instead of returning an empty list. Mempool txs are returned
   * too (in_pool). Missed hashes are omitted.
   * @param {string[]} hashes
   * @returns {Promise<Array<{hash: string, extra: Buffer, vout: Array<string|null>}>>}
   */
  async function getTransactions (hashes) {
    if (!Array.isArray(hashes) || hashes.length === 0) return []
    const base = requireUrl()
    const out = []
    for (let i = 0; i < hashes.length; i += MAX_TX_HASHES_PER_REQUEST) {
      const txs = await fetchTxBatch(base, hashes.slice(i, i + MAX_TX_HASHES_PER_REQUEST))
      for (const tx of txs) {
        if (!tx || !tx.tx_hash) continue
        let extra = null
        let vout = []
        if (typeof tx.as_json === 'string' && tx.as_json) {
          try {
            const parsed = JSON.parse(tx.as_json)
            // Validate the ENCODING before conversion (see HEX_BYTES_RE /
            // isByteValue above): an invalid extra omits the tx, exactly like
            // unparseable as_json, so callers see the hash as missing
            // (incomplete evidence -> expiry deferred, never an expiry off a
            // malformed acquisition).
            if (Array.isArray(parsed.extra)) {
              if (parsed.extra.every(isByteValue)) extra = Buffer.from(parsed.extra)
            } else if (typeof parsed.extra === 'string') {
              if (HEX_BYTES_RE.test(parsed.extra)) extra = Buffer.from(parsed.extra, 'hex')
            }
            if (Array.isArray(parsed.vout)) {
              vout = parsed.vout.map((o) => o?.target?.key ?? o?.target?.tagged_key?.key ?? null)
            }
          } catch {
            // unparseable as_json: omit the tx (caller treats as not-found)
          }
        }
        if (extra != null) out.push({ hash: tx.tx_hash, extra, vout })
      }
    }
    return out
  }

  // ---- strict raw evidence (payment-proof chain adapter, Finding #1) --------
  //
  // Unlike getTransactions above, this is a STRICT evidence fetch for the
  // rewards payment verification chain: every response shape it does not fully
  // understand is a refusal with a fixed code (error.code), never a skipped
  // entry. It returns validated raw records
  //   { txHash, isCoinbase, inputKeyImages, voutKeys, outputIndices,
  //     feePiconeros (bigint), blockHeight, inTxPool: false, extra (hex) }
  // or throws. Coinbases (single `gen` vin) are accepted with zero key images
  // and zero fee — they may serve as input SOURCES downstream but are never
  // spending-payment key inputs.

  class DaemonRawTxError extends Error {
    constructor (code, detail) {
      super(detail === undefined ? code : `${code}: ${detail}`)
      this.name = 'DaemonRawTxError'
      this.code = code
    }
  }

  const assertStrictHash = (value, code) => {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw new DaemonRawTxError(code, String(value))
    }
    return value
  }

  const assertSafeNonNegativeInt = (value, code, label) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      // Integer-safety check happens BEFORE any BigInt conversion.
      throw new DaemonRawTxError(code, `${label}=${String(value)}`)
    }
    return value
  }

  // Extract the decoded tx object: decode_as_json hands back a JSON string,
  // while some builds/relays embed it pre-parsed — both tolerated explicitly.
  function parseRawTxObject (entry) {
    if (entry.pruned_as_json !== undefined || entry.prunable_as_json !== undefined) {
      throw new DaemonRawTxError('RAW_PRUNED_JSON_UNSUPPORTED', entry.tx_hash)
    }
    let parsed
    if (typeof entry.as_json === 'string' && entry.as_json !== '') {
      try {
        parsed = JSON.parse(entry.as_json)
      } catch {
        throw new DaemonRawTxError('RAW_TX_JSON_MALFORMED', entry.tx_hash)
      }
    } else if (entry.as_json !== null && typeof entry.as_json === 'object') {
      parsed = entry.as_json
    } else {
      throw new DaemonRawTxError('RAW_TX_JSON_MISSING', entry.tx_hash)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DaemonRawTxError('RAW_TX_JSON_MISSING', entry.tx_hash)
    }
    return parsed
  }

  function extractRawPaymentTx (entry, requestedHashes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DaemonRawTxError('RAW_TX_JSON_MISSING', 'non-object tx entry')
    }
    const txHash = entry.tx_hash
    if (typeof txHash !== 'string' || !/^[0-9a-f]{64}$/.test(txHash) || !requestedHashes.has(txHash)) {
      throw new DaemonRawTxError('RAW_HASH_MISMATCH', String(txHash))
    }
    if (entry.in_pool !== false) {
      throw new DaemonRawTxError('RAW_TX_IN_POOL', txHash)
    }
    const blockHeight = assertSafeNonNegativeInt(entry.block_height, 'RAW_INTEGER_UNSAFE', 'block_height')
    const parsed = parseRawTxObject(entry)

    // vin: either a single coinbase `gen` input or key inputs with unique
    // 64-hex key images — never mixed, never empty.
    if (!Array.isArray(parsed.vin) || parsed.vin.length === 0) {
      throw new DaemonRawTxError('RAW_INPUTS_MISSING', txHash)
    }
    const isCoinbase = parsed.vin.every(v => v && typeof v === 'object' && v.gen !== undefined)
    const inputKeyImages = []
    if (isCoinbase) {
      if (parsed.vin.length !== 1 ||
        !Number.isSafeInteger(parsed.vin[0].gen.height) || parsed.vin[0].gen.height < 0) {
        throw new DaemonRawTxError('RAW_COINBASE_INVALID', txHash)
      }
    } else {
      for (const vin of parsed.vin) {
        const kImage = vin && typeof vin === 'object' ? vin.key && vin.key.k_image : undefined
        if (typeof kImage !== 'string' || !/^[0-9a-f]{64}$/.test(kImage)) {
          throw new DaemonRawTxError('RAW_INPUT_UNSUPPORTED', txHash)
        }
        inputKeyImages.push(kImage)
      }
      if (new Set(inputKeyImages).size !== inputKeyImages.length) {
        throw new DaemonRawTxError('DUPLICATE_INPUT_KEY_IMAGE', txHash)
      }
    }

    // vout: every output must carry a usable one-time key (legacy `target.key`
    // or v2 `target.tagged_key.key`); nulls are refused, unlike getTransactions.
    if (!Array.isArray(parsed.vout) || parsed.vout.length === 0) {
      throw new DaemonRawTxError('RAW_VOUT_MISSING', txHash)
    }
    const voutKeys = []
    for (const vout of parsed.vout) {
      const target = vout && typeof vout === 'object' ? vout.target : undefined
      const key = target && typeof target === 'object'
        ? (typeof target.key === 'string' ? target.key : target.tagged_key && target.tagged_key.key)
        : undefined
      if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) {
        throw new DaemonRawTxError('RAW_VOUT_KEY_MALFORMED', txHash)
      }
      voutKeys.push(key)
    }
    if (new Set(voutKeys).size !== voutKeys.length) {
      throw new DaemonRawTxError('DUPLICATE_OUTPUT_KEY', txHash)
    }

    // Global output indices, when the daemon returns them for confirmed txs.
    let outputIndices = null
    if (entry.output_indices !== undefined && entry.output_indices !== null) {
      if (!Array.isArray(entry.output_indices) || entry.output_indices.length !== voutKeys.length) {
        throw new DaemonRawTxError('RAW_OUTPUT_INDICES_LENGTH', txHash)
      }
      outputIndices = entry.output_indices.map(n => assertSafeNonNegativeInt(n, 'RAW_INTEGER_UNSAFE', 'output_indices'))
    }

    // Exact nonnegative fee (RingCT txnFee), safe-integer guarded before BigInt.
    let feePiconeros
    const txnFee = parsed.rct_signatures && typeof parsed.rct_signatures === 'object'
      ? parsed.rct_signatures.txnFee
      : undefined
    if (isCoinbase) {
      if (txnFee !== undefined && txnFee !== 0) {
        throw new DaemonRawTxError('RAW_COINBASE_INVALID', `${txHash} carries a fee`)
      }
      feePiconeros = 0n
    } else {
      if (txnFee === undefined) {
        throw new DaemonRawTxError('RAW_FEE_MISSING', txHash)
      }
      assertSafeNonNegativeInt(txnFee, 'RAW_INTEGER_UNSAFE', 'txnFee')
      feePiconeros = BigInt(txnFee)
    }

    // extra: hex string (standard) or byte-number array (older builds).
    let extra
    const rawExtra = parsed.extra
    if (typeof rawExtra === 'string') {
      if (!/^(?:[0-9a-f]{2})*$/.test(rawExtra)) {
        throw new DaemonRawTxError('RAW_EXTRA_MALFORMED', txHash)
      }
      extra = rawExtra
    } else if (Array.isArray(rawExtra)) {
      if (!rawExtra.every(b => Number.isSafeInteger(b) && b >= 0 && b <= 255)) {
        throw new DaemonRawTxError('RAW_EXTRA_MALFORMED', txHash)
      }
      extra = Buffer.from(rawExtra).toString('hex')
    } else if (isCoinbase && rawExtra === undefined) {
      extra = ''
    } else {
      throw new DaemonRawTxError('RAW_EXTRA_MISSING', txHash)
    }

    return {
      txHash,
      isCoinbase,
      inputKeyImages,
      voutKeys,
      outputIndices,
      feePiconeros,
      blockHeight,
      inTxPool: false,
      extra
    }
  }

  /**
   * I1 (payment-proof verifier, additive): resolve the block hash for each
   * DISTINCT audited block_height through the same get_block_header_by_height
   * RPC, transport and timeout discipline as getBlockHashByHeight — one call
   * per distinct height, attached to every record at that height. A header
   * response without a usable hash yields null (unresolvable — never a
   * fabricated value); transport/HTTP/RPC failures keep the existing throw
   * discipline. Lowercase 64-hex or null.
   * @param {Array<object>} records validated raw records (mutated in place)
   * @returns {Promise<void>}
   */
  async function attachBlockHashes (records) {
    const blockHashByHeight = new Map()
    for (const height of [...new Set(records.map(record => record.blockHeight))]) {
      try {
        const result = await rpc('get_block_header_by_height', { height })
        const hash = result && result.block_header ? result.block_header.hash : null
        blockHashByHeight.set(height,
          typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null)
      } catch (err) {
        if (err instanceof DaemonHttpError || err instanceof DaemonRpcError) throw err
        // A well-formed response that carries no usable hash: unresolvable.
        blockHashByHeight.set(height, null)
      }
    }
    for (const record of records) {
      record.blockHash = blockHashByHeight.get(record.blockHeight) ?? null
    }
  }

  /**
   * Fetch validated raw transaction evidence by hash via /get_transactions.
   * Requests `{txs_hashes, decode_as_json: true, prune: false}` in
   * ≤MAX_TX_HASHES_PER_REQUEST batches; any non-OK status (the restricted-mode
   * cap included) throws DaemonHttpError/DaemonRpcError; missed hashes,
   * pruned/partial forms, in-pool transactions, unknown/duplicate hashes,
   * duplicate key images/output keys and unsafe integers all refuse with a
   * fixed `error.code`. Refuses empty results for requested hashes
   * (DAEMON_TX_NOT_RETURNED) — a silent [] would masquerade as "not on chain".
   * Each record additionally carries `blockHash` (lowercase 64-hex resolved
   * per distinct block_height via get_block_header_by_height, or null when
   * the daemon supplies no usable hash — never fabricated).
   * @param {string[]} hashes lowercase 64-hex transaction hashes (no duplicates)
   * @returns {Promise<Array<object>>} validated raw records
   */
  async function getPaymentTransactions (hashes) {
    if (!Array.isArray(hashes)) {
      throw new DaemonRawTxError('RAW_HASH_LIST_INVALID', 'expected an array of 64-hex hashes')
    }
    if (hashes.length === 0) return []
    const requested = new Set()
    for (const hash of hashes) {
      assertStrictHash(hash, 'RAW_HASH_INVALID')
      if (requested.has(hash)) throw new DaemonRawTxError('RAW_HASH_DUPLICATE', hash)
      requested.add(hash)
    }
    const base = requireUrl()
    const out = []
    const seen = new Set()
    for (let i = 0; i < hashes.length; i += MAX_TX_HASHES_PER_REQUEST) {
      const batch = hashes.slice(i, i + MAX_TX_HASHES_PER_REQUEST)
      const body = JSON.stringify({ txs_hashes: batch, decode_as_json: true, prune: false })
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new DaemonTimeoutError()), timeoutMs)
      let res
      try {
        res = await transport(`${base}/get_transactions`, { method: 'POST', body, signal: ac.signal })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new DaemonHttpError(res.status)
      const json = parseJsonText(await res.text())
      if (!json || json.status !== 'OK') {
        throw new DaemonRpcError('get_transactions', {
          message: `${json && json.status ? json.status : 'empty/unparseable response'} (requested ${batch.length} hashes)`
        })
      }
      const missed = ['miss_hashes', 'missed_tx', 'missed_hashes', 'missed_hashes_txs']
        .flatMap(field => (Array.isArray(json[field]) ? json[field] : []))
      if (missed.length > 0) {
        throw new DaemonRawTxError('DAEMON_MISSED_TX_HASH', `${missed.length} requested hash(es) missing: ${missed.join(',')}`)
      }
      const txs = json.txs
      if (!Array.isArray(txs)) {
        throw new DaemonRawTxError('RAW_RESPONSE_INVALID', 'txs is not an array')
      }
      for (const entry of txs) {
        const record = extractRawPaymentTx(entry, requested)
        if (seen.has(record.txHash)) throw new DaemonRawTxError('RAW_TX_DUPLICATE', record.txHash)
        seen.add(record.txHash)
        out.push(record)
      }
    }
    for (const hash of hashes) {
      if (!seen.has(hash)) throw new DaemonRawTxError('DAEMON_TX_NOT_RETURNED', hash)
    }
    await attachBlockHashes(out)
    return out
  }

  return { getBlockHashByHeight, getHeight, getTransactions, getPaymentTransactions, rpc }
}

// Singleton: constructed once at module load from MONEROD_URL. The worker
// imports this directly; tests inject via createDaemonClient({ transport }).
export const daemonClient = createDaemonClient()
