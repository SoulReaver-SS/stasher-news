import { lwsClient } from '@/api/monero/lwsClient'
import { daemonClient } from '@/api/monero/daemonClient'
import { alert } from '@/lib/alert'
import { setHealthStatus } from '@/lib/healthStatus'
import { logWarn } from '@/lib/logger'
import { moneroLwsUp, moneroMonerodUp, moneroMonerodHeight } from '@/lib/metrics'
import createPrisma from '@/lib/create-prisma'
import { monitorJobExpirations } from './jobExpiryMonitor'

// healthProbe (Task D4) — periodic lws + monerod health probe.
//
// A cron-owned pg-boss job (pgboss.schedule row healthProbe, every 60s) that
// probes the two services INDEPENDENTLY — lws via the admin /list_accounts
// endpoint and monerod directly via JSON-RPC get_info (api/monero/daemonClient,
// the same proven path confirmFinalizer and bounties use) — publishes the
// snapshot to lib/healthStatus, persists it to the HealthSnapshot row (the
// worker -> DB -> app bridge: the app process reads that row in /api/health and
// /api/metrics, since this process-local singleton is invisible across
// containers), and fires a debounced critical alert when either service is down
// or the chain height stops advancing.
//
// The probes are independent because lws does NOT proxy monerod state in the
// deployed build: GET /daemon_status returns 404 (see
// a finding documented internally). Each service's reachability is
// therefore observed directly, and each failure alerts independently — no
// "monerod unknowable through a dead lws" suppression is needed.
//
// Stall detection: a node can report a healthy height while silently frozen
// (e.g. a stuck peer set). We track the last seen height and the first instant
// we saw it; if it is unchanged for MONEROD_STALL_THRESHOLD_MS (default 10 min)
// we alert. The state is process-lifetime (the module loads once per worker) and
// is rebaselined whenever monerod returns from an outage.

const STALL_THRESHOLD_MS = Number(process.env.MONEROD_STALL_THRESHOLD_MS) || 10 * 60 * 1000

let lastHeight = null
let heightFirstSeenAt = null
let monerodConsecutiveMisses = 0

export function __resetStallState () {
  lastHeight = null
  heightFirstSeenAt = null
  monerodConsecutiveMisses = 0
}

export async function runHealthProbeOnce ({
  lwsClient: client = lwsClient,
  daemonClient: monerod = daemonClient,
  alert: doAlert = alert,
  setStatus = setHealthStatus,
  now = Date.now,
  stallThresholdMs = STALL_THRESHOLD_MS
} = {}) {
  const ts = now()
  let lwsOk = false
  let monerodOk = false
  let height = 0

  try {
    await client.listAccounts()
    lwsOk = true
  } catch (err) {
    logWarn('healthProbe: lws probe failed', err)
  }

  try {
    height = await monerod.getHeight()
    monerodOk = height > 0
  } catch (err) {
    logWarn('healthProbe: monerod probe failed', err)
  }

  let stalled = false
  if (monerodOk) {
    if (height === lastHeight) {
      if (heightFirstSeenAt !== null && (ts - heightFirstSeenAt) >= stallThresholdMs) {
        stalled = true
      }
    } else {
      lastHeight = height
      heightFirstSeenAt = ts
    }
  } else {
    lastHeight = null
    heightFirstSeenAt = null
  }

  setStatus({
    lws: lwsOk,
    monerod: monerodOk && !stalled,
    height,
    stalled,
    updatedAt: new Date(ts).toISOString()
  })

  moneroLwsUp.set(lwsOk ? 1 : 0)
  moneroMonerodUp.set(monerodOk && !stalled ? 1 : 0)
  moneroMonerodHeight.set(height || 0)

  if (!lwsOk) {
    doAlert('critical', 'lws down', 'monero-lws wallet endpoint unreachable', { dedupeKey: 'lws-down' })
  }
  monerodConsecutiveMisses = monerodOk ? 0 : Math.min(monerodConsecutiveMisses + 1, 2)
  if (!monerodOk && monerodConsecutiveMisses >= 2) {
    doAlert('critical', 'monerod down', 'monerod daemon unreachable (two consecutive get_info probes failed)', { dedupeKey: 'monerod-down' })
  }
  if (stalled) {
    doAlert('critical', 'monerod stalled', `chain height unchanged at ${height} for >= ${Math.round(stallThresholdMs / 1000)}s`, { dedupeKey: 'monerod-stall' })
  }

  return { lwsOk, monerodOk, height, stalled }
}

// The pgboss expiry monitor seam (Finding 3). The worker's jobWrapper spreads
// `args` (incl. `models`) into the job payload, so production supplies models
// and the default seam runs the module-singleton scan. Unit/CLI call sites
// without models skip the scan; tests inject their own monitorJobs.
async function defaultMonitorJobs (models) {
  if (!models) return
  await monitorJobExpirations(models)
}

export async function healthProbe ({
  persist = (result) => persistHealthSnapshot(undefined, result),
  monitorJobs = defaultMonitorJobs,
  models,
  ...probeOpts
} = {}) {
  // Recurrence is cron-owned (pgboss.schedule row healthProbe); no self-requeue.
  const result = await runHealthProbeOnce(probeOpts)
  try {
    await persist(result)
  } catch (err) {
    // The bridge write is best-effort: the in-process singleton + worker-side
    // gauges are already updated, and a failed persist must never fail the job
    // (the next 60s cycle retries; the app side just reads a stale row until
    // then, which its staleness window already handles).
    logWarn('healthProbe: HealthSnapshot persist failed — app-side gauges stale until the next cycle', err)
  }
  // The expiry monitor is an INDEPENDENT action awaited in its own try/catch:
  // it runs on every tick regardless of the lws/monerod verdicts (the probes
  // above already record those), a scan failure must not suppress the snapshot
  // persist, and a persist failure must not suppress the scan. Fixed-category
  // diagnostics only: the scan error text is never logged (it can carry SQL /
  // connection detail) and the monitor alerts on the incidents it finds.
  try {
    await monitorJobs(models)
  } catch {
    logWarn('healthProbe: job expiry monitor failed — pgboss expirations unobserved until the next cycle')
  }
}

// The worker -> DB leg of the bridge: upsert HealthSnapshot row id=1 with the
// probe result. Exported for tests; `models` is injectable there — production
// memoizes one Prisma client for the worker process lifetime (the probe fires
// every 60s, so per-call client create/disconnect would churn connections).
// The balance columns are owned by the rewards signer (setBalanceGauge) and are
// deliberately left untouched here.
let snapshotModels = null
export async function persistHealthSnapshot (models, { lwsOk, monerodOk, height, stalled }) {
  // NB: create-prisma destructures its (optional) options param without an
  // outer default, so it must be called with an explicit empty object.
  const db = models || (snapshotModels ||= createPrisma({}))
  await db.healthSnapshot.upsert({
    where: { id: 1 },
    create: { id: 1, lws: lwsOk, monerod: monerodOk, height, stalled },
    update: { lws: lwsOk, monerod: monerodOk, height, stalled }
  })
}
