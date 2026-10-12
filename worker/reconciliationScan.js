import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { iteratePaymentIdCandidates } from '@/api/monero/pidDecrypt'

const RECENT_MARGIN_MS = 2 * 60 * 60 * 1000

// Resolved promises/nextTick do not service the timers sharing this process.
export function createReconciliationCheckpoint ({ sliceMs = 10, now = () => performance.now(), yieldLoop = setImmediate } = {}) {
  let startedAt = now()
  return function checkpoint () {
    if (now() - startedAt < sliceMs) return null
    return yieldLoop().then(() => { startedAt = now() })
  }
}

export async function * scanRawPaymentIds (raws, viewKeyHex, checkpoint = createReconciliationCheckpoint()) {
  for (const raw of raws) {
    const pids = []
    for (const pid of iteratePaymentIdCandidates(raw.extra, viewKeyHex)) {
      if (pid !== null) pids.push(pid)
      const pause = checkpoint()
      if (pause) await pause
    }
    const pause = checkpoint()
    if (pause) await pause
    yield { raw, pids }
  }
}

// Block timestamps are untrusted hints, NOT a negative payment verdict.
// Keep all rows: a paid tx may carry a timestamp older than its checkout.
export function prioritizeRecentTransactions (transactions, tips) {
  const starts = tips.map(t => t.detectedAt == null ? NaN : new Date(t.detectedAt).getTime())
  if (!starts.length || starts.some(t => !Number.isFinite(t))) return transactions
  const floor = Math.min(...starts) - RECENT_MARGIN_MS
  const recent = []
  const older = []
  for (const row of transactions) {
    const timestamp = row.timestamp == null ? NaN : Date.parse(row.timestamp)
    if (!Number.isFinite(timestamp) || timestamp >= floor) recent.push(row)
    else older.push(row)
  }
  return recent.concat(older)
}
