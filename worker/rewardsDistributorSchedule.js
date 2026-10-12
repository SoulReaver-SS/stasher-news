// Execution policy for the weekly rewardsDistributor job.
//
// pg-boss 9 defaults every job to a 15-minute expireIn; the 2026-10-12
// production run exceeded that (~23 minutes), so pg-boss marked the job failed
// while the handler ran to completion. A retried distribution could double-pay
// (QUEUED RewardPayouts are not re-runnable end-to-end), so every rewards job
// gets an explicit four-hour budget and no automatic retries.
//
// pg-boss ignores expiry/retry options passed to work(), and cron runs send the
// schedule row's options straight into send() (node_modules/pg-boss/src/
// timekeeper.js onSendIt), so this policy is applied at job-creation time: the
// fresh-install seed here and the 20261012100100_rewards_job_execution_budget
// migration for the cron row and already-queued jobs. Do NOT spread
// BOSS_RETRY here: in pg-boss 9 a nonzero retryDelay implies a retry even when
// the supplied retryLimit is 0 (src/attorney.js applyRetryConfig), which is
// why retryDelay is pinned to 0 too.
export const REWARDS_DISTRIBUTOR_JOB_OPTIONS = Object.freeze({
  expireInHours: 4,
  retryLimit: 0,
  retryDelay: 0,
  retryBackoff: false
})

// Fresh-install seed only: the first payout needs a week of inflow to
// accumulate, so on a brand-new stack defer one run 7d (the cron then owns
// every subsequent week). The handler does NOT self-requeue, so this cannot
// create recurring double scheduling. `before: 'completed'` counts created,
// retry AND active jobs, so restarting during a live distribution cannot
// enqueue another seed. `sndev monero distribute` covers any out-of-band run.
export async function seedRewardsDistributor ({ boss }) {
  if (await boss.getQueueSize('rewardsDistributor', { before: 'completed' }) !== 0) return

  await boss.send('rewardsDistributor', {}, {
    ...REWARDS_DISTRIBUTOR_JOB_OPTIONS,
    startAfter: 7 * 24 * 60 * 60
  })
}
