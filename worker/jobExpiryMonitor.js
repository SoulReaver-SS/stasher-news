import { alert } from '@/lib/alert'
import { logError, logWarn } from '@/lib/logger'

// jobExpiryMonitor (Finding 3) — independent observation of pgboss deadline
// failures/expirations for the two queues whose runs are long enough to outlive
// pg-boss's execution budget.
//
// 2026-10-12 incident: the weekly rewardsDistributor handler ran ~23 minutes
// against pg-boss 9's 15-minute default expireIn. The manager's timeout race
// (`node_modules/pg-boss/src/manager.js`, message `handler execution exceeded
// <ms>ms`) failed the queue row OUTSIDE the worker's jobWrapper, so no handler
// exception reached the permanent-failure alert — the run completed, the row
// read `failed`, and nobody was paged. Tasks 2's 4-hour budget removes the
// known cause; this monitor is the independent backstop that observes BOTH
// pg-boss failure shapes for `rewardsDistributor` and `streak`:
//   - state 'failed' with output->>'message' LIKE 'handler execution exceeded
//     %ms' — the manager deadline race (the incident shape);
//   - state 'expired' — the maintenance sweep expiring an over-budget active
//     job (plans.expire).
//
// Properties:
//   - read-only: the query SELECTs four metadata columns and nothing here ever
//     touches a queue row, distribution row, payout journal, or signer. There
//     is no self-requeue and no new schedule — this rides the existing 60s
//     healthProbe tick.
//   - bounded: one 24h window, `LIMIT 100`, and a process-local Map of at most
//     1000 notified job ids pruned after 24h. A process restart may repeat one
//     recent alert; that is an accepted limitation (no persistence table).
//   - once per job id per process, and only after the alert chain reports
//     delivery (`true`): an undelivered alert — lib/alert resolving false on a
//     failed/skipped POST, or a rejecting injected double — leaves the row
//     unmarked, stops the scan before later rows, and the next cycle retries it
//     first. No row is ever skipped silently.
//   - no payloads: neither `data` nor arbitrary `output` is selected or
//     logged; `output` appears only as the exact message predicate in SQL, and
//     every diagnostic category below is fixed text.
//
// Escalation note: expiration does NOT prove the handler was cancelled or that
// any ledger write failed — the handler may have finished its money effects
// after the deadline. The alert body therefore tells the operator to inspect
// state (distribution/payout/journal for rewards) before any recovery; nothing
// is retried or replayed automatically.

const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000
const NOTIFIED_MAX = 1000
const SCAN_ROW_LIMIT = 100

function alertBody (row) {
  const completedAt = row.completedon instanceof Date ? row.completedon.toISOString() : String(row.completedon)
  const lines = [
    `pgboss job ${row.id} (queue ${row.name}, state '${row.state}') stopped being tracked by pg-boss at ${completedAt}.`,
    'pg-boss marked it when the execution deadline elapsed; that does NOT prove the handler was cancelled or that any ledger/distribution write failed — the run may have completed its effects or still be in flight.',
    row.name === 'rewardsDistributor'
      ? 'Rewards: inspect the payout journal, then inspect distribution and payout records before recovery. Never re-run the signer blindly — a QUEUED payout may already have been relayed.'
      : 'Streak: inspect the evaluation day state before re-running the job.'
  ]
  lines.push(`This monitor did not mutate the queue or any distribution/payout row. Alarm key job-expiry-${row.id} may repeat once after a worker restart.`)
  return lines.join(' ')
}

export function createJobExpiryMonitor ({ alert: doAlert = alert, now = Date.now } = {}) {
  // job id -> notified-at ms. Bounded (NOTIFIED_MAX) and pruned after 24h so a
  // long-lived worker cannot grow this without bound.
  const notifiedAt = new Map()

  function pruneNotified (ts) {
    for (const [id, at] of notifiedAt) {
      if (ts - at >= SCAN_WINDOW_MS) notifiedAt.delete(id)
    }
    while (notifiedAt.size > NOTIFIED_MAX) {
      notifiedAt.delete(notifiedAt.keys().next().value)
    }
  }

  async function check (models) {
    if (!models || typeof models.$queryRaw !== 'function') {
      throw new Error('jobExpiryMonitor: models.$queryRaw is required')
    }
    const ts = now()
    pruneNotified(ts)
    const cutoff = new Date(ts - SCAN_WINDOW_MS)
    // Tagged $queryRaw with ONE bound cutoff; the two queue names, the event
    // states, and the manager-failure message are fixed literals. The archive
    // leg is bounded by archivedon (its index) and completedon too. No `data`
    // and no arbitrary `output` is selected.
    const rows = await models.$queryRaw`
      SELECT DISTINCT id, name, state, completedon FROM (
        SELECT id, name, state, completedon FROM pgboss.job
        WHERE name IN ('rewardsDistributor', 'streak')
          AND completedon >= ${cutoff}
          AND (state = 'expired' OR
            (state = 'failed' AND output->>'message' LIKE 'handler execution exceeded %ms'))
        UNION ALL
        SELECT id, name, state, completedon FROM pgboss.archive
        WHERE name IN ('rewardsDistributor', 'streak')
          AND archivedon >= ${cutoff} AND completedon >= ${cutoff}
          AND (state = 'expired' OR
            (state = 'failed' AND output->>'message' LIKE 'handler execution exceeded %ms'))
      ) events ORDER BY completedon ASC, id ASC LIMIT 100`
    if (rows.length >= SCAN_ROW_LIMIT) {
      logWarn(`jobExpiryMonitor: expiry scan reached its ${SCAN_ROW_LIMIT}-row cap; later events in this 24h window are not observed — a queue is saturating its failure budget`)
    }
    for (const row of rows) {
      // SQL owns the queue-name and message filters; the state guard is
      // repeated here so a retryable 'retry' row (or any other state) can
      // never page an operator as an expiration.
      if (row?.state !== 'expired' && row?.state !== 'failed') continue
      const id = String(row.id)
      if (notifiedAt.has(id)) continue
      // Delivery-aware (Finding 2): lib/alert resolves false instead of
      // throwing when the POST failed or was skipped, so only a literal true
      // counts as notified. A rejecting injected/legacy double is caught and
      // treated the same way. See lib/alert.js.
      let delivered = false
      try {
        delivered = await doAlert('critical', `job ${row.name} exceeded execution budget`, alertBody(row), { dedupeKey: `job-expiry-${id}` })
      } catch {
        // Not delivered either — handled below.
      }
      if (delivered !== true) {
        // Leave the row unmarked and STOP the scan here: the next 60s cycle
        // retries this alert first (and only the alert — this monitor never
        // touches jobs, payouts, or any monetary state). Fixed-category
        // diagnostics only: alert/transport errors and responses can carry
        // arbitrary text. lib/alert retries transient POSTs itself and leaves
        // failed deliveries undeduped so the next monitor tick can retry.
        logError('jobExpiryMonitor: expiry alert delivery failed; the event stays unalerted and is retried first next cycle')
        return
      }
      notifiedAt.set(id, ts)
      pruneNotified(ts)
    }
  }

  return { check }
}

// Production singleton for the health probe. Constructed lazily (never at
// import time) so importing this module in tests/tooling cannot be broken by
// alert-channel configuration, and so one process lifetime shares the notified
// set. `models` is the worker's Prisma client (jobWrapper supplies it).
let productionMonitor = null
export function monitorJobExpirations (models) {
  productionMonitor ||= createJobExpiryMonitor({ alert, now: Date.now })
  return productionMonitor.check(models)
}
