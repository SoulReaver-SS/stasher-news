/* eslint-env jest */

// Unit tests for the pgboss deadline/expiry monitor (Finding 3). The 2026-10-12
// incident: the weekly rewardsDistributor handler outran pg-boss 9's 15-minute
// default expireIn, so the manager failed the queue row OUTSIDE the worker's
// jobWrapper — no handler exception, no operator alert. These tests pin the
// monitor's contract: detect manager `failed` rows whose output carries the
// `handler execution exceeded <ms>ms` message plus maintenance `expired` rows,
// alert once per job per process, never touch monetary state, and stay bounded.

import { createJobExpiryMonitor } from '@/worker/jobExpiryMonitor'
import { logWarn } from '../../lib/logger'

jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

const NOW = Date.parse('2026-10-12T05:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

const REWARDS_JOB = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'rewardsDistributor',
  state: 'failed',
  completedon: new Date('2026-10-12T00:15:18Z')
}

const STREAK_JOB = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'streak',
  state: 'expired',
  completedon: new Date('2026-10-12T00:10:02Z')
}

function monitorWith (rows, { alert = jest.fn().mockResolvedValue(true), now = () => NOW } = {}) {
  const monitor = createJobExpiryMonitor({ alert, now })
  const models = { $queryRaw: jest.fn().mockResolvedValue(rows) }
  return { monitor, models, alert }
}

beforeEach(() => {
  jest.clearAllMocks()
})

test('a manager expiry pages once without replaying monetary work', async () => {
  const doAlert = jest.fn().mockResolvedValue(true)
  const monitor = createJobExpiryMonitor({ alert: doAlert, now: () => Date.parse('2026-10-12T05:00:00Z') })
  const models = {
    $queryRaw: jest.fn().mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'rewardsDistributor',
        state: 'failed',
        completedon: new Date('2026-10-12T00:15:18Z')
      }
    ])
  }
  await monitor.check(models)
  await monitor.check(models)
  expect(doAlert).toHaveBeenCalledTimes(1)
  expect(doAlert).toHaveBeenCalledWith('critical', 'job rewardsDistributor exceeded execution budget',
    expect.stringContaining('inspect distribution and payout records before recovery'), expect.any(Object))
})

test('the same job seen again from the archive does not page twice', async () => {
  const alert = jest.fn().mockResolvedValue(true)
  const monitor = createJobExpiryMonitor({ alert, now: () => NOW })
  const models = { $queryRaw: jest.fn().mockResolvedValue([REWARDS_JOB]) }
  await monitor.check(models)
  // pg-boss archived the row: the scan (job UNION archive) returns the same ID.
  models.$queryRaw.mockResolvedValue([{ ...REWARDS_JOB, archivedon: new Date() }])
  await monitor.check(models)
  expect(alert).toHaveBeenCalledTimes(1)
})

test('a maintenance-expired streak job pages with its id, timestamp and the no-cancellation caveat', async () => {
  const { monitor, models, alert } = monitorWith([STREAK_JOB])
  await monitor.check(models)
  expect(alert).toHaveBeenCalledTimes(1)
  const [level, title, body, opts] = alert.mock.calls[0]
  expect(level).toBe('critical')
  expect(title).toBe('job streak exceeded execution budget')
  expect(body).toContain(STREAK_JOB.id)
  expect(body).toContain('2026-10-12T00:10:02.000Z')
  expect(body).toContain('does NOT prove the handler was cancelled')
  expect(opts).toEqual({ dedupeKey: `job-expiry-${STREAK_JOB.id}` })
})

test('a retryable retry row does not page and no queue or distribution row is touched', async () => {
  const alert = jest.fn()
  const monitor = createJobExpiryMonitor({ alert, now: () => NOW })
  const models = {
    $queryRaw: jest.fn().mockResolvedValue([{ ...REWARDS_JOB, state: 'retry' }]),
    rewardDistribution: { findMany: jest.fn(), update: jest.fn() },
    rewardPayout: { update: jest.fn() },
    $executeRaw: jest.fn()
  }
  await monitor.check(models)
  expect(alert).not.toHaveBeenCalled()
  expect(models.rewardDistribution.findMany).not.toHaveBeenCalled()
  expect(models.rewardDistribution.update).not.toHaveBeenCalled()
  expect(models.rewardPayout.update).not.toHaveBeenCalled()
  expect(models.$executeRaw).not.toHaveBeenCalled()
})

test('an alert failure does not advance past the row; the next scan retries it first', async () => {
  const alert = jest.fn()
    .mockRejectedValueOnce(new Error('webhook down'))
    .mockResolvedValue(true)
  const monitor = createJobExpiryMonitor({ alert, now: () => NOW })
  const models = { $queryRaw: jest.fn().mockResolvedValue([REWARDS_JOB, STREAK_JOB]) }
  await expect(monitor.check(models)).resolves.toBeUndefined()
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert.mock.calls[0][1]).toBe('job rewardsDistributor exceeded execution budget')
  await monitor.check(models)
  expect(alert).toHaveBeenCalledTimes(3)
  expect(alert.mock.calls[1][1]).toBe('job rewardsDistributor exceeded execution budget')
  expect(alert.mock.calls[2][1]).toBe('job streak exceeded execution budget')
})

test('a resolved false is not delivery: the job stays unmarked and the next check retries the alert', async () => {
  // Finding 2: lib/alert resolves false (without throwing) on a non-OK status,
  // a caught transport error, or a skipped post. The monitor must not mark a
  // job notified off that — otherwise a transient alert-channel outage
  // permanently suppresses the expiry alarm for the job.
  const alert = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
  const monitor = createJobExpiryMonitor({ alert, now: () => NOW })
  const models = { $queryRaw: jest.fn().mockResolvedValue([REWARDS_JOB, STREAK_JOB]) }

  // First tick: nothing was delivered, so nothing is marked.
  await monitor.check(models)
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert.mock.calls[0][1]).toBe('job rewardsDistributor exceeded execution budget')

  // Second tick: the SAME first row is retried (the scan never advances past an
  // undelivered alert); with delivery true both rows are marked as they page.
  await monitor.check(models)
  expect(alert).toHaveBeenCalledTimes(3)
  expect(alert.mock.calls[1][1]).toBe('job rewardsDistributor exceeded execution budget')
  expect(alert.mock.calls[2][1]).toBe('job streak exceeded execution budget')

  // Third tick: delivered rows are marked once and never re-alerted.
  await monitor.check(models)
  expect(alert).toHaveBeenCalledTimes(3)
})

test('reaching the 100-row cap warns about saturation instead of claiming exhaustiveness', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: 'streak',
    state: 'failed',
    completedon: new Date(NOW - 1000)
  }))
  const { monitor, models, alert } = monitorWith(rows)
  await monitor.check(models)
  expect(alert).toHaveBeenCalledTimes(100)
  expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('100-row cap'))
})

test('the scan selects only id/name/state/completedon, binds the 24h cutoff and never selects data or output', async () => {
  const { monitor, models } = monitorWith([REWARDS_JOB])
  await monitor.check(models)
  const [strings, ...values] = models.$queryRaw.mock.calls[0]
  const sql = strings.join('?')
  expect(sql).toMatch(/SELECT DISTINCT id, name, state, completedon/i)
  expect(sql).toMatch(/pgboss\.job/)
  expect(sql).toMatch(/pgboss\.archive/)
  expect(sql).toMatch(/name IN \('rewardsDistributor', 'streak'\)/)
  expect(sql).toMatch(/state = 'expired' OR/)
  expect(sql).toMatch(/output->>'message' LIKE 'handler execution exceeded %ms'/)
  expect(sql).toMatch(/archivedon >= \?/)
  expect(sql).toMatch(/ORDER BY completedon ASC, id ASC LIMIT 100/)
  // Never read job payloads (data) and never select arbitrary output columns.
  expect(sql).not.toMatch(/\bdata\b/i)
  expect(sql).not.toMatch(/output\s*(,|\))/i)
  expect(values.length).toBeGreaterThan(0)
  for (const value of values) {
    expect(value).toBeInstanceOf(Date)
    expect(value.getTime()).toBe(NOW - DAY_MS)
  }
})

test('a notification older than 24h is pruned so a repeated event pages again (restart/replay accepted)', async () => {
  let nowMs = NOW
  const alert = jest.fn().mockResolvedValue(true)
  const monitor = createJobExpiryMonitor({ alert, now: () => nowMs })
  const models = { $queryRaw: jest.fn().mockResolvedValue([REWARDS_JOB]) }
  await monitor.check(models)
  expect(alert).toHaveBeenCalledTimes(1)
  nowMs = NOW + DAY_MS + 60 * 60 * 1000
  await monitor.check(models)
  expect(alert).toHaveBeenCalledTimes(2)
})

test('the notified-id map is bounded at 1000 entries (oldest evicted, then observable again)', async () => {
  const alert = jest.fn().mockResolvedValue(true)
  const monitor = createJobExpiryMonitor({ alert, now: () => NOW })
  const id = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  const event = i => ({ id: id(i), name: 'streak', state: 'failed', completedon: new Date(NOW - 1000) })
  const scan = async i => monitor.check({ $queryRaw: jest.fn().mockResolvedValue([event(i)]) })
  for (let i = 0; i < 1000; i++) await scan(i)
  await scan(0)
  expect(alert).toHaveBeenCalledTimes(1000) // id 0 is still remembered at the cap
  await scan(1000) // one more distinct event evicts the oldest entry
  await scan(0)
  expect(alert).toHaveBeenCalledTimes(1002) // id 0 pages again after eviction
})
