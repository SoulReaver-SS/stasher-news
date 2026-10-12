-- Give every rewardsDistributor job an explicit four-hour execution budget and
-- no automatic retries (Finding 3). pg-boss 9 defaults jobs to a 15-minute
-- expireIn (pgboss.job.expirein); the 2026-10-12 weekly run exceeded that after
-- ~23 minutes, so pg-boss marked the job failed while the handler ran on to
-- completion. A retried distribution could double-pay (QUEUED RewardPayouts
-- are not re-runnable end-to-end), so retryLimit is pinned to 0 — with
-- retryDelay 0 and retryBackoff false, because in pg-boss 9 a nonzero
-- retryDelay implies a retry even when the supplied limit is 0
-- (node_modules/pg-boss/src/attorney.js applyRetryConfig).
--
-- pg-boss ignores expiry/retry options passed to work(), and cron runs send the
-- schedule row's options straight into send() (src/timekeeper.js onSendIt), so
-- the policy has to be applied at job-creation time: this migration repairs the
-- existing cron row and already-queued jobs, worker/rewardsDistributorSchedule.js
-- covers the fresh-install seed. The JSON policy below MUST stay identical to
-- REWARDS_DISTRIBUTOR_JOB_OPTIONS in that file (pinned by
-- test/worker/rewardsDistributorSchedule.test.js).

-- Merge the policy into the schedule row's options. Every alternate expiry
-- representation is removed first so a stale key can neither win the merge nor
-- resurface; unrelated options and the cron are preserved.
UPDATE pgboss.schedule
SET options = (coalesce(options, '{}'::jsonb)
    - 'expireIn' - 'expireInSeconds' - 'expireInMinutes' - 'expireInHours')
    || '{"expireInHours":4,"retryLimit":0,"retryDelay":0,"retryBackoff":false}'::jsonb,
    updated_on = now()
WHERE name = 'rewardsDistributor';

-- Repair the already-queued seeds (created/retry only). Active, failed,
-- expired, cancelled, completed and archived rows are deliberately untouched:
-- a running handler already captured its timer, and a retried rewards run
-- could double-pay.
UPDATE pgboss.job
SET expireIn = interval '4 hours', retryLimit = 0, retryDelay = 0, retryBackoff = false
WHERE name = 'rewardsDistributor' AND state IN ('created', 'retry');
