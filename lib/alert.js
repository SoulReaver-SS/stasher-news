import { logInfo, logWarn, logError } from './logger.js'

const VALID_LEVELS = new Set(['info', 'warn', 'critical'])
const DEDUPE_TTL_MS = 5 * 60 * 1000
const POST_TIMEOUT_MS = 10_000
const DEDUPE_PRUNE_AT = 256
const DEDUPE_MAX_ENTRIES = 1024
const MAX_POST_ATTEMPTS = 3
const RETRY_AFTER_MAX_MS = 5000

const dedupeStore = new Map()
const inFlight = new Map()

function shouldDedupe (dedupeKey) {
  if (!dedupeKey) return false
  const now = Date.now()
  if (dedupeStore.size > DEDUPE_PRUNE_AT) {
    for (const [k, exp] of dedupeStore) {
      if (exp <= now) dedupeStore.delete(k)
    }
  }
  const expiry = dedupeStore.get(dedupeKey)
  if (expiry && expiry > now) return true
  return false
}

function rememberDelivery (dedupeKey) {
  dedupeStore.delete(dedupeKey)
  dedupeStore.set(dedupeKey, Date.now() + DEDUPE_TTL_MS)
  while (dedupeStore.size > DEDUPE_MAX_ENTRIES) dedupeStore.delete(dedupeStore.keys().next().value)
}

function buildPayload (channel, level, title, body) {
  const tag = level.toUpperCase()
  const bodyStr = body ?? ''
  switch (channel) {
    case 'discord':
      return { content: `[${tag}] ${title}\n${bodyStr}` }
    case 'telegram':
      return {
        chat_id: process.env.ALERT_TELEGRAM_CHAT_ID || '',
        text: `[${tag}] *${title}*\n${bodyStr}`,
        parse_mode: 'Markdown'
      }
    case 'email':
      return { subject: `[${tag}] ${title}`, text: bodyStr, level }
    case 'slack':
    default:
      return { text: `[${tag}] ${title}\n${bodyStr}` }
  }
}

// Lib-level delivery outcome (Finding 2): true only when the POST received an
// OK response; false on a non-OK status, a caught transport error, or any skip
// path. Existing callers ignore the return value; jobExpiryMonitor marks a job
// notified only on a literal true so a transient alert-channel outage cannot
// permanently suppress that job's alarm.
function retryAfterMs (res) {
  const header = res.headers?.get?.('retry-after')
  if (!header) return 0
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, RETRY_AFTER_MAX_MS)) : 0
}

async function postAttempt (url, payload) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  try {
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    // No response payload is needed; release its connection without letting
    // cleanup errors change an already-observed acknowledgement.
    try { await res.body?.cancel() } catch { /* acknowledgement still counts */ }
    return { ok: res.ok, status: res.status, retryable: res.status === 408 || res.status === 429 || res.status >= 500, retryAfterMs: retryAfterMs(res) }
  } catch {
    // Transport errors can include secret webhook URLs and payload material.
    return { ok: false, retryable: true, reason: controller.signal.aborted ? 'timeout' : 'transport' }
  } finally {
    clearTimeout(timer)
  }
}

async function postAlert (url, payload) {
  for (let attempt = 1; attempt <= MAX_POST_ATTEMPTS; attempt++) {
    const result = await postAttempt(url, payload)
    if (result.ok) return true
    if (!result.retryable || attempt === MAX_POST_ATTEMPTS) {
      logError('alert:delivery-failed', { attempts: attempt, status: result.status, reason: result.reason ?? 'http-status' })
      return false
    }
    const backoff = 500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250)
    await new Promise(resolve => setTimeout(resolve, Math.max(backoff, result.retryAfterMs ?? 0)))
  }
}

export function alert (level, title, body, opts = {}) {
  const { dedupeKey } = opts
  const url = process.env.ALERT_WEBHOOK_URL
  if (!url) {
    logInfo('alert:skip', { reason: 'ALERT_WEBHOOK_URL unset', level, title })
    return false
  }
  if (!VALID_LEVELS.has(level)) {
    logWarn('alert:invalid-level', { level })
    return false
  }
  if (dedupeKey && inFlight.has(dedupeKey)) return inFlight.get(dedupeKey)
  if (shouldDedupe(dedupeKey)) {
    logInfo('alert:deduped', { dedupeKey, level, title })
    return false
  }
  const channel = (process.env.ALERT_CHANNEL || 'slack').toLowerCase()
  const payload = buildPayload(channel, level, title, body)
  // Reserve before starting fetch: concurrent delivery-aware callers share
  // the real outcome, and a synchronous fetch failure cannot strand the key.
  const delivery = Promise.resolve().then(() => postAlert(url, payload)).then(ok => {
    if (ok && dedupeKey) rememberDelivery(dedupeKey)
    return ok
  }).finally(() => {
    if (dedupeKey && inFlight.get(dedupeKey) === delivery) inFlight.delete(dedupeKey)
  })
  if (dedupeKey) inFlight.set(dedupeKey, delivery)
  return delivery
}

export function __clearDedupe () {
  dedupeStore.clear()
  inFlight.clear()
}

export { DEDUPE_TTL_MS }
