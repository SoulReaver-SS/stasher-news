import https from 'node:https'
import http from 'node:http'
import { decryptViewKey } from './viewkey.js'
import { freshLwsTransactions } from './lwsCursor.js'

// monero-lws REST client (Task 3 / spec §5).
//
// This is the single network boundary between StasherNews and the chain.
// Two consumers: the worker (confirmFinalizer / rewardsWalletObserver)
// imports the `lwsClient` singleton directly, and the web/GraphQL layer gets
// it via the `monero` key on the Apollo context (see api/ssrApollo.js).
//
// Transport: the factory accepts an injectable `transport` (the DI seam used
// by the test suite) defaulting to a real node:https/http-backed transport
// built here. The real transport honours MONERO_LWS_INSECURE_TLS (dev/stagenet
// self-signed certs ONLY — never set in prod). No third-party HTTP dependency
// is required: node:https.Agent rejectUnauthorized gives native TLS gating and
// the injected fake transports in tests share the {status, ok, text()} shape.
//
// Security: the private view key traverses the wire on every wallet call
// (lws per-request body auth). View keys are decrypted in-process from the
// encrypted envelope stored on MoneroViewKey via decryptViewKey (Task 2) and
// are NEVER logged and NEVER included in error messages — see the redacted
// error classes below.

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BACKOFF_BASE_MS = 500
const DEFAULT_WALLET_URL = 'https://0.0.0.0:8443'
const DEFAULT_ADMIN_URL = 'https://0.0.0.0:8081/admin'

// lws returns piconero amounts as JSON strings (safe_uint64). These are the
// fields parseAmounts() promotes to BigInt. blockchain_height / id / height /
// mixin / recipient.{maj_i,min_i} are plain JSON numbers and are left alone.
const AMOUNT_FIELDS = ['total_received', 'total_sent', 'fee', 'amount', 'locked_funds']

// Redacted errors: reference the endpoint path + status/code only. The request
// body (which carries the view key) is never attached to an error or logged.
export class LwsHttpError extends Error {
  constructor (url, status) {
    super(`monero-lws ${safePath(url)} returned HTTP ${status}`)
    this.name = 'LwsHttpError'
    this.url = url
    this.status = status
  }
}

class LwsTimeoutError extends Error {
  constructor (url, timeoutMs) {
    super(`monero-lws ${safePath(url)} timed out after ${timeoutMs}ms`)
    this.name = 'LwsTimeoutError'
    this.url = url
    this.timeoutMs = timeoutMs
  }
}

class LwsNetworkError extends Error {
  constructor (url, cause) {
    const code = cause && cause.code ? ` (${cause.code})` : ''
    super(`monero-lws ${safePath(url)} network error${code}`)
    this.name = 'LwsNetworkError'
    this.url = url
    this.cause = cause
  }
}

function safePath (url) {
  try { return new URL(url).pathname || '<lws>' } catch { return '<lws>' }
}

function readEnv (name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function readBoolEnv (name, fallback) {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return v === '1' || v.toLowerCase() === 'true'
}

function readIntEnv (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

// Real transport on node:https/http. TLS gating: rejectUnauthorized is the
// native knob — flipped ONLY when MONERO_LWS_INSECURE_TLS=true (dev/stagenet).
// Honours an AbortSignal so the client's response timeout can destroy a hung
// request. Returns { status, ok, text, headers } to match fetch's subset.
function makeTransport ({ insecureTls }) {
  const agent = new https.Agent({ rejectUnauthorized: !insecureTls, keepAlive: true })
  return function transport (url, { method = 'POST', headers = {}, body, signal } = {}) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https://') ? https : http
      const reqHeaders = { 'content-type': 'application/json', accept: 'application/json', ...headers }
      if (body !== undefined && body !== null) reqHeaders['content-length'] = Buffer.byteLength(body)
      const req = lib.request(url, {
        method,
        headers: reqHeaders,
        agent
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: async () => text,
            headers: res.headers
          })
        })
      })
      req.on('error', reject)
      if (signal) {
        if (signal.aborted) req.destroy(new Error('aborted'))
        else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
      }
      if (body !== undefined && body !== null) req.write(body)
      req.end()
    })
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Exponential backoff with jitter. `attempt` is 0-based (the Nth retry).
function backoffDelay (attempt, base) {
  const exp = base * (2 ** attempt)
  return exp + Math.floor(Math.random() * base)
}

function isRetryableStatus (status) {
  return status === 429 || status >= 500
}

function stripUndefined (obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

function parseJsonText (text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

// Promote declared piconero amount fields (JSON strings) to BigInt. Other
// fields are passed through verbatim so callers (the reorg reconciler in
// Task 6) see the full response shape.
function parseAmounts (obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = { ...obj }
  for (const f of AMOUNT_FIELDS) {
    const v = out[f]
    if (typeof v === 'string') out[f] = BigInt(v)
  }
  return out
}

// Normalise one /get_address_txs transaction object: BigInt amounts, and
// omitted mempool fields (height, timestamp) / optional payment_id -> null.
//
// The per-tx amount is exposed as `piconeros` (the domain column on
// ObservedTip and what the Task 4 indexer / brief's test sketch read), NOT
// lws's wire name `total_received`. Only this per-tx amount is renamed; the
// account-level lifetime `total_received` returned by /get_address_info and
// the top-level balance in parseAddressTxs is a different value and stays.
function parseTx (tx) {
  const parsed = parseAmounts(tx)
  const out = {
    ...parsed,
    height: parsed.height ?? null,
    timestamp: parsed.timestamp ?? null,
    payment_id: parsed.payment_id ?? null,
    recipient: parsed.recipient ? { maj_i: parsed.recipient.maj_i, min_i: parsed.recipient.min_i } : null,
    spent_outputs: parsed.spent_outputs ?? []
  }
  // Rename the per-tx amount from lws's wire name to the domain column, dropping
  // the wire name so the value isn't present under two keys. parseAmounts
  // already promoted the JSON string to BigInt.
  if ('total_received' in out) {
    out.piconeros = out.total_received
    delete out.total_received
  }
  return out
}

function parseAddressTxs (raw) {
  if (!raw) return raw
  const out = { ...raw }
  if (typeof out.total_received === 'string') out.total_received = BigInt(out.total_received)
  out.transactions = Array.isArray(raw.transactions) ? raw.transactions.map(parseTx) : []
  // Validate before any consumer sees the rows: malformed metadata rejects the
  // whole response (a null cursor makes this a pure validation pass).
  freshLwsTransactions(out.transactions, null)
  return out
}

/**
 * Build an lws client.
 *
 * @param {object} [options]
 * @param {string} [options.walletUrl]   MONERO_LWS_URL (wallet REST base).
 * @param {string} [options.adminUrl]    MONERO_LWS_ADMIN_URL (admin REST base).
 * @param {string} [options.adminAuth]   MONERO_LWS_ADMIN_AUTH (admin key; '' under --disable-admin-auth).
 * @param {boolean} [options.insecureTls] MONERO_LWS_INSECURE_TLS — dev/stagenet self-signed certs only.
 * @param {number} [options.timeoutMs]   MONERO_LWS_TIMEOUT_MS (per-attempt response timeout; default 15000).
 * @param {number} [options.maxRetries]  MONERO_LWS_MAX_RETRIES (transient retries; default 3).
 * @param {number} [options.backoffBaseMs] Base for exponential backoff (default 500).
 * @param {function} [options.transport] Injected transport (DI for tests).
 * @returns {object} `{ getAddressTxs, getAddressInfo, upsertSubaddrs, addAccount, modifyAccountStatus, addWebhook, deleteWebhook, deleteAddressWebhooks, listWebhooks, listAccounts }`
 */
export function createLwsClient (options = {}) {
  const walletUrl = (options.walletUrl ?? readEnv('MONERO_LWS_URL', DEFAULT_WALLET_URL)).replace(/\/$/, '')
  const adminUrl = (options.adminUrl ?? readEnv('MONERO_LWS_ADMIN_URL', DEFAULT_ADMIN_URL)).replace(/\/$/, '')
  const adminAuth = options.adminAuth ?? readEnv('MONERO_LWS_ADMIN_AUTH', '')
  const insecureTls = options.insecureTls ?? readBoolEnv('MONERO_LWS_INSECURE_TLS', false)
  const timeoutMs = options.timeoutMs ?? readIntEnv('MONERO_LWS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
  const maxRetries = options.maxRetries ?? readIntEnv('MONERO_LWS_MAX_RETRIES', DEFAULT_MAX_RETRIES)
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
  const transport = options.transport ?? makeTransport({ insecureTls })

  // One request with timeout + backoff. Wallet bodies are the login/params
  // object directly; admin bodies are wrapped {auth, params}. Endpoints without
  // a body pass bodyObj = null and method = 'GET' — no body is serialized and
  // the transport does not write one.
  async function request (url, bodyObj, { admin = false, method = 'POST', retry500 = true } = {}) {
    const hasBody = bodyObj != null
    const wrapped = admin ? { ...(adminAuth ? { auth: adminAuth } : {}), params: bodyObj } : bodyObj
    const body = hasBody ? JSON.stringify(stripUndefined(wrapped)) : undefined
    let lastNetworkCause = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffDelay(attempt - 1, backoffBaseMs))
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      let res
      try {
        res = await transport(url, { method, body, signal: ac.signal })
      } catch (err) {
        clearTimeout(timer)
        // Our own timeout fired -> transient; retry, else surface a timeout error.
        if (ac.signal.aborted) {
          if (attempt < maxRetries) continue
          throw new LwsTimeoutError(url, timeoutMs)
        }
        // Any other transport throw is a network error -> transient.
        lastNetworkCause = err
        if (attempt < maxRetries) continue
        throw new LwsNetworkError(url, err)
      }
      clearTimeout(timer)
      if (res.ok) return parseJsonText(await res.text())
      // Callers can opt out of retrying 500s (deterministic validation
      // failures); 429 and other 5xx stay retryable.
      if (res.status === 500 && !retry500) throw new LwsHttpError(url, res.status)
      if (isRetryableStatus(res.status) && attempt < maxRetries) continue
      throw new LwsHttpError(url, res.status)
    }
    // Unreachable: the loop either returns or throws on its final iteration.
    if (lastNetworkCause) throw new LwsNetworkError(url, lastNetworkCause)
    throw new LwsHttpError(url, 0)
  }

  // Decrypt the account's view key from its stored envelope. Not retried:
  // a decrypt failure is a crypto/config/tamper bug, not a transient fault.
  function viewKeyFor (account) {
    if (!account || !account.viewKey) {
      throw new Error(`monero-lws: account ${account && account.id} is missing its viewKey relation`)
    }
    return decryptViewKey(account.viewKey)
  }

  function walletLogin (account) {
    return { address: account.address, view_key: viewKeyFor(account) }
  }

  /**
   * Primary indexer poll (reorg-safe incremental fetch).
   * `account` is a MoneroAccount row with its viewKey relation included.
   * @returns {Promise<{blockchain_height: number, total_received: BigInt, transactions: object[]}>}
   */
  async function getAddressTxs (account, sinceTxId, sinceBlockHash) {
    const body = { ...walletLogin(account) }
    if (sinceTxId !== undefined && sinceTxId !== null) body.since_tx_id = Number(sinceTxId)
    if (sinceBlockHash !== undefined && sinceBlockHash !== null) body.since_tx_block_hash = sinceBlockHash
    return parseAddressTxs(await request(`${walletUrl}/get_address_txs`, body))
  }

  /** Balance snapshot (used by the transparency page / platform wallet). */
  async function getAddressInfo (account) {
    return parseAmounts(await request(`${walletUrl}/get_address_info`, walletLogin(account)))
  }

  /** Register the author subaddress pool (idempotent explicit-index insert). */
  async function upsertSubaddrs (account, ranges) {
    const body = {
      ...walletLogin(account),
      subaddrs: Object.entries(ranges ?? { 0: [[0, 499]] }).map(([key, value]) => ({ key: Number(key), value })),
      get_all: true
    }
    return request(`${walletUrl}/upsert_subaddrs`, body)
  }

  async function listAccounts () {
    const res = await request(`${adminUrl}/list_accounts`, {}, { admin: true })
    const active = (res && res.active) || []
    const inactive = (res && res.inactive) || []
    return [
      ...active.map(a => ({ ...a, status: 'active' })),
      ...inactive.map(a => ({ ...a, status: 'inactive' }))
    ]
  }

  /** Admin: register an account in ACTIVE state. Idempotent on lws 0.3 —
   *  add_account 500s (empty body) on an already-registered address, so a 500 is
   *  followed by a single list_accounts check: if the address is present it's
   *  treated as success (re-activated if inactive); otherwise the 500 is
   *  re-thrown. The 500 is NOT retried at the transport layer (a parse
   *  rejection is deterministic; the idempotency fallback covers the
   *  genuinely-ambiguous already-registered case). */
  async function addAccount (address, viewKey) {
    try {
      return await request(`${adminUrl}/add_account`, { address, key: viewKey }, { admin: true, retry500: false })
    } catch (err) {
      if (err instanceof LwsHttpError && err.status === 500) {
        const existing = (await listAccounts()).find(a => a.address === address)
        if (existing) {
          if (existing.status !== 'active') await modifyAccountStatus([address], 'active')
          return
        }
      }
      throw err
    }
  }

  /** Admin: set status ('active'|'inactive'|'hidden') for a set of addresses. */
  async function modifyAccountStatus (addresses, status) {
    return request(`${adminUrl}/modify_account_status`, { status, addresses }, { admin: true })
  }

  /** Admin: roll the given accounts back to `height` and re-scan them.
   * Rolls back the accounts' stored output/spend rows above `height`
   * (storage::rescan -> change_height -> rollback_outputs/spends) so the
   * next scan pass re-inserts them from the chain. WRONG-PID REPAIR
   * procedure: rescan the RECIPIENT address
   * ONLY — during the re-scan just that account is below tip, so IT
   * decrypts the tx's encrypted payment id with its own derivation and
   * the re-stored row carries the CORRECT pid (webhooks + get_address_txs
   * agree again). Rescanning sender AND recipient TOGETHER replays the
   * shared-derivation bug: whichever account scans first wins again. */
  async function rescanAccounts (addresses, height) {
    return request(`${adminUrl}/rescan`, { height, addresses }, { admin: true })
  }

  // ---- webhook management (spec §4.3) --------------------------------------
  // lws pushes tx-confirmation callbacks at 0-conf (detection) and at each
  // confirmation up to the requested ceiling. Registration + cleanup are admin
  // REST calls that reuse the existing request() (Content-Length + auth-omission
  // fixes already applied via the admin wrapping in request()).

  /** Admin: register a tx-confirmation webhook for an address+payment-id pair. */
  async function addWebhook ({ type, url, address, paymentId, token, confirmations }) {
    return request(`${adminUrl}/webhook_add`, {
      type, url, address, payment_id: paymentId, token, confirmations
    }, { admin: true })
  }

  /** Admin: delete one or more webhooks by event id. */
  async function deleteWebhook (eventId) {
    return request(`${adminUrl}/webhook_delete_uuid`, {
      event_ids: Array.isArray(eventId) ? eventId : [eventId]
    }, { admin: true })
  }

  /** Admin: delete ALL webhooks for an address. */
  async function deleteAddressWebhooks (address) {
    return request(`${adminUrl}/webhook_delete`, { addresses: [address] }, { admin: true })
  }

  /** Admin: list all registered webhooks. */
  async function listWebhooks () {
    return request(`${adminUrl}/webhook_list`, {}, { admin: true })
  }

  return {
    getAddressTxs,
    getAddressInfo,
    upsertSubaddrs,
    listAccounts,
    addAccount,
    modifyAccountStatus,
    rescanAccounts,
    addWebhook,
    deleteWebhook,
    deleteAddressWebhooks,
    listWebhooks
  }
}

// Singleton: constructed once at module load from env config. The web/GraphQL
// layer receives this via the Apollo context (`monero` key, see api/ssrApollo.js);
// the worker imports it directly.
export const lwsClient = createLwsClient()
