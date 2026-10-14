import webPush from 'web-push'
import removeMd from 'remove-markdown'
import { COMMENT_DEPTH_LIMIT, FOUND_BLURBS, LOST_BLURBS, DEFAULT_POSTS_PICONEROS_FILTER, DEFAULT_COMMENTS_PICONEROS_FILTER } from './constants'
import { piconerosToMXmr } from './format'
import { nextBillingWithGrace } from '@/lib/territory'
import models from '@/api/models'
import { isMuted } from '@/lib/user'
import { QUEST_REPLY_REWARDS, questTitle } from '@/lib/quests'
import { Prisma } from '@prisma/client'
import { COPY } from '@/lib/rebrand-copy'
import { TURF_DISCOUNT_PERCENT } from './quests'
import { indexableMoneroWallText, moneroWallCommentsEnabled } from '@/lib/monero-wall'

// Walled-discussion comments (2026-10-14) never carry their text in a push
// body: push bypasses app-side gating and any recipient (thread subscriber,
// parent, mentioned user) may be unentitled. The title carries the event; the
// text is read in-app after unlocking. Recipients who wrote or own the item
// (notifyZapped, notifyReminder) keep real bodies — their own text is no leak.
const WALLED_COMMENT_BODY = 'the discussion is behind the post\u2019s monerowall'

export async function pushBodyFor ({ models, item }) {
  if (item.parentId != null) {
    const root = await models.item.findUnique({
      where: { id: Number(item.rootId) },
      select: {
        moneroWallEnabledAt: true,
        moneroWallRemovedAt: true,
        moneroWallCoversComments: true,
        moneroWallCommentsRemovedAt: true
      }
    })
    // a missing root is a data anomaly — mask, like the resolvers fail closed
    if (!root || moneroWallCommentsEnabled(root)) return WALLED_COMMENT_BODY
  }
  return indexableMoneroWallText(item)
}

// Check if an item meets a user's sat filter threshold for push notifications
export async function meetsUserSatFilter (userId, item) {
  const user = await models.user.findUnique({
    where: { id: userId },
    select: { postsPiconerosFilter: true, commentsPiconerosFilter: true }
  })

  const isPost = !!item.title
  const filter = user
    ? (isPost ? user.postsPiconerosFilter : user.commentsPiconerosFilter)
    : (isPost ? DEFAULT_POSTS_PICONEROS_FILTER : DEFAULT_COMMENTS_PICONEROS_FILTER)

  // null means "show all" — item always passes
  if (filter == null) return true
  // BigInt() normalizes both the user-row BigInt filter and the DEFAULT_*
  // Number constant; raw `bigint >= number` throws "Cannot mix BigInt".
  return item.netInvestment >= BigInt(filter)
}

// Batch version of meetsUserSatFilter: fetches all users' sat filter
// preferences in a single query instead of N individual findUnique calls.
// Returns a Set of user IDs that meet the sat filter threshold for the item.
async function getUsersPassingSatFilter (userIds, item) {
  if (!userIds.length) return new Set()

  const isPost = !!item.title
  const defaultFilter = isPost ? DEFAULT_POSTS_PICONEROS_FILTER : DEFAULT_COMMENTS_PICONEROS_FILTER

  const users = await models.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, postsPiconerosFilter: true, commentsPiconerosFilter: true }
  })

  const userMap = new Map(users.map(u => [u.id, u]))

  return new Set(
    userIds.filter(id => {
      const user = userMap.get(id)
      const filter = user
        ? (isPost ? user.postsPiconerosFilter : user.commentsPiconerosFilter)
        : defaultFilter
      // null means "show all" — item always passes
      if (filter == null) return true
      return item.netInvestment >= BigInt(filter)
    })
  )
}

const webPushEnabled = Boolean(
  process.env.VAPID_MAILTO &&
  process.env.NEXT_PUBLIC_VAPID_PUBKEY &&
  process.env.VAPID_PRIVKEY
)

function log (...args) {
  console.log('[webPush]', ...args)
}

function createPayload (notification) {
  // https://web.dev/push-notifications-display-a-notification/#visual-options
  // https://webkit.org/blog/16535/meet-declarative-web-push/
  // DEV: localhost in URLs is not supported by declarative web push
  let { title, body, ...options } = notification
  if (body) body = removeMd(body)
  return JSON.stringify({
    web_push: 8030, // Declarative Web Push JSON format
    notification: {
      title,
      body,
      timestamp: Date.now(),
      icon: process.env.NEXT_PUBLIC_URL + '/icons/icon_x96.png',
      navigate: process.env.NEXT_PUBLIC_URL + '/notifications', // navigate is required
      app_badge: 1, // TODO: establish a proper badge count system
      ...options
    }
  })
}

function userFilterFragment (setting) {
  return setting ? { user: { [setting]: true } } : undefined
}

async function createItemUrl (id) {
  const [rootItem] = await models.$queryRawUnsafe(
    'SELECT subpath(path, -LEAST(nlevel(path), $1::INTEGER), 1)::text AS id FROM "Item" WHERE id = $2::INTEGER',
    COMMENT_DEPTH_LIMIT + 1, Number(id)
  )
  return `/items/${rootItem.id}` + (rootItem.id !== id ? `?commentId=${id}` : '')
}

async function sendNotification (subscription, payload) {
  if (!webPushEnabled) {
    log('webPush not configured, skipping notification')
    return
  }

  const { id, endpoint, p256dh, auth } = subscription
  return await webPush.sendNotification(
    {
      endpoint,
      keys: { p256dh, auth }
    },
    payload,
    {
      vapidDetails: {
        subject: process.env.VAPID_MAILTO,
        publicKey: process.env.NEXT_PUBLIC_VAPID_PUBKEY,
        privateKey: process.env.VAPID_PRIVKEY
      },
      // conformant to declarative web push spec
      headers: {
        'Content-Type': 'application/notification+json'
      }
    })
    .catch(async (err) => {
      switch (err.statusCode) {
        case 400:
          log('invalid request:', err)
          break
        case 401:
        case 403:
          log('auth error:', err)
          break
        case 404:
        case 410: {
          log('subscription expired or no longer valid:', err)
          const deletedSubscripton = await models.pushSubscription.delete({ where: { id } })
          log(`deleted subscription ${id} of user ${deletedSubscripton.userId} due to push error`)
          break
        }
        case 413:
          log('payload too large:', err)
          break
        case 429:
          log('too many requests:', err)
          break
        default:
          log('error:', err)
      }
    })
}

async function sendUserNotification (userId, notification) {
  try {
    if (!userId) {
      throw new Error('user id is required')
    }
    notification.data ??= {}
    if (notification.itemId) {
      // legacy Push API notificationclick event needs data.url as the navigate key is consumed by the browser
      notification.data.url ??= await createItemUrl(notification.itemId)
      // Declarative Web Push can't use relative paths
      notification.navigate ??= process.env.NEXT_PUBLIC_URL + notification.data.url
      delete notification.itemId
    }

    const filterFragment = userFilterFragment(notification.setting)

    const payload = createPayload(notification)
    const subscriptions = await models.pushSubscription.findMany({
      where: { userId, ...filterFragment }
    })
    await Promise.allSettled(
      subscriptions.map(subscription => sendNotification(subscription, payload))
    )
  } catch (err) {
    log('error sending user notification:', err)
  }
}

export async function sendPushSubscriptionReply (subscription) {
  try {
    const payload = createPayload({ title: 'Stasher News notifications are now active' })
    await sendNotification(subscription, payload)
  } catch (err) {
    log('error sending subscription reply:', err)
  }
}

export async function notifyUserSubscribers ({ models, item }) {
  try {
    const isPost = !!item.title

    const userSubsExcludingMutes = await models.$queryRaw`
      SELECT "UserSubscription"."followerId", "UserSubscription"."followeeId", users.name as "followeeName"
      FROM "UserSubscription"
      INNER JOIN users ON users.id = "UserSubscription"."followeeId"
      WHERE "followeeId" = ${Number(item.userId)}::INTEGER
        AND ${isPost ? Prisma.sql`"postsSubscribedAt"` : Prisma.sql`"commentsSubscribedAt"`} IS NOT NULL
        -- ignore muted users
        AND NOT EXISTS (
          SELECT 1
          FROM "Mute"
          WHERE "Mute"."muterId" = "UserSubscription"."followerId"
          AND "Mute"."mutedId" = ${Number(item.userId)}::INTEGER)
        -- ignore subscription if user was already notified of item as a reply
        AND NOT EXISTS (
          SELECT 1 FROM "Reply"
          INNER JOIN users follower ON follower.id = "UserSubscription"."followerId"
          WHERE "Reply"."itemId" = ${Number(item.id)}::INTEGER
          AND "Reply"."ancestorUserId" = follower.id
          AND follower."noteAllDescendants"
        )
        -- ignore subscription if user has posted to a territory the recipient is subscribed to
        ${isPost
          ? Prisma.sql`AND NOT EXISTS (
            SELECT 1
            FROM "SubSubscription"
            WHERE "SubSubscription"."userId" = "UserSubscription"."followerId"
            AND "SubSubscription"."subName" = ANY(${item.subNames})
          )`
          : Prisma.empty}`

    // Batch-fetch sat filter preferences in a single query instead of per-user
    const passingUserIds = await getUsersPassingSatFilter(
      userSubsExcludingMutes.map(sub => sub.followerId),
      item
    )

    await Promise.allSettled(
      userSubsExcludingMutes
        .filter(({ followerId }) => passingUserIds.has(followerId))
        .map(async ({ followerId, followeeName }) => sendUserNotification(followerId, {
          title: `@${followeeName} ${isPost ? 'created a post' : 'replied to a post'}`,
          body: isPost ? item.title : await pushBodyFor({ models, item }),
          itemId: item.id
        }))
    )
  } catch (err) {
    log('error sending user notification:', err)
  }
}

export async function notifyTerritorySubscribers ({ models, item }) {
  try {
    const isPost = !!item.title
    const { subNames } = item

    // only notify on posts in subs
    if (!isPost || !subNames?.length) return

    const territorySubsExcludingMuted = await models.$queryRaw`
      SELECT "userId", "subName"
      FROM "SubSubscription"
      WHERE "subName" = ANY(${subNames})
      AND NOT EXISTS (
        SELECT 1
        FROM "Mute" m
        WHERE m."muterId" = "SubSubscription"."userId"
        AND m."mutedId" = ${Number(item.userId)}::INTEGER
      )`

    const author = await models.user.findUnique({ where: { id: item.userId } })

    const subsExcludingAuthor = territorySubsExcludingMuted
      .filter(({ userId }) => userId !== author.id)

    // Batch-fetch sat filter preferences in a single query instead of per-user
    const passingUserIds = await getUsersPassingSatFilter(
      subsExcludingAuthor.map(sub => sub.userId),
      item
    )

    await Promise.allSettled(
      subsExcludingAuthor
        .filter(({ userId }) => passingUserIds.has(userId))
        .map(({ userId, subName }) =>
          sendUserNotification(userId, {
            title: `@${author.name} created a post in ~${subName}`,
            body: item.title,
            itemId: item.id
          }))
    )
  } catch (err) {
    log('error sending territory notification:', err)
  }
}

export async function notifyThreadSubscribers ({ models, item }) {
  try {
    const author = await models.user.findUnique({ where: { id: item.userId } })

    const subscribers = await models.$queryRaw`
      SELECT DISTINCT "ThreadSubscription"."userId" FROM "ThreadSubscription"
      JOIN users ON users.id = "ThreadSubscription"."userId"
      JOIN "Reply" r ON "ThreadSubscription"."itemId" = r."ancestorId"
      WHERE r."itemId" = ${item.id}
      -- don't send notifications for own items
      AND r."userId" <> "ThreadSubscription"."userId"
      -- send notifications for all levels?
      AND CASE WHEN users."noteAllDescendants" THEN TRUE ELSE r.level = 1 END
      -- muted?
      AND NOT EXISTS (SELECT 1 FROM "Mute" m WHERE m."muterId" = users.id AND m."mutedId" = r."userId")
      -- already received notification as reply to self?
      AND NOT EXISTS (
        SELECT 1 FROM "Item" i
        JOIN "Item" p ON p.path @> i.path
        WHERE i.id = ${item.parentId} AND p."userId" = "ThreadSubscription"."userId" AND users."noteAllDescendants"
      )`

    // Batch-fetch sat filter preferences in a single query instead of per-user
    const passingUserIds = await getUsersPassingSatFilter(
      subscribers.map(sub => sub.userId),
      item
    )

    await Promise.allSettled(
      subscribers
        .filter(({ userId }) => passingUserIds.has(userId))
        .map(async ({ userId }) =>
          sendUserNotification(userId, {
            title: `@${author.name} replied to a post`,
            body: await pushBodyFor({ models, item }),
            itemId: item.id
          })
        )
    )
  } catch (err) {
    log('error sending thread notification:', err)
  }
}

export async function notifyItemParents ({ models, item }) {
  try {
    const user = await models.user.findUnique({ where: { id: item.userId } })
    const parents = await models.$queryRaw`
      SELECT DISTINCT p."userId", i."userId" = p."userId" as "isDirect"
      FROM "Item" i
      JOIN "Item" p ON p.path @> i.path
      WHERE i.id = ${Number(item.parentId)} and p."userId" <> ${Number(user.id)}
      AND NOT EXISTS (
        SELECT 1 FROM "Mute" m
        WHERE m."muterId" = p."userId" AND m."mutedId" = ${Number(user.id)}
      )
      AND EXISTS (
        -- check that there is at least one parent subscribed to this thread
        SELECT 1 FROM "ThreadSubscription" ts WHERE p.id = ts."itemId" AND p."userId" = ts."userId"
      )`

    // Batch-fetch sat filter preferences in a single query instead of per-user
    const passingUserIds = await getUsersPassingSatFilter(
      parents.map(parent => parent.userId),
      item
    )

    await Promise.allSettled(
      parents
        .filter(({ userId }) => passingUserIds.has(userId))
        .map(async ({ userId, isDirect }) => {
          return sendUserNotification(userId, {
            title: `@${user.name} replied to you`,
            body: await pushBodyFor({ models, item }),
            itemId: item.id,
            setting: isDirect ? undefined : 'noteAllDescendants'
          })
        })
    )
  } catch (err) {
    log('error sending item parents notification:', err)
  }
}

export async function notifyZapped ({ models, item }) {
  try {
    const title = item.title
      ? `your post stashed ${piconerosToMXmr(item.piconeros)}`
      : `your reply stashed ${piconerosToMXmr(item.piconeros)}`

    await sendUserNotification(item.userId, {
      title,
      body: item.title ? item.title : indexableMoneroWallText(item),
      itemId: item.id,
      setting: 'noteItemPiconeros',
      tag: `TIP-${item.id}`
    })
  } catch (err) {
    log('error sending tip notification:', err)
  }
}

export async function notifyMention ({ models, userId, item }) {
  try {
    const muted = await isMuted({ models, muterId: userId, mutedId: item.userId })
    if (muted) return

    // Check if item meets user's sat filter
    if (!await meetsUserSatFilter(userId, item)) return

    await sendUserNotification(userId, {
      title: `@${item.user.name} mentioned you`,
      body: await pushBodyFor({ models, item }),
      itemId: item.id,
      setting: 'noteMentions'
    })
  } catch (err) {
    log('error sending mention notification:', err)
  }
}

export async function notifyItemMention ({ models, referrerItem, refereeItem }) {
  try {
    const muted = await isMuted({ models, muterId: refereeItem.userId, mutedId: referrerItem.userId })
    if (muted) return

    // Check if referrer item meets user's sat filter
    if (!await meetsUserSatFilter(refereeItem.userId, referrerItem)) return

    const referrer = await models.user.findUnique({ where: { id: referrerItem.userId } })

    // replace full links to #<id> syntax as rendered on site
    const body = (await pushBodyFor({ models, item: referrerItem })).replace(new RegExp(`${process.env.NEXT_PUBLIC_URL}/items/(\\d+)`, 'gi'), '#$1')

    await sendUserNotification(refereeItem.userId, {
      title: `@${referrer.name} mentioned one of your items`,
      body,
      itemId: referrerItem.id,
      setting: 'noteItemMentions'
    })
  } catch (err) {
    log('error sending item mention notification:', err)
  }
}

export async function notifyReferral (userId) {
  try {
    await sendUserNotification(userId, { title: 'someone joined via one of your referral links', tag: 'REFERRAL' })
  } catch (err) {
    log('error sending referral notification:', err)
  }
}

export async function notifyInvite (userId) {
  try {
    await sendUserNotification(userId, { title: 'your invite has been redeemed', tag: 'INVITE' })
  } catch (err) {
    log('error sending invite notification:', err)
  }
}

export async function notifyTerritoryTransfer ({ models, sub, to }) {
  try {
    await sendUserNotification(to.id, { title: `~${sub.name} was transferred to you` })
  } catch (err) {
    log('error sending territory transfer notification:', err)
  }
}

export const notifyTerritoryStatusChange = async ({ sub }) => {
  const dueDate = nextBillingWithGrace(sub)
  const days = Math.ceil((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24))
  const timeLeft = days === 1 ? 'tomorrow' : `in ${days} days`
  const title = sub.status === 'ACTIVE'
    ? `~${sub.name} is active again`
    : sub.status === 'GRACE'
      ? `~${sub.name}'s payment is due or it will be archived ${timeLeft}`
      : `~${sub.name} has been archived`

  try {
    await sendUserNotification(sub.userId, { title, tag: `TERRITORY_STATUS-${sub.name}`, navigate: process.env.NEXT_PUBLIC_URL + '/~' + sub.name })
  } catch (err) {
    console.error(err)
  }
}

export async function notifyEarner (userId, earnings) {
  const fmt = piconeros => piconerosToMXmr(piconeros)

  const title = `you stashed ${fmt(earnings.piconeros)} in rewards`
  let body = ''
  if (earnings.POST) body += `#${earnings.POST.bestRank} among posts with ${fmt(earnings.POST.piconeros)} in total\n`
  if (earnings.COMMENT) body += `#${earnings.COMMENT.bestRank} among comments with ${fmt(earnings.COMMENT.piconeros)} in total\n`
  if (earnings.TIP_POST) body += `#${earnings.TIP_POST.bestRank} in post tipping with ${fmt(earnings.TIP_POST.piconeros)} in total\n`
  if (earnings.TIP_COMMENT) body += `#${earnings.TIP_COMMENT.bestRank} in comment tipping with ${fmt(earnings.TIP_COMMENT.piconeros)} in total`

  try {
    await sendUserNotification(userId, { title, body, setting: 'noteEarning' })
  } catch (err) {
    log('error sending earn notification:', err)
  }
}

const STREAK_FOUND_TITLES = {
  VERIFIED: COPY.verifiedTitle
}
const STREAK_LOST_TITLES = {
  FLAME: 'you lost your flame'
}

export async function notifyNewStreak (userId, streak) {
  const index = streak.id % FOUND_BLURBS[streak.type].length
  const blurb = FOUND_BLURBS[streak.type][index]

  try {
    await sendUserNotification(userId, {
      title: STREAK_FOUND_TITLES[streak.type] || `you found a ${streak.type.toLowerCase().replace('_', ' ')}`,
      body: blurb,
      setting: 'noteBadges'
    })
  } catch (err) {
    log('error sending streak found notification:', err)
  }
}

export async function notifyFlameAdvanced (userId, { level, cycleDay, rewards }) {
  const parts = rewards.map(r => ({
    post: '+1 banked free post',
    reply: '+1 reply banked',
    boost: '+1 boost credit banked (0.5 mXMR ranking)',
    turfdiscount: `${TURF_DISCOUNT_PERCENT}% turf discount banked`
  })[r.kind]).filter(Boolean)
  let body
  if (level === 1) body = 'your flame is lit, keep the quests coming'
  else if (level % 7 === 4) body = 'flame day 4, your flame burns golden today'
  else body = `flame day ${cycleDay}`
  if (parts.length) body += ` · ${parts.join(' · ')}`
  try {
    await sendUserNotification(userId, { title: 'flame advanced', body, setting: 'noteQuests' })
  } catch (err) {
    log('error sending flame notification:', err)
  }
}

export async function notifyShieldUsed (userId) {
  try {
    await sendUserNotification(userId, {
      title: 'golden flame shield used',
      body: 'your golden flame absorbed a missed day, back to a regular flame',
      setting: 'noteQuests'
    })
  } catch (err) {
    log('error sending shield notification:', err)
  }
}

export async function notifyQuestCompleted (userId, quest) {
  const title = questTitle(quest) ?? quest.toLowerCase().replace('_', ' ')
  const amount = QUEST_REPLY_REWARDS[quest] ?? 1
  try {
    await sendUserNotification(userId, {
      title: 'quest complete',
      body: `${title}, +${amount} ${amount === 1 ? 'reply' : 'replies'} banked`,
      setting: 'noteQuests'
    })
  } catch (err) {
    log('error sending quest notification:', err)
  }
}

export async function notifyStreakLost (userId, streak) {
  const index = streak.id % LOST_BLURBS[streak.type].length
  const blurb = LOST_BLURBS[streak.type][index]

  try {
    await sendUserNotification(userId, {
      title: STREAK_LOST_TITLES[streak.type] || `you lost your ${streak.type.toLowerCase().replace('_', ' ')}`,
      body: blurb,
      setting: 'noteBadges'
    })
  } catch (err) {
    log('error sending streak lost notification:', err)
  }
}

export async function notifyReminder ({ userId, item }) {
  await sendUserNotification(userId, {
    title: 'you requested this reminder',
    body: item.title ?? indexableMoneroWallText(item),
    itemId: item.id
  })
}
