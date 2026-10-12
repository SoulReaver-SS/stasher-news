import { notifyFlameAdvanced, notifyShieldUsed, notifyStreakLost } from '@/lib/webPush'
import { cycleDay, ladderRewardForLevel, MAX_BANKED_BOOSTS, MAX_BANKED_POSTS, MAX_BANKED_REPLIES } from '@/lib/quests'
import { lockRewardUser, rewardNow } from '@/api/quests/boost-credit'
import { questDay } from '@/lib/questClock'
import { logInfo, logWarn } from '@/lib/logger'

const REWARD_TYPE = { post: 'POST', reply: 'REPLY', boost: 'BOOST', turfdiscount: 'TURF_DISCOUNT' }
const BANKED_CAP = { POST: MAX_BANKED_POSTS, REPLY: MAX_BANKED_REPLIES }
const DAY_MS = 86_400_000
const SLOW_TRANSACTION_MS = 1000
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 15000 }

/**
 * Best-effort slow/failure diagnostics for one streak transaction path
 * (2026-10-12 incident: the nightly evaluation exceeded the 10s interactive
 * transaction timeout while a rewards distribution was running). Fields are
 * fixed: `{ userId, day, path, lockAcquireMs, transactionMs, outcome }`, where
 * `path` is 'advance' (cleared-day advance) or 'missed' (missed-day settle)
 * and `lockAcquireMs` is the caller-sampled interval AROUND lockRewardUser —
 * it includes network/event-loop delay, so it is lock ACQUISITION time, not
 * proven PostgreSQL lock wait. A committed transaction is logged (logInfo)
 * only when it took at least SLOW_TRANSACTION_MS; a failed one is logged
 * (logWarn) regardless of elapsed time. Emission is best-effort: a logger
 * failure must never mask a transaction failure or a committed outcome, so it
 * is swallowed here. Never receives exception text or query parameters.
 */
function logStreakTransactionTiming (fields) {
  try {
    if (fields.outcome === 'committed') {
      if (fields.transactionMs >= SLOW_TRANSACTION_MS) logInfo(fields, 'streak transaction slow')
    } else {
      logWarn(fields, 'streak transaction failed')
    }
  } catch { /* diagnostics never change the transaction outcome */ }
}

/**
 * Advance the flame for a UTC day whose quests are cleared (spec §4.5). The
 * quest sweep calls this as soon as both completions are on record, so the
 * flame lights — badge, filled circle, level rewards — the moment the day is
 * cleared instead of waiting for 00:10 UTC; the daily evaluation calls it too
 * as a backstop. `Streak.lastEvaluatedDay` marks the last day whose outcome is
 * settled, so this is idempotent per day. With `requirePrevSettled` (the
 * sweep's path) an active flame whose previous day is still pending evaluation
 * is left alone: that day may yet consume the shield or end the run, which
 * would change the level. Returns the notification payload, or null when there
 * was nothing to do. All reward writes serialize on a per-user row lock taken
 * at the start of the transaction (api/quests/boost-credit lockRewardUser).
 */
export async function advanceQuestStreak ({ models, userId, day, requirePrevSettled = false }) {
  const dayDate = new Date(`${day}T00:00:00.000Z`)
  const prevDate = new Date(dayDate.getTime() - DAY_MS)
  let notification = null

  const transactionStart = Date.now()
  let lockAcquireMs = null
  let outcome = 'failed'
  try {
    await models.$transaction(async tx => {
      // Serialize reward writes for the user first (task 3): the row lock must
      // precede every read below, so a concurrent sweep/evaluation of the same
      // day blocks until this transaction commits and then re-reads the settled
      // guard, seeing the day already advanced instead of double-granting.
      const lockStart = Date.now()
      const locked = await lockRewardUser(tx, userId)
      lockAcquireMs = Date.now() - lockStart
      if (!locked) return
      const user = await tx.user.findUnique({ where: { id: userId }, select: { streak: true } })
      if (!user) return
      const streak = await tx.streak.findFirst({ where: { userId, type: 'FLAME', endedAt: null } })

      // Day guard: never count the same UTC day twice for one streak run.
      if (streak?.lastEvaluatedDay && streak.lastEvaluatedDay >= dayDate) return
      // Settled-run guard: with no active streak, a day at or before the last
      // (ended) run's settled day already belongs to that run — re-advancing it
      // would phantom-restart the run and collide with its row on the unique key.
      if (!streak) {
        const last = await tx.streak.findFirst({
          where: { userId, type: 'FLAME', endedAt: { not: null } },
          orderBy: { startedAt: 'desc' },
          select: { lastEvaluatedDay: true }
        })
        if (last?.lastEvaluatedDay && last.lastEvaluatedDay >= dayDate) return
      }
      // Deferral guard: the previous day's outcome is still pending, so this day's
      // level is not knowable yet.
      if (requirePrevSettled && streak && (!streak.lastEvaluatedDay || streak.lastEvaluatedDay < prevDate)) return

      const level = (user.streak ?? 0) + 1
      const row = streak ?? await tx.streak.create({
        data: { userId, type: 'FLAME', startedAt: dayDate }
      })
      await tx.user.update({ where: { id: userId }, data: { streak: level } })
      const rewards = await grantLadderRewards({ models: tx, userId, streak: row, from: row.rewardLevel, to: level })
      // Read the row back AFTER the grants: grantLadderRewards may have armed the
      // shield, and the arming advance must report the post-grant goldFlame.
      const settled = await tx.streak.update({ where: { id: row.id }, data: { lastEvaluatedDay: dayDate } })
      notification = { kind: 'advanced', level, cycleDay: cycleDay(level), goldFlame: settled.goldActive, rewards }
    }, TRANSACTION_OPTIONS)
    outcome = 'committed'
  } finally {
    logStreakTransactionTiming({
      userId,
      day,
      path: 'advance',
      lockAcquireMs,
      transactionMs: Date.now() - transactionStart,
      outcome
    })
  }

  return notification
}

/**
 * Daily quest-streak evaluation (spec §4.5). Runs just after 00:10 UTC and
 * evaluates the UTC day that just ended (`now` minus a day, so a caller may
 * simulate a day passing): clearing both quests advances the flame (normally
 * already done by the sweep — this is the backstop for a sweep that recorded
 * the completions but crashed before advancing); a missed day is absorbed by
 * the golden flame shield when it is armed, or ends the streak when it is not.
 * `Streak.lastEvaluatedDay` makes re-runs for the same day no-ops. Ladder
 * rewards are granted on advance, idempotently via `Streak.rewardLevel`.
 */
export async function evaluateQuestStreaks ({ models, now = new Date(), userIds } = {}) {
  const day = questDay(new Date(now.getTime() - DAY_MS))
  const dayDate = new Date(`${day}T00:00:00.000Z`)

  // Every user with both completions recorded for the day (the sweep writes
  // them; the unique key guarantees at most one row per quest). When a user
  // allowlist is given (test isolation), only those users are evaluated —
  // other runs are left exactly as they are.
  const clearedRows = await models.$queryRaw`
    SELECT "userId" FROM "QuestCompletion"
    WHERE "day" = ${dayDate} GROUP BY "userId" HAVING count(*) >= 2`
  const scope = userIds ? new Set(userIds) : null
  const cleared = new Set(clearedRows.map(r => r.userId).filter(id => !scope || scope.has(id)))

  const active = (await models.streak.findMany({ where: { type: 'FLAME', endedAt: null } }))
    .filter(s => !scope || scope.has(s.userId))
  const activeByUser = new Map(active.map(s => [s.userId, s]))
  const userIdsIter = new Set([...cleared, ...active.map(s => s.userId)])

  for (const userId of userIdsIter) {
    const user = await models.user.findUnique({ where: { id: userId }, select: { streak: true } })
    if (!user) continue
    const known = activeByUser.get(userId)

    // Day guard: never evaluate the same UTC day twice for one streak run.
    if (known?.lastEvaluatedDay && known.lastEvaluatedDay >= dayDate) continue

    let notification = null
    if (cleared.has(userId)) {
      // Already settled by the sweep in the normal case (the guard above would
      // have skipped us); this covers the crash-before-advance case.
      notification = await advanceQuestStreak({ models, userId, day })
    } else if (known) {
      // One transaction per user: the guard, the shield consume or run end, and
      // the marker commit together, so a crash mid-evaluation can neither
      // phantom-hold nor lose the day on the retry. The user lock is taken
      // first — the same row lock the advance path holds — and state is
      // re-read under it, so this cannot interleave with a concurrent advance
      // of the same day. `user.streak` from the outer loop is stale by design:
      // the shield payload uses the re-read value.
      const transactionStart = Date.now()
      let lockAcquireMs = null
      let outcome = 'failed'
      try {
        await models.$transaction(async tx => {
          const lockStart = Date.now()
          const locked = await lockRewardUser(tx, userId)
          lockAcquireMs = Date.now() - lockStart
          if (!locked) return
          const current = await tx.user.findUnique({ where: { id: userId }, select: { streak: true } })
          if (!current) return
          const streak = await tx.streak.findFirst({ where: { userId, type: 'FLAME', endedAt: null } })
          if (!streak) return
          if (streak.lastEvaluatedDay && streak.lastEvaluatedDay >= dayDate) return

          await tx.streak.update({ where: { id: streak.id }, data: { lastEvaluatedDay: dayDate } })
          if (streak.goldActive) {
            await tx.streak.update({ where: { id: streak.id }, data: { goldActive: false } })
            notification = { kind: 'shield', day: cycleDay(current.streak) }
          } else {
            await tx.streak.update({ where: { id: streak.id }, data: { endedAt: dayDate } })
            await tx.user.update({ where: { id: userId }, data: { streak: null } })
            notification = { kind: 'lost', streak }
          }
        }, TRANSACTION_OPTIONS)
        outcome = 'committed'
      } finally {
        logStreakTransactionTiming({
          userId,
          day,
          path: 'missed',
          lockAcquireMs,
          transactionMs: Date.now() - transactionStart,
          outcome
        })
      }
    }

    if (notification?.kind === 'advanced') notifyFlameAdvanced(userId, notification).catch(console.error)
    else if (notification?.kind === 'shield') notifyShieldUsed(userId).catch(console.error)
    else if (notification?.kind === 'lost') notifyStreakLost(userId, notification.streak).catch(console.error)
  }
}

/**
 * Scheduled 'streak' entry point (worker/index.js). pg-boss retries redeliver
 * the SAME job and, because the work registration enables includeMetadata,
 * expose its original creation time as `createdon` (Job.createdon — the row's
 * createdOn column). Anchoring to that timestamp means an attempt that lands
 * after 00:00 UTC still evaluates the day the cron fired for: the evaluator's
 * day guards make any newer settled day a clean no-op, never a backdated
 * replay. Missing or malformed metadata fails loudly with a fixed error code
 * instead of silently evaluating a different day. Direct callers keep calling
 * evaluateQuestStreaks with an explicit `now`.
 */
export async function runScheduledStreak ({ models, createdon, evaluate = evaluateQuestStreaks }) {
  if (createdon == null) throw new Error('STREAK_JOB_CREATION_TIME_REQUIRED')
  const now = new Date(createdon)
  if (!Number.isFinite(now.getTime())) throw new Error('STREAK_JOB_CREATION_TIME_INVALID')
  await evaluate({ models, now })
}

/**
 * Grant every ungranted ladder level up to `to`. POST and REPLY bank capped
 * credits: grants stop at MAX_BANKED_POSTS / MAX_BANKED_REPLIES (spec rev 3
 * §2.4, count-before-insert). BOOST banks at most one credit
 * (MAX_BANKED_BOOSTS): the rung — day 5 on odd weeks, day 2 on even weeks —
 * is suppressed while one is held WITHOUT refreshing the held row's expiry,
 * and it re-grants only once that row is consumed or expired; its expiry is
 * exactly 30 real days after granting —
 * never a calendar month, never a compressed quest day. TURF_DISCOUNT stays
 * non-stacking (suppressed while one is held). The goldflame rung arms the
 * golden flame shield instead of granting a ledger row. The marker advances
 * even when a reward is suppressed, so the next cycle re-attempts on its own
 * day.
 *
 * Precondition: the caller's transaction MUST already hold the user row lock
 * (lockRewardUser) — every reward write for a user serializes on it, so the
 * count predicates here read committed state under the lock and concurrent
 * sweeps/rungs cannot double-grant or cross a cap. `models` is that same
 * transaction client; this helper never opens a nested transaction.
 */
export async function grantLadderRewards ({ models, userId, streak, from, to }) {
  const granted = []
  for (let level = from + 1; level <= to; level++) {
    const kind = ladderRewardForLevel(level)
    if (kind === 'goldflame') {
      // The shield: armed (or re-armed) at every cycle day 4, kept until a
      // missed day consumes it.
      await models.streak.update({ where: { id: streak.id }, data: { goldActive: true } })
      continue
    }
    const type = REWARD_TYPE[kind]
    if (!type) continue // flame is cosmetic
    if (type === 'BOOST') {
      // The boost-credit rung — day 5 on odd flame weeks, day 2 on even weeks
      // (spec 2026-10-05-quest-rebalance-boost-credit):
      // count available rows under the caller's user lock and stop at the
      // cap of one — a held credit suppresses this rung without refreshing
      // its expiry. Unlike POST/REPLY the grant timestamps come from the
      // database wall clock, and spec §5.1 requires sampling it AFTER
      // acquiring locks: the caller's row lock may have parked through a
      // long wait, and now_utc() would stay frozen at the transaction's
      // BEGIN (before the wait), so a credit expiring mid-wait would still
      // count as held while the fresh grant landed on a later clock. The
      // single rewardNow sample below is therefore the one source of truth
      // for BOTH the availability predicate and the inserted row's
      // created_at/grantedAt/expiresAt.
      const grantedAt = await rewardNow(models)
      const [held] = await models.$queryRaw`
        SELECT count(*)::int AS held FROM "StreakReward"
        WHERE "userId" = ${userId} AND "type" = 'BOOST'::"StreakRewardType"
          AND "consumedAt" IS NULL AND "expiresAt" > ${grantedAt}::timestamp`
      if ((held?.held ?? 0) >= MAX_BANKED_BOOSTS) continue
      await models.$queryRaw`
        INSERT INTO "StreakReward" ("userId", "streakId", created_at, "grantedAt", "expiresAt", type)
        VALUES (${userId}, ${streak.id}, ${grantedAt}, ${grantedAt},
          ${grantedAt}::timestamp + interval '30 days', 'BOOST'::"StreakRewardType")`
      granted.push({ level, kind })
      continue
    }
    if (type !== 'POST' && type !== 'REPLY') {
      const held = await models.streakReward.findFirst({
        where: { userId, type, consumedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true }
      })
      if (held) continue
    } else {
      // Banked credits stop at the cap (spec rev 3 §2.4).
      const [row] = await models.$queryRaw`
        SELECT count(*)::int AS held FROM "StreakReward"
        WHERE "userId" = ${userId} AND "type" = ${type}::"StreakRewardType"
          AND "consumedAt" IS NULL AND "expiresAt" > now_utc()`
      if ((row?.held ?? 0) >= BANKED_CAP[type]) continue
    }
    await models.$queryRaw`
      INSERT INTO "StreakReward" ("userId", "streakId", created_at, "grantedAt", "expiresAt", "type")
      VALUES (${userId}, ${streak.id}, now_utc(), now_utc(), now_utc() + interval '1 month', ${type}::"StreakRewardType")`
    granted.push({ level, kind })
  }
  if (to > from) {
    await models.streak.update({ where: { id: streak.id }, data: { rewardLevel: to } })
  }
  return granted
}
