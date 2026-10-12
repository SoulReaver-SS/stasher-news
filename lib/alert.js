import { logInfo, logWarn, logError } from './logger.js'

const VALID_LEVELS = new Set(['info', 'warn', 'critical'])
const DEDUPE_TTL_MS = 5 * 60 * 1000
const POST_TIMEOUT_MS = 10_000
const DEDUPE_PRUNE_AT = 256

const dedupeStore = new Map()

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
  dedupeStore.set(dedupeKey, now + DEDUPE_TTL_MS)
  return false
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
async function postAlert (url, payload) {
  try {
    const signal = typeof globalThis.AbortSignal?.timeout === 'function'
      ? globalThis.AbortSignal.timeout(POST_TIMEOUT_MS)
      : undefined
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    })
    if (!res.ok) {
      logError('alert:bad-status', { status: res.status })
      return false
    }
    return true
  } catch (err) {
    logError('alert:post-failed', err)
    return false
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
  if (shouldDedupe(dedupeKey)) {
    logInfo('alert:deduped', { dedupeKey, level, title })
    return false
  }
  const channel = (process.env.ALERT_CHANNEL || 'slack').toLowerCase()
  const payload = buildPayload(channel, level, title, body)
  return postAlert(url, payload)
}

export function __clearDedupe () {
  dedupeStore.clear()
}

export { DEDUPE_TTL_MS }
