/* eslint-env jest */
import { runHealthProbeOnce, healthProbe, persistHealthSnapshot, __resetStallState } from '@/worker/healthProbe'
import { logWarn } from '../../lib/logger'

// next/jest's SWC transform rewrites `@/` in import statements but NOT in
// jest.mock() specifiers, so the logger mock uses the repo-convention relative
// path that resolves to the same module (mirrors test/api/monero/rewards.test.js).
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

// The probe checks the two services independently: lws via the admin
// /list_accounts endpoint and monerod directly via JSON-RPC get_info.
function lwsUp () {
  return { listAccounts: async () => ({ active: [], inactive: [] }) }
}

function lwsDown () {
  return { listAccounts: async () => { throw new Error('lws network error sim') } }
}

function monerodUp (height) {
  return { getHeight: async () => height }
}

function monerodDown () {
  return { getHeight: async () => { throw new Error('monerod connection refused sim') } }
}

function alertCalls (mock, title) {
  return mock.mock.calls.filter(c => c[1] === title)
}

function opts (extras) {
  return { alert: jest.fn(), setStatus: jest.fn(), ...extras }
}

beforeEach(() => {
  __resetStallState()
})

test('healthy probe publishes status and fires no alert', async () => {
  const o = opts({ lwsClient: lwsUp(), daemonClient: monerodUp(1000), now: () => 0 })
  const res = await runHealthProbeOnce(o)
  expect(res).toEqual({ lwsOk: true, monerodOk: true, height: 1000, stalled: false })
  expect(o.setStatus).toHaveBeenCalledWith({
    lws: true,
    monerod: true,
    height: 1000,
    stalled: false,
    updatedAt: new Date(0).toISOString()
  })
  expect(o.alert).not.toHaveBeenCalled()
})

test('monerod down (get_info probe throws) triggers debounced critical alert, lws not faulted', async () => {
  const o = opts({ lwsClient: lwsUp(), daemonClient: monerodDown(), now: () => 0 })
  const res = await runHealthProbeOnce(o)
  expect(res).toEqual({ lwsOk: true, monerodOk: false, height: 0, stalled: false })
  expect(alertCalls(o.alert, 'monerod down')).toHaveLength(1)
  expect(alertCalls(o.alert, 'monerod down')[0][0]).toBe('critical')
  expect(alertCalls(o.alert, 'monerod down')[0][3]).toEqual({ dedupeKey: 'monerod-down' })
  expect(alertCalls(o.alert, 'lws down')).toHaveLength(0)
  expect(o.setStatus.mock.calls[0][0]).toMatchObject({ lws: true, monerod: false })
})

test('lws down (list_accounts throws) triggers critical alert, monerod probed independently', async () => {
  const o = opts({ lwsClient: lwsDown(), daemonClient: monerodUp(500), now: () => 0 })
  const res = await runHealthProbeOnce(o)
  expect(res).toEqual({ lwsOk: false, monerodOk: true, height: 500, stalled: false })
  expect(alertCalls(o.alert, 'lws down')).toHaveLength(1)
  expect(alertCalls(o.alert, 'lws down')[0][0]).toBe('critical')
  expect(alertCalls(o.alert, 'lws down')[0][3]).toEqual({ dedupeKey: 'lws-down' })
  expect(alertCalls(o.alert, 'monerod down')).toHaveLength(0)
  expect(o.setStatus.mock.calls[0][0]).toMatchObject({ lws: false, monerod: true })
})

test('both services down fires both critical alerts independently', async () => {
  const o = opts({ lwsClient: lwsDown(), daemonClient: monerodDown(), now: () => 0 })
  const res = await runHealthProbeOnce(o)
  expect(res).toEqual({ lwsOk: false, monerodOk: false, height: 0, stalled: false })
  expect(alertCalls(o.alert, 'lws down')).toHaveLength(1)
  expect(alertCalls(o.alert, 'monerod down')).toHaveLength(1)
  expect(o.setStatus.mock.calls[0][0]).toMatchObject({ lws: false, monerod: false })
})

test('height stall: unchanged height past MONEROD_STALL_THRESHOLD_MS triggers stall alert', async () => {
  const threshold = 10 * 60 * 1000
  const o = opts({ lwsClient: lwsUp(), daemonClient: monerodUp(5000), stallThresholdMs: threshold })
  await runHealthProbeOnce({ ...o, now: () => 0 })
  expect(alertCalls(o.alert, 'monerod stalled')).toHaveLength(0)
  const res = await runHealthProbeOnce({ ...o, now: () => threshold + 1 })
  expect(res.stalled).toBe(true)
  expect(alertCalls(o.alert, 'monerod stalled')).toHaveLength(1)
  expect(alertCalls(o.alert, 'monerod stalled')[0][0]).toBe('critical')
  expect(alertCalls(o.alert, 'monerod stalled')[0][3]).toEqual({ dedupeKey: 'monerod-stall' })
  expect(o.setStatus.mock.calls[1][0]).toMatchObject({ stalled: true, monerod: false, height: 5000 })
})

test('height advancement resets the stall window (no stall alert)', async () => {
  const threshold = 10 * 60 * 1000
  const o = opts({ lwsClient: lwsUp(), daemonClient: monerodUp(5000), stallThresholdMs: threshold })
  await runHealthProbeOnce({ ...o, now: () => 0 })
  const res = await runHealthProbeOnce({ ...o, daemonClient: monerodUp(5001), now: () => threshold + 1 })
  expect(res.stalled).toBe(false)
  expect(alertCalls(o.alert, 'monerod stalled')).toHaveLength(0)
})

test('monerod outage rebaselines the stall window so recovery is not misread as a stall', async () => {
  const threshold = 10 * 60 * 1000
  const o = opts({ lwsClient: lwsUp(), daemonClient: monerodUp(5000), stallThresholdMs: threshold })
  await runHealthProbeOnce({ ...o, now: () => 0 })
  await runHealthProbeOnce({ ...o, daemonClient: monerodDown(), now: () => threshold })
  const res = await runHealthProbeOnce({ ...o, daemonClient: monerodUp(5000), now: () => threshold * 2 + 1 })
  expect(res.stalled).toBe(false)
  expect(alertCalls(o.alert, 'monerod stalled')).toHaveLength(0)
})

// --- healthProbe() job wrapper: the HealthSnapshot persist seam (worker -> DB
// -> app bridge). The wrapper runs the probe, then upserts row id=1 through the
// injectable persist fn; a persist failure is logged, never fails the job. ---

const wrapperOpts = () => ({
  lwsClient: lwsUp(),
  daemonClient: monerodUp(1000),
  alert: jest.fn(),
  setStatus: jest.fn(),
  now: () => 0
})

test('healthProbe persists the probe result through the injectable persist seam', async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  await healthProbe({ persist, ...wrapperOpts() })
  expect(persist).toHaveBeenCalledTimes(1)
  expect(persist).toHaveBeenCalledWith({ lwsOk: true, monerodOk: true, height: 1000, stalled: false })
})

test('healthProbe persists a degraded result exactly as the probe returned it', async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  await healthProbe({ persist, ...wrapperOpts(), lwsClient: lwsDown(), daemonClient: monerodUp(500) })
  expect(persist).toHaveBeenCalledWith({ lwsOk: false, monerodOk: true, height: 500, stalled: false })
})

test('a persist failure never fails the healthProbe job (logged, swallowed)', async () => {
  const persist = jest.fn().mockRejectedValue(new Error('db down'))
  await expect(healthProbe({ persist, ...wrapperOpts() })).resolves.toBeUndefined()
  expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('HealthSnapshot persist failed'), expect.any(Error))
})

test('persistHealthSnapshot upserts row id=1 with the probe fields (balance columns untouched)', async () => {
  const models = { healthSnapshot: { upsert: jest.fn().mockResolvedValue({}) } }
  await persistHealthSnapshot(models, { lwsOk: false, monerodOk: true, height: 77, stalled: false })
  expect(models.healthSnapshot.upsert).toHaveBeenCalledWith({
    where: { id: 1 },
    create: { id: 1, lws: false, monerod: true, height: 77, stalled: false },
    update: { lws: false, monerod: true, height: 77, stalled: false }
  })
})

// --- healthProbe() job wrapper: the pgboss expiry-monitor seam. The monitor
// rides the same 60s tick (no new schedule) and must not be suppressed by — or
// suppress — the HealthSnapshot persist. ---

test('the pgboss expiry monitor runs even when the lws and monerod probes are down', async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  const monitorJobs = jest.fn().mockResolvedValue(undefined)
  await healthProbe({ persist, monitorJobs, ...wrapperOpts(), lwsClient: lwsDown(), daemonClient: monerodDown() })
  expect(monitorJobs).toHaveBeenCalledTimes(1)
  expect(persist).toHaveBeenCalledWith({ lwsOk: false, monerodOk: false, height: 0, stalled: false })
})

test('a monitor failure does not skip snapshot persistence (fixed-category log, job stays green)', async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  const monitorJobs = jest.fn().mockRejectedValue(new Error('pgboss scan failed'))
  await expect(healthProbe({ persist, monitorJobs, ...wrapperOpts() })).resolves.toBeUndefined()
  expect(persist).toHaveBeenCalledTimes(1)
  // The snapshot write is not gated on the scan: it is attempted (and here
  // completes) before the failing monitor action runs.
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(monitorJobs.mock.invocationCallOrder[0])
  expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('job expiry monitor failed'))
})

test('a persistence failure does not skip the pgboss expiry monitor', async () => {
  const persist = jest.fn().mockRejectedValue(new Error('db down'))
  const monitorJobs = jest.fn().mockResolvedValue(undefined)
  await expect(healthProbe({ persist, monitorJobs, ...wrapperOpts() })).resolves.toBeUndefined()
  expect(monitorJobs).toHaveBeenCalledTimes(1)
})

test('the production monitor seam scans pgboss expirations when worker models are supplied', async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  const models = { $queryRaw: jest.fn().mockResolvedValue([]) }
  await healthProbe({ persist, models, ...wrapperOpts() })
  expect(persist).toHaveBeenCalledTimes(1)
  expect(models.$queryRaw).toHaveBeenCalledTimes(1)
})

test('without worker models the production monitor seam no-ops (job stays green)', async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  logWarn.mockClear()
  await expect(healthProbe({ persist, ...wrapperOpts() })).resolves.toBeUndefined()
  expect(persist).toHaveBeenCalledTimes(1)
  expect(logWarn).not.toHaveBeenCalledWith(expect.stringContaining('job expiry monitor failed'))
})
