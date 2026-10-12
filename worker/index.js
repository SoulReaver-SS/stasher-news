// environment variables are loaded from files and imports run before the rest of the code
import './loadenv'
import { validateEnv, assertExplicitNodeEnv } from '@/lib/env'
import PgBoss from 'pg-boss'
import createPrisma from '@/lib/create-prisma'
import { repin } from './repin'
import { trust } from './trust'
import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client'
import { indexItem, indexAllItems } from './search'
import { timestampItem } from './ots'
import { runScheduledStreak } from './streak'
import { sweepQuestCompletions } from './quests'
import { nip57 } from './nostr'
import fetch from 'cross-fetch'
import { imgproxy } from './imgproxy'
import { imgproxyResign, findSignatureMismatch } from './imgproxyResign'
import { deleteItem } from './ephemeralItems'
import { deleteUnusedImages } from './deleteUnusedImages'
import { territoryBilling } from './territory'
import { ofac } from './ofac'
import { saltAndHashEmails } from './saltAndHashEmails'
import { remindUser } from './reminder'
import { thisDay } from './thisDay'
import { isServiceEnabled } from '@/lib/sndev'
import { payWeeklyPostBounty, weeklyPost } from './weeklyPosts'
import { postToSocial } from './socialPoster'
import {
  domainVerification,
  deleteCertificateExternal,
  checkActiveDomainsDNS,
  clearLongHeldDomains
} from './domainVerification.js'
import { untrackOldItems } from './untrackOldItems'
import { confirmFinalizer } from './confirmFinalizer'
import { bounties } from './bounties'
import { rewardsWalletObserver } from './rewardsWalletObserver'
import { rewardsDistributor } from './rewardsDistributor'
import { opsSweep } from './opsSweep'
import { rotateViewKeys } from './rotateViewKeys'
import { reconcilePendingTips } from './reconcilePendingTips'
import { webhookCleanup } from './webhookCleanup'
import { webhookMissCheck } from './webhookMissCheck'
import { abandonFeeItems } from './abandonFeeItems'
import { abandonStaleDrafts } from './abandonStaleDrafts'
import { reverseStaleDetections } from './reverseStaleDetections'
import { reconcileOwnerFeeLegs } from './reconcileOwnerFeeLegs'
import { healthProbe } from './healthProbe'
import { dbBackup } from './dbBackup'
import { emailDigest } from './emailDigest'
import { newsletterEnroll, newsletterSync } from './newsletter'
import { newsletterCampaign } from './newsletterCampaign'
import { isNewsletterEnabled, checkNewsletterConfig } from '@/lib/newsletter'
import { writeWorkerHeartbeat } from './heartbeat'
import { logInfo, logWarn, logError } from '@/lib/logger'
import { moneroJobDurationSeconds } from '@/lib/metrics'
import { buildGateCookieHeader } from '@/lib/invite-gate'
import { BOSS_RETRY } from '@/lib/constants'
import { alert } from '@/lib/alert'

// WebSocket polyfill
import ws from 'isomorphic-ws'

if (typeof WebSocket === 'undefined') {
  global.WebSocket = ws
}

const _runtime = { boss: null, models: null }

async function work () {
  assertExplicitNodeEnv()
  validateEnv()
  const CLEANUP_INTERVAL_SECONDS = 60 * 60 // hourly — must match worker/webhookCleanup.js
  const boss = new PgBoss(process.env.DATABASE_URL)
  const models = createPrisma({
    connectionParams: { connection_limit: process.env.DB_WORKER_CONNECTION_LIMIT }
  })
  _runtime.boss = boss
  _runtime.models = models

  const gateCookieHeader = buildGateCookieHeader()
  const apollo = new ApolloClient({
    link: new HttpLink({
      uri: `${process.env.SELF_URL}/api/graphql`,
      fetch,
      headers: gateCookieHeader ? { Cookie: gateCookieHeader } : undefined
    }),
    cache: new InMemoryCache(),
    defaultOptions: {
      watchQuery: {
        fetchPolicy: 'no-cache',
        nextFetchPolicy: 'no-cache'
      },
      query: {
        fetchPolicy: 'no-cache',
        nextFetchPolicy: 'no-cache'
      }
    }
  })

  const args = { boss, models, apollo }

  boss.on('error', error => logError(error))

  function jobWrapper (fn) {
    return async function (job) {
      writeWorkerHeartbeat()
      logInfo(`running ${job.name}`)
      if (job.retrycount > 0) {
        logInfo(`  ... retry #${job.retrycount}/${job.retrylimit}`)
      }
      const start = Date.now()
      try {
        await fn({ ...job, ...args })
      } catch (error) {
        logError(`error running ${job.name}`, error)
        if ((job.retrycount ?? 0) >= (job.retrylimit ?? 0)) {
          try {
            alert('critical', `job ${job.name} failed permanently`, String(error), { dedupeKey: `job-failed-${job.name}` })
          } catch { /* alerting must not mask the rethrow */ }
        }
        throw error
      } finally {
        try { moneroJobDurationSeconds.labels(job.name).observe((Date.now() - start) / 1000) } catch { /* metric never breaks a job */ }
      }
      logInfo(`finished ${job.name}`)
    }
  }

  await boss.start()
  writeWorkerHeartbeat()

  if (isServiceEnabled('search')) {
    await boss.work('indexItem', { includeMetadata: true }, jobWrapper(indexItem))
    await boss.work('indexAllItems', { includeMetadata: true }, jobWrapper(indexAllItems))
  }
  if (isServiceEnabled('images')) {
    await boss.work('imgproxy', { includeMetadata: true }, jobWrapper(imgproxy))
    await boss.work('imgproxyResign', { includeMetadata: true }, jobWrapper(imgproxyResign))
    // IMGPROXY_KEY/SALT rotation check: keys are read at module import, so a
    // rotation always implies a restart — verifying a sample of stored paths
    // here catches it exactly once, immediately, with no stored fingerprint.
    if (await findSignatureMismatch(models)) {
      logInfo('imgproxy key rotation detected: enqueueing backlog re-sign')
      await boss.send('imgproxyResign', {}, { ...BOSS_RETRY, singletonKey: 'imgproxyResign' })
    }
    await boss.work('deleteUnusedImages', { includeMetadata: true }, jobWrapper(deleteUnusedImages))
    // daily unused-image sweep; self-requeues on a 24h startAfter. Seed on
    // fresh installs (deferred 24h) so a brand-new stack lands a first run,
    // mirroring the trust deferred-seed pattern.
    if (await boss.getQueueSize('deleteUnusedImages') === 0) {
      await boss.send('deleteUnusedImages', {}, { ...BOSS_RETRY, startAfter: 24 * 60 * 60 })
    }
  }
  if (isServiceEnabled('domains')) {
    await boss.work('domainVerification', { includeMetadata: true }, jobWrapper(domainVerification))
    await boss.work('deleteDomainCertificate', { includeMetadata: true }, jobWrapper(deleteCertificateExternal))
    await boss.work('checkActiveDomainsDNS', { includeMetadata: true }, jobWrapper(checkActiveDomainsDNS))
    await boss.work('clearLongHeldDomains', { includeMetadata: true }, jobWrapper(clearLongHeldDomains))
  }
  await boss.work('weeklyPost-*', { includeMetadata: true }, jobWrapper(weeklyPost))
  await boss.work('payWeeklyPostBounty', { includeMetadata: true }, jobWrapper(payWeeklyPostBounty))
  await boss.work('repin-*', { includeMetadata: true }, jobWrapper(repin))
  await boss.work('trust', { includeMetadata: true }, jobWrapper(trust))
  // trust recomputes nightly via the pgboss.schedule row (0 2 * * * UTC).
  // Self-seed on fresh installs (deferred 24h) so a brand-new stack lands a first run
  // without waiting on the cron, mirroring the rewardsDistributor deferred-seed pattern.
  if (await boss.getQueueSize('trust') === 0) {
    await boss.send('trust', {}, { ...BOSS_RETRY, startAfter: 24 * 60 * 60 })
  }
  await boss.work('timestampItem', { includeMetadata: true }, jobWrapper(timestampItem))
  // runScheduledStreak anchors each attempt (including a pg-boss retry that
  // lands after UTC midnight) to the job's original createdon, so a retry still
  // evaluates the day the 00:10 UTC cron fired for — see worker/streak.js.
  await boss.work('streak', { includeMetadata: true }, jobWrapper(runScheduledStreak))
  await boss.work('questSweep', { includeMetadata: true }, jobWrapper(sweepQuestCompletions))
  await boss.work('nip57', { includeMetadata: true }, jobWrapper(nip57))
  await boss.work('deleteItem', { includeMetadata: true }, jobWrapper(deleteItem))
  await boss.work('territoryBilling', { includeMetadata: true }, jobWrapper(territoryBilling))

  // territoryBilling chains are per-sub and self-requeue; a permanently failed
  // run used to stop billing for that sub forever. Reseed any sub with no
  // queued/active/retry job on boot (mirrors the confirmFinalizer seed guard).
  // getQueueSize's default before:'active' counts only created+retry — pass
  // before:'completed' to also count a currently-active run (pg-boss v9 state
  // order: created < retry < active < completed < expired < cancelled < failed).
  if (await boss.getQueueSize('territoryBilling', { before: 'completed' }) === 0) {
    const subs = await models.sub.findMany({
      where: { OR: [{ billingType: { not: 'ONCE' } }, { billingStatus: 'PENDING_FEE' }] },
      select: { name: true }
    })
    for (const { name } of subs) {
      await boss.send('territoryBilling', { subName: name }, { ...BOSS_RETRY, startAfter: 60 })
    }
  }
  await boss.work('ofac', { includeMetadata: true }, jobWrapper(ofac))
  await boss.work('saltAndHashEmails', { includeMetadata: true }, jobWrapper(saltAndHashEmails))
  await boss.work('reminder', { includeMetadata: true }, jobWrapper(remindUser))
  await boss.work('thisDay', { includeMetadata: true }, jobWrapper(thisDay))
  await boss.work('socialPoster', { includeMetadata: true }, jobWrapper(postToSocial))
  await boss.work('untrackOldItems', { includeMetadata: true }, jobWrapper(untrackOldItems))

  await boss.work('confirmFinalizer', { includeMetadata: true }, jobWrapper(confirmFinalizer))

  // Seed the self-requeuing confirmFinalizer loop (singleton guard on the seed
  // only). Confirmation is low-frequency (CONFIRM_POLL_INTERVAL_MS, default 60s).
  if (await boss.getQueueSize('confirmFinalizer') === 0) {
    await boss.send('confirmFinalizer', {}, { ...BOSS_RETRY })
  }

  // bounties: bounty lifecycle scans (expiry, payout dispatch, maturity).
  // Self-requeues every 60s — same singleton-guarded seed pattern as
  // confirmFinalizer.
  await boss.work('bounties', { includeMetadata: true }, jobWrapper(bounties))
  if (await boss.getQueueSize('bounties') === 0) {
    await boss.send('bounties', {})
  }

  // healthProbe: probes lws + monerod reachability + chain-height advancement
  // every HEALTH_PROBE_INTERVAL_SECONDS (default 60s), publishes the snapshot to
  // lib/healthStatus, and alerts on lws/monerod outage or a stalled chain height.
  await boss.work('healthProbe', { includeMetadata: true }, jobWrapper(healthProbe))
  if (await boss.getQueueSize('healthProbe') === 0) {
    await boss.send('healthProbe', {}, { ...BOSS_RETRY })
  }

  // reconcilePendingTips: recover PENDING tips stranded by a missed 0-conf webhook, and
  // expire never-paid tips. Self-requeues on a 2min startAfter.
  await boss.work('reconcilePendingTips', { includeMetadata: true }, jobWrapper(reconcilePendingTips))
  if (await boss.getQueueSize('reconcilePendingTips') === 0) {
    await boss.send('reconcilePendingTips', {}, { ...BOSS_RETRY })
  }

  // webhookMissCheck: one-shot delayed follow-up scheduled by the webhook
  // receiver when a tip receipt verdict is tx_not_found (BOTH lws and monerod
  // missed: lws's REST view omits mempool txs and the daemon fallback lacked
  // the hash or was unreachable — not a benign race). Event-driven — no
  // seed/self-requeue. Pages only when the ObservedTip is still PENDING when
  // the delay elapses (money never landed).
  await boss.work('webhookMissCheck', { includeMetadata: true }, jobWrapper(webhookMissCheck))

  // webhookCleanup: hourly sweep of orphaned lws webhooks (CONFIRMED/EXPIRED tips).
  await boss.work('webhookCleanup', { includeMetadata: true }, jobWrapper(webhookCleanup))
  if (await boss.getQueueSize('webhookCleanup') === 0) {
    await boss.send('webhookCleanup', {}, { ...BOSS_RETRY, startAfter: CLEANUP_INTERVAL_SECONDS / 4 }) // first sweep after 15min
  }

  // abandonFeeItems: soft-deletes never-paid PENDING_FEE items past
  // FEE_ITEM_ABANDON_DAYS (1 day). Recurrence is cron-owned (pgboss.schedule
  // row abandonFeeItems, hourly) — no self-requeue.
  await boss.work('abandonFeeItems', { includeMetadata: true }, jobWrapper(abandonFeeItems))

  // abandonStaleDrafts: deletes drafts untouched for DRAFT_TTL_DAYS (90 days);
  // DraftUpload pins cascade and the daily media sweep reaps the files.
  // Recurrence is cron-owned (pgboss.schedule row abandonStaleDrafts, hourly).
  await boss.work('abandonStaleDrafts', { includeMetadata: true }, jobWrapper(abandonStaleDrafts))

  // reverseStaleDetections: flips DETECTED-without-height observations older
  // than STALE_DETECTED_EXPIRY_MS (48h) to REORGED and reverses their
  // provisional effects (rank, upvotes, boost, downvote penalty, fee-gated
  // item liveness) — closes the 0-conf double-spend window (audit A-1).
  // Recurrence is cron-owned (pgboss.schedule row reverseStaleDetections,
  // every 10 min) — no self-requeue.
  await boss.work('reverseStaleDetections', { includeMetadata: true }, jobWrapper(reverseStaleDetections))

  // reconcileOwnerFeeLegs: hourly backstop for owner-routed fee legs whose
  // lws webhook callback was missed — re-observes receipts via lws and replays
  // them through the cumulative gate so PENDING_FEE items flip before
  // abandonFeeItems strikes. Recurrence is cron-owned (pgboss.schedule row
  // reconcileOwnerFeeLegs, hourly) — no self-requeue.
  await boss.work('reconcileOwnerFeeLegs', { includeMetadata: true }, jobWrapper(reconcileOwnerFeeLegs))

  // rewardsWalletObserver: polls the platform rewards wallet for posting/territory
  // fee outputs (subaddress attribution) and downvote payments (payment_id
  // attribution). Same self-requeuing pattern as confirmFinalizer.
  await boss.work('rewardsWalletObserver', { includeMetadata: true }, jobWrapper(rewardsWalletObserver))
  if (await boss.getQueueSize('rewardsWalletObserver') === 0) {
    await boss.send('rewardsWalletObserver', {}, { ...BOSS_RETRY })
  }

  // rewardsDistributor: weekly rewards-pool distribution (earmark inflow, compute
  // curator shares, write QUEUED payouts). Recurring runs are owned by the
  // pgboss.schedule row (cron 0 0 * * 1 UTC, migration
  // 20260807160000_schedule_rewards_distributor) — NOT a self-requeue — so each
  // run lands on the Monday 00:00 UTC the rewards resolver counts down to.
  await boss.work('rewardsDistributor', { includeMetadata: true }, jobWrapper(rewardsDistributor))
  // Fresh-install seed only: the first payout needs a week of inflow to
  // accumulate, so on a brand-new stack we defer one run 7d (the cron then owns
  // every subsequent week). The handler does NOT self-requeue, so this cannot
  // create recurring double scheduling. `sndev monero distribute` covers any
  // out-of-band run before that.
  if (await boss.getQueueSize('rewardsDistributor') === 0) {
    await boss.send('rewardsDistributor', {}, { ...BOSS_RETRY, startAfter: 7 * 24 * 60 * 60 })
  }

  // opsSweep: one-shot delayed cold-storage sweep of the rewards-wallet ops
  // earmark (2026-09-14 A′ decoupling). Enqueued by the rewardsDistributor
  // handler with startAfter = 1h after a COMPLETE run; never touches
  // distribution status, and defers/rolls over via opsRolledOverPiconeros if
  // the wallet is locked, the node is catching up, or a payout is in flight.
  await boss.work('opsSweep', { includeMetadata: true }, jobWrapper(opsSweep))

  // rotateViewKeys: quarterly DEK-hygiene re-wrap of every encrypted view key.
  // Self-requeues on a 90d startAfter; the seed starts it after a day so it doesn't
  // fire on every fresh boot. Mirrors the rewardsDistributor deferred-seed pattern.
  await boss.work('rotateViewKeys', { includeMetadata: true }, jobWrapper(rotateViewKeys))
  if (await boss.getQueueSize('rotateViewKeys') === 0) {
    await boss.send('rotateViewKeys', {}, { ...BOSS_RETRY, startAfter: 24 * 60 * 60 })
  }

  // dbBackup: nightly encrypted DB dump (pg_dump | gpg -> BACKUP_DIR) with
  // retention pruning + optional S3 upload. Recurring runs are owned by the
  // pgboss.schedule row (cron 0 3 * * * UTC, migration
  // 20260808160000_schedule_db_backup) — NOT a self-requeue — mirroring
  // rewardsDistributor. Fresh installs get one deferred (24h) run so a
  // brand-new stack lands a first backup before waiting on the cron.
  await boss.work('dbBackup', { includeMetadata: true }, jobWrapper(dbBackup))
  if (await boss.getQueueSize('dbBackup') === 0) {
    await boss.send('dbBackup', {}, { ...BOSS_RETRY, startAfter: 24 * 60 * 60 })
  }

  // emailDigest: daily drip for the weekly per-user email digest (replies,
  // mentions, earnings, highlights), capped by EMAIL_DIGEST_DAILY_BUDGET so
  // magic-code login keeps its share of Resend's 100/day quota. Recurring runs
  // are owned by the pgboss.schedule row (cron 0 15 * * * UTC, migration
  // <timestamp>_email_digest) — NOT a self-requeue.
  await boss.work('emailDigest', { includeMetadata: true }, jobWrapper(emailDigest))

  // newsletterEnroll: one-shot signup enrollment (adapter-enqueued via raw
  // pgboss.job INSERT). newsletterSync: daily reconcile to Resend, cron-owned
  // (0 16 * * * UTC, migration 20261008132506_newsletter) — NOT a self-requeue.
  await boss.work('newsletterEnroll', { includeMetadata: true }, jobWrapper(newsletterEnroll))
  await boss.work('newsletterSync', { includeMetadata: true }, jobWrapper(newsletterSync))

  // newsletterCampaign: weekly tick, 14-day watermark = biweekly send. Draft +
  // test by default; NEWSLETTER_AUTO_SEND or scripts/newsletter-send.js
  // releases it. Cron-owned (0 16 * * 1 UTC, migration 20261008132506_newsletter).
  await boss.work('newsletterCampaign', { includeMetadata: true }, jobWrapper(newsletterCampaign))

  // Newsletter boot check (spec T3): an enabled-but-unconfigured newsletter
  // must surface immediately, not silently no-op until the first cron tick.
  if (isNewsletterEnabled()) {
    const missing = checkNewsletterConfig()
    if (missing.length) {
      logWarn('newsletter enabled but unconfigured — enroll/sync/campaign will skip', { missing })
      alert('warn', 'newsletter enabled but unconfigured', `missing ${missing.join(', ')}`, { dedupeKey: 'newsletter-env' })
    }
  }

  logInfo('working jobs')
}

let shuttingDown = false
// exitCode: 0 for signals (clean drain), 1 for error handlers so the supervisor restarts us.
async function shutdown (sig, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  logInfo(`worker received ${sig}, draining`)
  try {
    if (_runtime.boss) await _runtime.boss.stop({ graceful: true, timeout: 25_000 })
  } catch (e) { logError('boss.stop failed', e) }
  try {
    if (_runtime.models) await _runtime.models.$disconnect()
  } catch (e) { logError('prisma disconnect failed', e) }
  process.exit(exitCode)
}

process.on('SIGTERM', () => shutdown('SIGTERM', 0))
process.on('SIGINT', () => shutdown('SIGINT', 0))
process.on('uncaughtException', (err) => { logError('uncaughtException', err); shutdown('uncaughtException', 1) })
process.on('unhandledRejection', (err) => { logError('unhandledRejection', err); shutdown('unhandledRejection', 1) })

work()
