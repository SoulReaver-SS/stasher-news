// Posting-fee quota + fee math (spec §6.2, Q5; rev 3 flat quotas).
//
// Every registered user gets the SAME quota: 1 free reply per WEEK (Monday
// 00:00 UTC windows, alongside the weekly rewards distribution) and 1 free
// post per month (no reputation tiers). Once a quota (plus any banked
// StreakReward credits) is exhausted, the user pays the platform posting fee
// (floor 1e9 piconeros = 0.001 XMR) before their post goes live. Quest
// rewards no longer extend quotas live: the daily sweep BANKS StreakReward
// rows (POST/REPLY, 30-day expiry, capped) which the quota helpers count.
//
// `left` is RESERVATION-AWARE: an upload-fee item created in-quota is born
// PENDING_FEE and holds its free unit from creation until the fee flip spends
// it (or the abandonment sweep releases it), so pendingQuotaReservations
// subtracts those held units from what commentQuotaFor/postQuotaFor report.
// baseLeft/credits stay raw; only `left` is net.
//
// Pure (no Prisma, no lexical) so it is unit-testable in isolation. The payIn
// ITEM_CREATE flow consumes these helpers and wires the fee subaddress/URI.

import { buildMoneroUri } from '@/api/monero/uri'
import { moneroUriAddress, moneroUriAmountPiconeros } from '@/lib/format'
import { reentryQuote } from '@/lib/pay-in'
import { FREE_COMMENTS_PER_WEEK, FREE_POSTS_PER_MONTH } from '@/lib/constants'

const DAY_MS = 86_400_000

/** True iff the user meets BOTH the stacked-Piconeros and age-day thresholds.
 * No longer selects quota sizes (quotas are flat); kept for the verified-badge
 * eligibility gate (hasWallet / maybeGrantVerifiedBadge), itself hard-off
 * pending a paid/awarded redesign (lib/verified-badge-flag.js). */
export function canPostFree (user, config) {
  const ageDays = (Date.now() - user.createdAt.getTime()) / DAY_MS
  return user.stackedPiconeros >= config.freePostThresholdPiconeros &&
    ageDays >= config.freePostMinAgeDays
}

/** The posting fee once the free-post quota is exhausted, in piconeros (the
 * platform-wide floor). */
export function postingFeePiconeros (config) {
  return config.postingFeeFloorPiconeros
}

/** The flat comment/reply fee, in piconeros (operator-tunable, decoupled from
 * the posting floor so comments can be priced below posts). */
export function commentFeePiconeros (config) {
  return config.commentFeePiconeros
}

/** Weekly free-reply quota: flat one tier (spec rev 3). Quest rewards bank
 * StreakReward REPLY rows instead of extending this. */
export function freeCommentsQuota (user, config) {
  if (!user) return 0
  return FREE_COMMENTS_PER_WEEK
}

/** Monthly free-post quota: flat one tier, resets monthly, never accumulates
 * (an unused window grants exactly 1 again, not 1 + unused). */
export function freePostsQuota (user, config) {
  if (!user) return 0
  return FREE_POSTS_PER_MONTH
}

/**
 * How many free replies the user has left this week (window resets Mondays
 * 00:00 UTC).
 */
export function commentsFreeLeft (user, config) {
  if (!user) return 0
  const quota = freeCommentsQuota(user, config)
  if (user.freeCommentResetAt && new Date() >= new Date(user.freeCommentResetAt)) {
    return quota
  }
  return Math.max(0, quota - (user.freeCommentCount || 0))
}

/** How many free posts the user has left this month (1 of the quota until used). */
export function postsFreeLeft (user, config) {
  if (!user) return 0
  if (user.freePostResetAt && new Date() >= new Date(user.freePostResetAt)) {
    return freePostsQuota(user, config)
  }
  return Math.max(0, freePostsQuota(user, config) - (user.freePostCount || 0))
}

const EMPTY_COMMENT_QUOTA = { base: 0, baseLeft: 0, credits: 0, quota: 0, left: 0, nextExpiresAt: null }
const EMPTY_POST_QUOTA = { baseQuota: 0, baseLeft: 0, credits: 0, left: 0, nextExpiresAt: null }

/** Credit-aware comment quota for DB-holding callers (models or tx): the flat
 * weekly base plus unconsumed, unexpired banked REPLY rewards, NET of the
 * user's outstanding reservations (PENDING_FEE upload-fee items already hold a
 * free unit — see pendingQuotaReservations). `left` is what gates free
 * comments. Refetches the user row when quota-relevant columns are absent
 * (partial GraphQL parents), mirroring the hasWallet resolver. */
export async function commentQuotaFor (prisma, user) {
  if (!user) return { ...EMPTY_COMMENT_QUOTA }
  const config = await getCachedPlatformFeeConfig(prisma)
  if (!config) return { ...EMPTY_COMMENT_QUOTA }
  const u = (user.createdAt != null && user.stackedPiconeros != null && user.freeCommentCount !== undefined)
    ? user
    : await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, createdAt: true, stackedPiconeros: true, freeCommentCount: true, freeCommentResetAt: true }
    })
  if (!u) return { ...EMPTY_COMMENT_QUOTA }
  const baseLeft = commentsFreeLeft(u, config)
  const { credits, nextExpiresAt } = await bankedReplyCredits(prisma, u.id)
  const reserved = (await pendingQuotaReservations(prisma, u.id)).comments
  return { base: FREE_COMMENTS_PER_WEEK, baseLeft, credits, quota: FREE_COMMENTS_PER_WEEK, left: Math.max(0, baseLeft + credits - reserved), nextExpiresAt }
}

/** Unconsumed, unexpired banked REPLY rewards for a user. */
export async function bankedReplyCredits (prisma, userId) {
  const [row] = await prisma.$queryRaw`
    SELECT count(*)::int AS credits, min("expiresAt") AS "nextExpiresAt"
    FROM "StreakReward"
    WHERE "userId" = ${userId} AND "type" = 'REPLY' AND "consumedAt" IS NULL AND "expiresAt" > now_utc()`
  return { credits: row?.credits ?? 0, nextExpiresAt: row?.nextExpiresAt ?? null }
}

/** Unconsumed, unexpired banked POST rewards for a user. */
export async function bankedPostCredits (prisma, userId) {
  const [row] = await prisma.$queryRaw`
    SELECT count(*)::int AS credits, min("expiresAt") AS "nextExpiresAt"
    FROM "StreakReward"
    WHERE "userId" = ${userId} AND "type" = 'POST' AND "consumedAt" IS NULL AND "expiresAt" > now_utc()`
  return { credits: row?.credits ?? 0, nextExpiresAt: row?.nextExpiresAt ?? null }
}

/**
 * Outstanding free-unit reservations for a user, split by comment vs post.
 *
 * An upload-fee item created in-quota is born PENDING_FEE with
 * feeQuotaEligible=true (api/payIn/types/itemCreate.js onBegin) and holds its
 * free unit from CREATION — not from the fee flip, which may be hours away
 * (or never, for an abandoned item). Until the flip spends the unit
 * (consumeQuotaForFlippedItem, which leaves PENDING_FEE and clears the
 * reservation) or the 1-day abandonment sweep soft-deletes the item
 * (deletedAt set — also clears it), the held unit must not price another
 * item free. One round trip, two conditional counts.
 */
export async function pendingQuotaReservations (prisma, userId) {
  if (!userId) return { comments: 0, posts: 0 }
  const [row] = await prisma.$queryRaw`
    SELECT
      count(*) FILTER (WHERE "parentId" IS NOT NULL)::int AS comments,
      count(*) FILTER (WHERE "parentId" IS NULL)::int AS posts
    FROM "Item"
    WHERE "userId" = ${userId}::INTEGER
      AND "feeStatus" = 'PENDING_FEE'
      AND "feeQuotaEligible" = true
      AND "deletedAt" IS NULL`
  return { comments: row?.comments ?? 0, posts: row?.posts ?? 0 }
}

/** Credit-aware post quota for DB-holding callers. `left` is what gates free
 * posts: monthly base remaining plus banked credits, NET of outstanding
 * reservations (PENDING_FEE upload-fee posts already hold a unit). */
export async function postQuotaFor (prisma, user, config) {
  if (!user) return { ...EMPTY_POST_QUOTA }
  const cfg = config || await getCachedPlatformFeeConfig(prisma)
  if (!cfg) return { ...EMPTY_POST_QUOTA }
  const baseLeft = postsFreeLeft(user, cfg)
  const { credits, nextExpiresAt } = await bankedPostCredits(prisma, user.id)
  const reserved = (await pendingQuotaReservations(prisma, user.id)).posts
  return { baseQuota: freePostsQuota(user, cfg), baseLeft, credits, left: Math.max(0, baseLeft + credits - reserved), nextExpiresAt }
}

// In-process cache for the PlatformFeeConfig singleton. It changes almost never
// (operator-tunable thresholds/floor), so a 60s TTL is safe and avoids an N+1 on
// hot resolvers (hasWallet renders per user in feeds). After a migration that
// changes it, the cache self-heals within the TTL, and operators restart
// containers anyway.
const FEE_CONFIG_TTL_MS = 60_000
let cachedFeeConfig = null
let cachedFeeConfigAt = 0

export async function getCachedPlatformFeeConfig (models) {
  const now = Date.now()
  if (cachedFeeConfig && now - cachedFeeConfigAt < FEE_CONFIG_TTL_MS) return cachedFeeConfig
  cachedFeeConfig = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  cachedFeeConfigAt = now
  return cachedFeeConfig
}

// Test-only: clears the cache so unit tests with different model mocks don't leak.
export function __resetFeeConfigCacheForTests () {
  cachedFeeConfig = null
  cachedFeeConfigAt = 0
}

// Resolver-facing bundle for UserPrivates.postingFeeRequired /
// postingFeePiconeros / postingFeeFloorPiconeros / freePostThresholdPiconeros /
// freePostMinAgeDays. Self-view only: other viewers and logged-out requests see
// no-fee values and zeroed thresholds. Fetches the fee config itself; never throws.
export const POSTING_FEE_NO_FEE = {
  postingFeeRequired: false,
  postingFeePiconeros: 0n,
  // The live platform floor, independent of the free-post quota. Reposts
  // (turf additions via pay('ITEM_UPDATE')) ALWAYS charge the floor — the
  // free-post quota gates ITEM_CREATE only — so the repost picker needs the
  // floor even while postingFeePiconeros is zeroed for a quota-bearing user.
  postingFeeFloorPiconeros: 0n,
  freePostThresholdPiconeros: 0n,
  freePostMinAgeDays: 0,
  freePostsLeft: 0,
  freePostCount: 0,
  freePostsQuota: 0,
  freeCommentsQuota: 0,
  freePostCredits: 0,
  freePostCreditsExpireAt: null
}

export async function postingFeePrivatesFor (models, user, viewerId) {
  if (!viewerId || viewerId !== user.id) {
    return { ...POSTING_FEE_NO_FEE }
  }
  const config = await getCachedPlatformFeeConfig(models)
  if (!config) return { ...POSTING_FEE_NO_FEE }
  const postQuota = await postQuotaFor(models, user, config)
  const commentQuota = await commentQuotaFor(models, user)
  const postsLeft = postQuota.left
  const frontend = {
    freePostThresholdPiconeros: config.freePostThresholdPiconeros,
    freePostMinAgeDays: config.freePostMinAgeDays,
    freePostsLeft: postsLeft,
    freePostCount: user.freePostCount || 0,
    freePostsQuota: postQuota.baseQuota,
    freeCommentsQuota: commentQuota.quota,
    freePostCredits: postQuota.credits,
    freePostCreditsExpireAt: postQuota.nextExpiresAt
  }
  // A post requires a fee once the user's free-post quota AND banked credits
  // are exhausted (flat 1/month base + credits; postQuotaFor.left is
  // credit-aware).
  const postingFeeRequired = postsLeft <= 0
  // The floor is exposed unconditionally (self-view) so the repost picker can
  // quote a turf addition, which never gets the ITEM_CREATE free-post waiver.
  const postingFeeFloorPiconeros = postingFeePiconeros(config)
  if (!postingFeeRequired) {
    return { ...POSTING_FEE_NO_FEE, ...frontend, postingFeeFloorPiconeros }
  }
  return {
    ...POSTING_FEE_NO_FEE,
    ...frontend,
    postingFeeRequired: true,
    postingFeePiconeros: postingFeePiconeros(config),
    postingFeeFloorPiconeros
  }
}

// Cumulative fee received on-chain for a fee PayIn, across BOTH observation
// tables: platform-routed legs record FeeObservation rows (rewards-wallet
// subaddresses, observed by rewardsWalletObserver) while owner-routed legs
// record ObservedSubFee rows (fee: payment-ID legs, observed by the lws webhook).
// A PayIn is exactly one or the other, so the sum is the payee's cumulative
// received. Countable states only (DETECTED/CONFIRMED) — REORGED, EXPIRED, and
// refused (EXCLUDED) receipts must not read as payment progress. Drives
// Item.feeReceivedPiconeros (underpayment hint) and itemFeeReentryFunding
// (top-up remainder).
// `verifiedOnly` restricts the sum to height-bearing receipts — exactly what
// the integrated-fee gates count (a provisional 0-conf claim is display-only).
export async function feeReceivedPiconerosForPayIn (models, payInId, { verifiedOnly = false } = {}) {
  const where = { payInId, state: { in: ['DETECTED', 'CONFIRMED'] }, ...(verifiedOnly ? { height: { not: null } } : {}) }
  const [feeAgg, subFeeAgg] = await Promise.all([
    models.feeObservation.aggregate({ _sum: { piconeros: true }, where }),
    models.observedSubFee.aggregate({ _sum: { piconeros: true }, where })
  ])
  return (feeAgg._sum.piconeros ?? 0n) + (subFeeAgg._sum.piconeros ?? 0n)
}

// Re-entry funding info for a PENDING_FEE item (post OR comment): reuses the fee
// PayIn's reserved subaddress (recovered from its stored monero URI) and quotes
// only the REMAINDER, so a top-up completes the fee instead of re-quoting the
// full original amount after a partial payment. Returns null when there is
// nothing to reuse; the caller falls back to the item's stored URI (a fresh
// submit has nothing received, so the remainder equals the full fee). The
// stored URI is NEVER rewritten — the observer gate (rewardsWalletObserver)
// reads the FULL fee from it, so cumulative received keeps comparing against the
// full amount.
export async function itemFeeReentryFunding (models, item) {
  if (item.feeStatus !== 'PENDING_FEE' || !item.feePayInId) return null
  const payIn = await models.payIn.findUnique({ where: { id: item.feePayInId } })
  if (!payIn) return null
  const address = moneroUriAddress(payIn.moneroUri)
  if (!address) return null
  const expected = moneroUriAmountPiconeros(payIn.moneroUri)
  if (expected == null) return null
  const received = await feeReceivedPiconerosForPayIn(models, payIn.id)
  const { fullyPaid, amount } = reentryQuote(expected, received)
  // Fully observed (received >= expected) but not yet chain-verified enough to
  // flip: there is nothing more to pay. Return the funding info with a null URI
  // so the caller renders the "payment detected — waiting for confirmation"
  // state instead of re-quoting the full fee (2026-09-19 fix: the old
  // `remaining > 0 ? remaining : expected` fallback re-quoted the FULL amount,
  // which the modal showed as "pay 0.0006 again" after a complete payment).
  const moneroUri = fullyPaid
    ? null
    : buildMoneroUri(
      [{ address, amount }],
      { description: `StasherNews ${item.parentId ? 'comment' : 'posting'} fee top-up` }
    )
  return { payIn, moneroUri, fullyPaid, feePiconeros: expected, receivedPiconeros: received, expectedPiconeros: expected }
}
