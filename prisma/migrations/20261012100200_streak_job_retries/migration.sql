-- Bounded retries for the daily streak evaluation (Finding 2, 2026-10-12).
--
-- The nightly run just after 00:10 UTC evaluates the UTC day that just ended.
-- On 2026-10-12 it exceeded the 10-second Prisma interactive transaction
-- timeout while the rewards distribution was running, failed with P2028 before
-- its first write, and — because the job had retryLimit 0 — one user's day
-- rollover was never applied. pg-boss now owns redelivery: three retries after
-- the initial attempt, 60-second base delay, exponential backoff.
-- worker/streak.js runScheduledStreak anchors the evaluation to the job's
-- ORIGINAL createdon (includeMetadata is already enabled for this queue), so a
-- retry that lands after 00:00 UTC still evaluates the original day.
--
-- Recurring runs keep their exact schedule row (10 0 * * * UTC, empty data):
-- this migration only merges retry options into options. Terminal rows are
-- never touched — notably the incident's failed row is NOT resurrected; the
-- next occurrence of the schedule sends a fresh job.
UPDATE pgboss.schedule
SET options = coalesce(options, '{}'::jsonb)
    || '{"retryLimit":3,"retryDelay":60,"retryBackoff":true}'::jsonb,
    updated_on = now()
WHERE name = 'streak';

-- Repair already-queued streak jobs (created/retry only) so a restarted worker
-- picks them up with the same policy. Only the three retry columns change:
-- retryCount (delivery count), createdOn (the evaluation-day anchor) and the
-- payload are preserved. An active row keeps its captured timer and terminal
-- rows (failed/expired/cancelled/completed/archived) are left alone.
UPDATE pgboss.job
SET retryLimit = 3, retryDelay = 60, retryBackoff = true
WHERE name = 'streak' AND state IN ('created', 'retry');
