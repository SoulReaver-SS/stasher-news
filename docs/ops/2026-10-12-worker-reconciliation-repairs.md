# Worker/reconciliation production repairs — deployment handoff

Date: 2026-10-12
Branch: `worker-reconciliation-repairs` — tip `d5dd5862`, base `7562cd4e`
Source plan: `docs/superpowers/plans/2026-10-12-worker-reconciliation-production-repairs.md`

Housekeeping: `docs/ops/` is gitignored (`.gitignore:35`); this handoff is
force-added there like its neighbours (`quest-boost-credit-rollout.md`,
`newsletter-runbook.md`), so the convention break stays discoverable from the
repo alone.

Everything under "Operator sequence" is a **future, separately authorized
production action** — none of it has been executed and the VPS was not touched
while building the repairs. Development verification is complete and recorded at
the bottom; do not re-run it on the VPS.

## Release at a glance

The dispatch's only migrations (all additive: `CREATE OR REPLACE`, a defensive
`CREATE INDEX IF NOT EXISTS`, and `pgboss` option-JSON merges; none touches
`schema.prisma`):

- `prisma/migrations/20261012100000_restore_user_name_search` — restores
  `public.search_users_by_name(text, real, integer)`, missing since the fork's
  baseline, so every user name search/autocomplete failed with SQLSTATE 42883.
- `prisma/migrations/20261012100100_rewards_job_execution_budget` — repairs the
  `rewardsDistributor` schedule row and queued `created`/`retry` jobs to a
  4-hour `expireIn` with zero retries (`retryDelay 0`, `retryBackoff false`).
- `prisma/migrations/20261012100200_streak_job_retries` — merges
  `retryLimit 3 / retryDelay 60 / retryBackoff true` into the `streak` schedule
  row and queued `created`/`retry` jobs.

Code-only in the same dispatch: `e5269b7a` + `4c7092d4` (reconciliation
raw-evidence cache; incomplete evidence defers tip expiry instead of expiring
tips), `62f3acd8` (scheduler expiry monitor on the health probe + rewards phase
timings), `d5dd5862` (fee-item abandonment sweep cleans already-soft-deleted
stale items without publishing them). Commit messages are the detailed record.

## Operator sequence (authorized ops; none executed)

### 1. Pre-deploy — inspect production read-only

Use loader-wrapped commands and the production procedure referenced in the
canonical `AGENTS.md` bullet ("The VPS runs stasher.news publicly in PRODUCTION
mode", repo-root `AGENTS.md`; referenced, never restated here). Save a
pre-migration snapshot per `~/Stasher-local/ops-docs/runbooks/migrations.md`
(verify the backup, not only the command exit) — the VPS boot chain does not
take one automatically. The migration list to expect: exactly the three
`2026101210*` directories above, nothing else. **Do not deploy while a rewards
handler is live — even if its queue row already says failed** (the 2026-10-12
weekly run outlived pg-boss's 15-minute expiry and kept executing after being
marked failed; re-running a retried distribution could double-pay).

Safe database verification statements (run through the approved production
access path):

```sql
SELECT to_regprocedure('public.search_users_by_name(text,real,integer)');
SELECT name, cron, timezone, options FROM pgboss.schedule
WHERE name IN ('streak', 'rewardsDistributor');
SELECT id, name, state, retrylimit, retrycount, retrydelay, retrybackoff,
       expirein, createdon, startedon, completedon
FROM pgboss.job
WHERE name IN ('streak', 'rewardsDistributor')
ORDER BY createdon DESC LIMIT 20;
SELECT id, "feePayInId", "deletedAt", "feeStatus" FROM "Item"
WHERE "feeStatus" = 'PENDING_FEE' AND "feePayInId" IS NOT NULL
  AND "deletedAt" IS NOT NULL AND created_at < now() - interval '1 day';
```

What to read from each: `to_regprocedure` returns `NULL` before the deploy (the
bug being fixed) and the signature after; the schedule/job rows show the current
retry/expiry policy and whether any `rewardsDistributor` row is in `active`
state; the `Item` query is the known stale deleted fee-linkage set (expect
three) that the next real sweep should clean after deploy. **Queue state ALONE
is not the deploy gate**: on 2026-10-12 a row read `failed` while its handler
was still running, so require independent evidence the previous handler is not
running before restarting a sender — worker logs showing it stopped (the job's
`finished` lines, or the rewards phase timings reaching completion), plus the
latest distribution/payout state. An `active` row means keep checking; a
terminal row without that evidence is not a green light.

### 2. Deploy (after authorization)

Reference the canonical production-mode `AGENTS.md` bullet for the correct
loader-wrapped chain, the external migration snapshot runbook, and the existing
pull-deploy precedent (`docs/ops/deploy-handoff-2026-09-11.md` / `-14.md`).
This doc deliberately does not inline the chain: a stale restated copy in
`docs/ops/` produced a wrong-chain handoff on 2026-10-10. Do not use bare
`docker compose` or `./sndev` on the VPS.

Pull the authorized revision (`d5dd5862`), take the Step 1 snapshot, then apply
migrations and restart **both app and worker** through that path. Verify the
running revision and Prisma/schema consistency after the restart. None of the
three migrations changes `schema.prisma`, so the boot chain's normal
generate → deploy → start sequence is sufficient; the restart pair is still
mandatory for the prepared-plan/cached-client failure modes.

### 3. Post-deploy acceptance signals — without creating new monetary activity

- Search/autocomplete works; no new 42883 errors for `search_users_by_name`.
- The next real rewards job row has `expirein = 04:00:00`, zero retry
  limit/delay, false retry backoff; queued old seeds are repaired. Historic
  failure records remain unchanged.
- The next streak job has retry limit 3 / delay 60 / backoff true; any retry
  retains the original `createdon` and evaluation day.
- Raw lookup logs show warm-cache repeated scans fetch only new/missing hashes,
  not another full 2700-hash history. A cold cache after restart is expected.
  Missing-evidence logs defer expiry; they do not silently expire tips.
- Both account-local fresh amount/height checks and owner-fee top-up replay
  remain intact. Observe at least several two-minute ticks and one hourly
  owner-fee tick.
- The monitor catches expirations (its local synthetic manager/maintenance
  coverage passes in tests); do not force a production money job to time out as
  a test. Production may alert once about the retained known incident.
- The existing three stale deleted fee linkages are cleaned by the next real
  sweep; PID maps/receipts survive and no deleted-item publication
  notifications appear.

### 4. Controlled diagnostics (only if needed)

Enable PostgreSQL `log_lock_waits` only with operator approval and secure-log
review, using the existing production configuration mechanism. Keep the default
`deadlock_timeout` and application transaction deadlines unchanged. **Do not
enable blanket SQL/parameter logging.** For a live blocker probe collect
PID/state/wait columns and `pg_blocking_pids(pid)` without query text:

```sql
SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocking_pids,
       clock_timestamp() - xact_start AS transaction_age
FROM pg_stat_activity
WHERE datname = current_database() AND wait_event_type = 'Lock';
```

Correlate with the new streak transaction timings and rewards phase timings. Do
not infer a blocker solely because two jobs overlap.

### 5. Affected streak user — explicit recovery, permission-gated

Do not execute without explicit permission. Determine the user's ID from the
retained incident and inspect the current `lastEvaluatedDay`, active/ended
streak, shield, and completion rows first. The desired target is **2026-10-11**.
If newer days already settled, the normal guards may no-op; **stop for a
chronological repair decision** rather than force-editing markers or guessing
shield/reward history.

The operator's loader-wrapped JavaScript invocation can use the existing
evaluator; this body is a recipe, not a new committed one-off script:

```js
import createPrisma from '@/lib/create-prisma'
import { evaluateQuestStreaks } from '@/worker/streak'

const userId = Number(process.argv[2])
if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('verified numeric userId required')
if (process.argv[3] !== '--confirm') throw new Error('explicit --confirm required')
const models = createPrisma({})
try {
  await evaluateQuestStreaks({
    models, userIds: [userId], now: new Date('2026-10-12T12:00:00.000Z')
  })
} finally {
  await models.$disconnect()
}
```

After an authorized replay verify only that user's marker/outcome and the
absence of duplicate grants. No automatic multi-day replay or direct production
marker `UPDATE` is included.

### 6. Known completed incident — decline payout re-execution

Verify `RewardDistribution.COMPLETE`, the recorded payouts, and ops
sweep/journal accounting. A failed queue row alone is not a reason to send
again, requeue payouts, or mutate distribution state. Any genuinely stranded
payouts use the existing guarded recovery workflow, with separate operator
approval.

### 7. Rollback cautions

- These SQL migrations are additive/policy changes; do not delete migration
  history.
- Retaining the restored search helper is harmless on application rollback.
- Preserve the corrected money no-retry policy even if rolling back other code.
- Never roll back to the unsafe incomplete-evidence expiry behavior without an
  explicit risk decision.
- Do not redeploy/restart a live sender as routine rollback; first establish
  that it stopped and reconcile journal/ledger state.
- The raw cache is disposable and needs no data rollback.

## Development verification (complete — do not re-run)

- Full default suite: one failure, `test/worker/confirmFinalizer.test.js`, which
  fails identically on the base revision `7562cd4e` — pre-existing, not a
  regression.
- `npm run lint`: clean.
- Fresh-database migration chain verified for
  `20261012100000_restore_user_name_search` (the signature resolves on a
  from-zero database).
- Dev-DB `pgboss.schedule` / `pgboss.job` policies verified read-only:
  `{"expireInHours":4,"retryLimit":0,"retryDelay":0,"retryBackoff":false}` for
  `rewardsDistributor` and `{"retryLimit":3,"retryDelay":60,"retryBackoff":true}`
  for `streak`, with queued `created`/`retry` rows repaired.
