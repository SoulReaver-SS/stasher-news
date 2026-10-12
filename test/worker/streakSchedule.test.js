/* eslint-env jest */
// Scheduled streak evaluations (Finding 2, 2026-10-12): the nightly 00:10 UTC
// run hit the 10s Prisma interactive transaction timeout while the rewards
// distribution was running, failed with P2028 before its first write, and —
// with retryLimit 0 — one user's day rollover was never applied. pg-boss now
// redelivers the job up to three times (60s base delay, backoff; migration
// 20261012100200_streak_job_retries) and worker/streak.js runScheduledStreak
// anchors every attempt to the job's ORIGINAL createdon (includeMetadata is
// already enabled for this queue), so a retry that lands after UTC midnight
// still evaluates the day the cron fired for. Timings around the two streak
// transactions are best-effort diagnostics: a success line is emitted only for
// transactions >= 1s, a failure line always, and the diagnostic never carries
// exception text or SQL parameters.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runScheduledStreak, advanceQuestStreak, evaluateQuestStreaks } from '@/worker/streak'
import { logInfo, logWarn } from '../../lib/logger'
import { notifyFlameAdvanced, notifyShieldUsed } from '../../lib/webPush'

jest.mock('../../lib/webPush', () => ({
  notifyFlameAdvanced: jest.fn(() => Promise.resolve()),
  notifyShieldUsed: jest.fn(() => Promise.resolve()),
  notifyStreakLost: jest.fn(() => Promise.resolve())
}))

jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

const MIGRATION_PATH = join(
  process.cwd(),
  'prisma/migrations/20261012100200_streak_job_retries/migration.sql'
)
const ANCHOR = new Date('2026-10-12T00:10:31.960Z')
const DAY = '2026-10-12'
const TIMING_FIELDS = ['userId', 'day', 'path', 'lockAcquireMs', 'transactionMs', 'outcome']
// 1s is the emission threshold; a margin above it keeps the slow tests honest.
const SLOW_MS = 1050
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  jest.clearAllMocks()
  // clearAllMocks keeps implementations; the logger is a plain no-op by
  // default so the best-effort tests can install their own.
  logInfo.mockImplementation(() => undefined)
  logWarn.mockImplementation(() => undefined)
})

// Fake client for the cleared-day advance path: an active FLAME run for
// `userId` with rewardLevel 1 (day 2 banks a POST). Everything the transaction
// reads is in place; nothing touches a database.
function advanceModels ({ userId = 7000, sleepMs = 0 } = {}) {
  const streak = { id: 700, userId, type: 'FLAME', endedAt: null, lastEvaluatedDay: null, goldActive: false, rewardLevel: 1 }
  let slept = false
  const tx = {
    // only the first call is the lock acquisition; the ladder reads must not
    // add the delay again
    $queryRaw: async () => {
      if (sleepMs && !slept) {
        slept = true
        await sleep(sleepMs)
      }
      return [{ id: userId }]
    },
    user: { findUnique: async () => ({ streak: 1 }), update: async () => ({}) },
    streak: {
      findFirst: async () => streak,
      create: async () => { throw new Error('unexpected streak.create') },
      update: async () => ({ ...streak, goldActive: false })
    }
  }
  return { $transaction: async fn => fn(tx) }
}

// Fake client for the missed-day settle path: no completions, one active run
// for the allowlisted `userId` with the shield armed, so the transaction
// consumes the shield and leaves the run running.
function missedModels ({ userId = 7000, sleepMs = 0, failWith = null } = {}) {
  const streak = { id: 700, userId, type: 'FLAME', endedAt: null, lastEvaluatedDay: null, goldActive: true }
  return {
    $queryRaw: async () => [],
    streak: { findMany: async () => [streak] },
    user: { findUnique: async () => ({ streak: 4 }) },
    $transaction: async fn => fn({
      $queryRaw: async () => {
        if (sleepMs) await sleep(sleepMs)
        return [{ id: userId }]
      },
      user: { findUnique: async () => ({ streak: 4 }), update: async () => ({}) },
      streak: {
        findFirst: async () => streak,
        update: async () => {
          if (failWith) throw failWith
          return { ...streak, goldActive: false }
        }
      }
    })
  }
}

describe('runScheduledStreak', () => {
  test('a retry uses the original creation date even after midnight', async () => {
    const evaluate = jest.fn().mockResolvedValue(undefined)
    const models = {}
    const job = { models, createdon: ANCHOR, evaluate }
    await runScheduledStreak(job)
    await runScheduledStreak(job)
    expect(evaluate).toHaveBeenNthCalledWith(1, { models, now: job.createdon })
    expect(evaluate).toHaveBeenNthCalledWith(2, { models, now: job.createdon })
  })

  test('rejects a missing creation time instead of evaluating a different day', async () => {
    for (const createdon of [null, undefined]) {
      const evaluate = jest.fn()
      await expect(runScheduledStreak({ models: {}, createdon, evaluate }))
        .rejects.toThrow('STREAK_JOB_CREATION_TIME_REQUIRED')
      expect(evaluate).not.toHaveBeenCalled()
    }
  })

  test('rejects an invalid creation time instead of evaluating a different day', async () => {
    for (const createdon of ['not-a-date', new Date('nope')]) {
      const evaluate = jest.fn()
      await expect(runScheduledStreak({ models: {}, createdon, evaluate }))
        .rejects.toThrow('STREAK_JOB_CREATION_TIME_INVALID')
      expect(evaluate).not.toHaveBeenCalled()
    }
  })

  test('forwards a P2028 transaction timeout to pg-boss unchanged', async () => {
    const error = new Error('Transaction API error: Transaction already closed')
    error.code = 'P2028'
    const evaluate = jest.fn().mockRejectedValue(error)
    // No in-process retry loop: pg-boss owns redelivery and must see the
    // original failure to schedule the next attempt.
    await expect(runScheduledStreak({ models: {}, createdon: ANCHOR, evaluate })).rejects.toBe(error)
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(evaluate).toHaveBeenCalledWith({ models: {}, now: ANCHOR })
  })
})

describe('streak retry policy migration', () => {
  test('adds three 60s-backoff retries to the schedule without touching its timing', () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8')
    const scheduleUpdate = migration.slice(
      migration.indexOf('UPDATE pgboss.schedule'),
      migration.indexOf('UPDATE pgboss.job')
    )
    const policy = scheduleUpdate.match(/\|\|\s*'([^']+)'::jsonb/)
    expect(policy).not.toBeNull()
    expect(JSON.parse(policy[1])).toEqual({ retryLimit: 3, retryDelay: 60, retryBackoff: true })
    expect(scheduleUpdate).toContain("WHERE name = 'streak'")
    // The daily 00:10 UTC cron row keeps its cron/timezone: only options merge.
    const setClause = scheduleUpdate.match(/SET[\s\S]*?WHERE/)[0]
    expect(setClause).not.toMatch(/cron|timezone|data/)
  })

  test('repairs only queued (created/retry) streak jobs and preserves the anchor data', () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8')
    const jobUpdate = migration.slice(migration.indexOf('UPDATE pgboss.job'))
    const set = jobUpdate.match(/SET retryLimit = (\d+), retryDelay = (\d+), retryBackoff = (true|false)/)
    expect(set).not.toBeNull()
    expect(Number(set[1])).toBe(3)
    expect(Number(set[2])).toBe(60)
    expect(set[3]).toBe('true')
    // Active, failed, expired, cancelled, completed and archived rows are never
    // rewritten: a running attempt keeps its captured timer and the incident's
    // failed row is not resurrected.
    expect(jobUpdate).toContain("state IN ('created', 'retry')")
    // Counters and the original creation time are never reset — createdon is
    // the evaluation-day anchor a redelivered retry must keep.
    expect(jobUpdate).not.toMatch(/retryCount\s*=/)
    expect(jobUpdate).not.toMatch(/createdOn\s*=/)
  })

  test('worker/index.js consumes the scheduled wrapper with creation metadata', () => {
    const index = readFileSync(join(process.cwd(), 'worker/index.js'), 'utf8')
    expect(index).toMatch(/import \{ runScheduledStreak \} from '\.\/streak'/)
    expect(index).toContain("boss.work('streak', { includeMetadata: true }, jobWrapper(runScheduledStreak))")
    expect(index).not.toContain('jobWrapper(evaluateQuestStreaks)')
  })
})

describe('streak transaction timings', () => {
  test('a slow committed advance logs the exact timing fields', async () => {
    const userId = 7001
    const models = advanceModels({ userId, sleepMs: SLOW_MS })
    await advanceQuestStreak({ models, userId, day: DAY })
    expect(logWarn).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledTimes(1)
    const [fields] = logInfo.mock.calls[0]
    expect(Object.keys(fields).sort()).toEqual([...TIMING_FIELDS].sort())
    expect(fields).toEqual({
      userId,
      day: DAY,
      path: 'advance',
      lockAcquireMs: expect.any(Number),
      transactionMs: expect.any(Number),
      outcome: 'committed'
    })
    // the measured lock interval includes network/event-loop delay; it is
    // lock ACQUISITION time, sampled around lockRewardUser
    expect(fields.lockAcquireMs).toBeGreaterThanOrEqual(SLOW_MS)
    expect(fields.transactionMs).toBeGreaterThanOrEqual(fields.lockAcquireMs)
  })

  test('a fast committed advance stays silent', async () => {
    const models = advanceModels({ userId: 7002 })
    await advanceQuestStreak({ models, userId: 7002, day: DAY })
    expect(logInfo).not.toHaveBeenCalled()
    expect(logWarn).not.toHaveBeenCalled()
  })

  test('a failing advance logs a failure without the exception text and rethrows', async () => {
    const secret = new Error('write failed: postgresql://sn:topsecret@db:5432/stackernews')
    const models = { $transaction: async () => { throw secret } }
    await expect(advanceQuestStreak({ models, userId: 7003, day: DAY })).rejects.toBe(secret)
    expect(logInfo).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledTimes(1)
    const [fields] = logWarn.mock.calls[0]
    expect(fields).toEqual({
      userId: 7003,
      day: DAY,
      path: 'advance',
      lockAcquireMs: null,
      transactionMs: expect.any(Number),
      outcome: 'failed'
    })
    const emitted = JSON.stringify(logWarn.mock.calls)
    expect(emitted).not.toContain('topsecret')
    expect(emitted).not.toContain('postgresql://')
  })

  test('a slow committed missed-day settle logs after commit and still dispatches', async () => {
    const userId = 7004
    const models = missedModels({ userId, sleepMs: SLOW_MS })
    await evaluateQuestStreaks({ models, userIds: [userId], now: new Date('2026-10-12T12:00:00.000Z') })
    expect(logWarn).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledTimes(1)
    const [fields] = logInfo.mock.calls[0]
    expect(fields).toEqual({
      userId,
      day: '2026-10-11',
      path: 'missed',
      lockAcquireMs: expect.any(Number),
      transactionMs: expect.any(Number),
      outcome: 'committed'
    })
    expect(fields.transactionMs).toBeGreaterThanOrEqual(SLOW_MS)
    // notification dispatch stays outside the transaction, after commit
    expect(notifyShieldUsed).toHaveBeenCalledTimes(1)
    expect(notifyShieldUsed).toHaveBeenCalledWith(userId)
  })

  test('a failing missed-day settle logs a failure without the exception text', async () => {
    const secret = new Error('shield update failed: password=topsecret')
    const userId = 7005
    const models = missedModels({ userId, failWith: secret })
    await expect(
      evaluateQuestStreaks({ models, userIds: [userId], now: new Date('2026-10-12T12:00:00.000Z') })
    ).rejects.toBe(secret)
    expect(logInfo).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledTimes(1)
    const [fields] = logWarn.mock.calls[0]
    expect(fields).toEqual({
      userId,
      day: '2026-10-11',
      path: 'missed',
      lockAcquireMs: expect.any(Number),
      transactionMs: expect.any(Number),
      outcome: 'failed'
    })
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('topsecret')
    expect(notifyShieldUsed).not.toHaveBeenCalled()
  })

  test('a logger failure never masks a committed outcome', async () => {
    logInfo.mockImplementation(() => { throw new Error('logger down') })
    const userId = 7006
    const models = advanceModels({ userId, sleepMs: SLOW_MS })
    const notification = await advanceQuestStreak({ models, userId, day: DAY })
    expect(notification?.kind).toBe('advanced')
  })

  test('a logger failure never masks a transaction failure', async () => {
    logWarn.mockImplementation(() => { throw new Error('logger down') })
    const secret = new Error('boom')
    const models = { $transaction: async () => { throw secret } }
    await expect(advanceQuestStreak({ models, userId: 7007, day: DAY })).rejects.toBe(secret)
  })

  test('an allowlisted user with no user row is a no-op', async () => {
    const models = {
      $queryRaw: async () => [{ userId: 999 }],
      streak: { findMany: async () => [] },
      user: { findUnique: async () => null },
      $transaction: jest.fn()
    }
    await expect(evaluateQuestStreaks({ models, userIds: [999] })).resolves.toBeUndefined()
    expect(models.$transaction).not.toHaveBeenCalled()
    expect(notifyFlameAdvanced).not.toHaveBeenCalled()
    expect(notifyShieldUsed).not.toHaveBeenCalled()
  })
})
