/* eslint-env jest */
// The weekly rewardsDistributor run writes QUEUED RewardPayouts, so it is not
// safe to retry end-to-end; the production incident (2026-10-12) instead needs
// a budget long enough for a real run (23m observed) and no retry at all.
// pg-boss 9 ignores expiry/retry options passed to work() and cron runs send
// the schedule row's options straight into send() (src/timekeeper.js
// onSendIt), so the policy must live at job-creation time in three places that
// have to agree: the exported constant (fresh-install seed), the schedule row,
// and already-queued job rows. See worker/rewardsDistributorSchedule.js.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  REWARDS_DISTRIBUTOR_JOB_OPTIONS,
  seedRewardsDistributor
} from '@/worker/rewardsDistributorSchedule'

const MIGRATION_PATH = join(
  process.cwd(),
  'prisma/migrations/20261012100100_rewards_job_execution_budget/migration.sql'
)

test('the deferred rewards seed has a four-hour budget and no retries', async () => {
  const boss = {
    getQueueSize: jest.fn().mockResolvedValue(0),
    send: jest.fn().mockResolvedValue('job-id')
  }

  await seedRewardsDistributor({ boss })

  // before: 'completed' counts created + retry + active, so a restart during a
  // live distribution cannot enqueue another seed
  expect(boss.getQueueSize).toHaveBeenCalledWith('rewardsDistributor', { before: 'completed' })
  expect(boss.send).toHaveBeenCalledWith('rewardsDistributor', {}, {
    expireInHours: 4,
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: 7 * 24 * 60 * 60
  })
})

test('does not seed when a rewards job is already queued, retrying or active', async () => {
  for (const queued of [1, 3]) {
    const boss = {
      getQueueSize: jest.fn().mockResolvedValue(queued),
      send: jest.fn().mockResolvedValue('job-id')
    }

    await seedRewardsDistributor({ boss })

    expect(boss.getQueueSize).toHaveBeenCalledWith('rewardsDistributor', { before: 'completed' })
    expect(boss.send).not.toHaveBeenCalled()
  }
})

test('REWARDS_DISTRIBUTOR_JOB_OPTIONS is frozen with the zero-retry policy', () => {
  expect(REWARDS_DISTRIBUTOR_JOB_OPTIONS).toEqual({
    expireInHours: 4,
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false
  })
  expect(Object.isFrozen(REWARDS_DISTRIBUTOR_JOB_OPTIONS)).toBe(true)
})

test('the schedule migration pins the same policy and drops alternate expiry keys', () => {
  const migration = readFileSync(MIGRATION_PATH, 'utf8')
  const scheduleUpdate = migration.slice(
    migration.indexOf('UPDATE pgboss.schedule'),
    migration.indexOf('UPDATE pgboss.job')
  )
  const policy = scheduleUpdate.match(/\|\|\s*'([^']+)'::jsonb/)

  expect(policy).not.toBeNull()
  expect(JSON.parse(policy[1])).toEqual(REWARDS_DISTRIBUTOR_JOB_OPTIONS)
  // a stale alternate expiry key must not survive the merge
  for (const key of ['expireIn', 'expireInSeconds', 'expireInMinutes', 'expireInHours']) {
    expect(scheduleUpdate).toContain(`- '${key}'`)
  }
  expect(scheduleUpdate).toContain("WHERE name = 'rewardsDistributor'")
})

test('the migration repairs only created/retry rewards jobs with the same policy', () => {
  const migration = readFileSync(MIGRATION_PATH, 'utf8')
  const jobUpdate = migration.slice(migration.indexOf('UPDATE pgboss.job'))
  const set = jobUpdate.match(
    /SET expireIn = interval '(\d+) hours',\s*retryLimit = (\d+), retryDelay = (\d+), retryBackoff = (true|false)/
  )

  expect(set).not.toBeNull()
  expect(Number(set[1])).toBe(REWARDS_DISTRIBUTOR_JOB_OPTIONS.expireInHours)
  expect(Number(set[2])).toBe(REWARDS_DISTRIBUTOR_JOB_OPTIONS.retryLimit)
  expect(Number(set[3])).toBe(REWARDS_DISTRIBUTOR_JOB_OPTIONS.retryDelay)
  expect(set[4] === 'true').toBe(REWARDS_DISTRIBUTOR_JOB_OPTIONS.retryBackoff)
  // active, failed, expired, cancelled, completed and archived rows are never
  // rewritten: a running handler already captured its timer
  expect(jobUpdate).toContain("state IN ('created', 'retry')")
})

test('worker/index.js seeds through the helper, not the old inline send', () => {
  const index = readFileSync(join(process.cwd(), 'worker/index.js'), 'utf8')

  expect(index).toMatch(/import \{ seedRewardsDistributor \} from '\.\/rewardsDistributorSchedule'/)
  expect(index).toContain('await seedRewardsDistributor({ boss })')
  expect(index).not.toMatch(/boss\.send\('rewardsDistributor'/)
})
