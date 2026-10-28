// Data gathering for the weekly email digest. Queries mirror the notification
// sources in api/resolvers/notifications.js but are window-delimited and
// `note*`-gated so email never surfaces something a user muted in-app —
// including the community highlights, which are filtered by each user's
// user and territory mutes.

const DAY_MS = 24 * 60 * 60 * 1000
const PER_KIND_LIMIT = 10
const SUBSCRIPTION_LIMIT = 5
const SUBSCRIPTION_POOL_LIMIT = 20

// Monerowall-covered discussions (2026-10-14): a comment whose thread root
// walls the discussion never enters the digest — the email renders text
// excerpts that bypass app-side gating and any recipient may be unentitled.
// Posts pass untouched (rootId IS NULL → the NOT EXISTS never matches).
const notCommentWallClause = (alias = 'Item') => `
       AND NOT EXISTS (
         SELECT 1 FROM "Item" root
         WHERE root.id = "${alias}"."rootId"
           AND root."moneroWallEnabledAt" IS NOT NULL
           AND root."moneroWallRemovedAt" IS NULL
           AND root."moneroWallCoversComments" = TRUE
           AND root."moneroWallCommentsRemovedAt" IS NULL)`

export function computeWindow ({ lastSentAt, now, defaultWindowDays = 7, maxWindowDays = 30 }) {
  const floor = now.getTime() - maxWindowDays * DAY_MS
  const from = lastSentAt
    ? new Date(Math.max(lastSentAt.getTime(), floor))
    : new Date(now.getTime() - defaultWindowDays * DAY_MS)
  return { from, to: now }
}

// Global pause switch (EMAIL_DIGEST_ENABLED). Default enabled; only the exact
// string 'false' disables. Read at job start, so changing it requires
// recreating the worker process that holds the env.
export function isEmailDigestEnabled (env = process.env) {
  return env.EMAIL_DIGEST_ENABLED !== 'false'
}

// One bounded query per run: eligible users who have never received a digest
// or whose last one is at least 7 days old, oldest first (NULLs first), so a
// backlog drips out fairly across daily runs. Skip-empty users are included
// here and filtered later — they advance their watermark but never consume the
// daily send budget.
export async function getDigestCandidates ({ models, staleBefore, take = 500 }) {
  return await models.user.findMany({
    where: {
      emailNotifications: true,
      emailVerified: { not: null },
      emailCiphertext: { not: null },
      OR: [
        { emailDigestSentAt: null },
        { emailDigestSentAt: { lte: staleBefore } }
      ]
    },
    orderBy: [
      { emailDigestSentAt: { sort: 'asc', nulls: 'first' } },
      { id: 'asc' }
    ],
    take
  })
}

async function getReplies ({ models, user, from, to }) {
  // DISTINCT: Reply holds one row per ancestor of a comment and the recipient
  // is auto-subscribed to every item they author, so a noteAllDescendants user
  // with several of their own items up one thread matches the same reply once
  // per subscription. All selected columns are copied from the comment, so the
  // dupes are exact duplicates (the notifications page dedupes the same join
  // with DISTINCT ON (id)).
  return await models.$queryRawUnsafe(
    `SELECT DISTINCT "Item".id, "Item".title, "Item".text, "Item"."moneroWallEnabledAt", "Item"."moneroWallRemovedAt", u.name AS "userName", r."created_at" AS "sortTime"
     FROM "ThreadSubscription"
     JOIN "Reply" r ON "ThreadSubscription"."itemId" = r."ancestorId"
     JOIN "Item" ON r."itemId" = "Item".id
     JOIN users u ON u.id = "Item"."userId"
     WHERE "ThreadSubscription"."userId" = $1
       AND r."created_at" >= "ThreadSubscription".created_at
       AND r."created_at" > $2
       AND r."created_at" <= $3
       AND r."userId" <> $1
       AND ($4::boolean OR r.level = 1)
       AND "Item"."deletedAt" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "Mute" m WHERE m."muterId" = $1 AND m."mutedId" = "Item"."userId")
       AND NOT EXISTS (SELECT 1 FROM "MuteSub" ms WHERE ms."userId" = $1 AND ms."subName" = ANY("Item"."subNames"))${notCommentWallClause()}
     ORDER BY "sortTime" DESC
     LIMIT ${PER_KIND_LIMIT + 1}`,
    user.id, from, to, !!user.noteAllDescendants
  )
}

async function getMentions ({ models, user, from, to }) {
  return await models.$queryRawUnsafe(
    `SELECT "Item".id, "Item".title, "Item".text, "Item"."moneroWallEnabledAt", "Item"."moneroWallRemovedAt", u.name AS "userName", "Item".created_at AS "sortTime"
     FROM "Mention"
     JOIN "Item" ON "Mention"."itemId" = "Item".id
     JOIN users u ON u.id = "Item"."userId"
     WHERE "Mention"."userId" = $1
       AND "Item"."userId" <> $1
       AND "Item".created_at > $2
       AND "Item".created_at <= $3
       AND "Item"."deletedAt" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "Mute" m WHERE m."muterId" = $1 AND m."mutedId" = "Item"."userId")
       AND NOT EXISTS (SELECT 1 FROM "MuteSub" ms WHERE ms."userId" = $1 AND ms."subName" = ANY("Item"."subNames"))${notCommentWallClause()}
     ORDER BY "sortTime" DESC
     LIMIT ${PER_KIND_LIMIT + 1}`,
    user.id, from, to
  )
}

async function getItemMentions ({ models, user, from, to }) {
  return await models.$queryRawUnsafe(
    `SELECT "Referrer".id, "Referrer".title, "Referrer".text, "Referrer"."moneroWallEnabledAt", "Referrer"."moneroWallRemovedAt", u.name AS "userName", "ItemMention".created_at AS "sortTime"
     FROM "ItemMention"
     JOIN "Item" "Referee" ON "ItemMention"."refereeId" = "Referee".id
     JOIN "Item" "Referrer" ON "ItemMention"."referrerId" = "Referrer".id
     JOIN users u ON u.id = "Referrer"."userId"
     WHERE "Referee"."userId" = $1
       AND "Referrer"."userId" <> $1
       AND "ItemMention".created_at > $2
       AND "ItemMention".created_at <= $3
       AND "Referrer"."deletedAt" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "Mute" m WHERE m."muterId" = $1 AND m."mutedId" = "Referrer"."userId")
       AND NOT EXISTS (SELECT 1 FROM "MuteSub" ms WHERE ms."userId" = $1 AND ms."subName" = ANY("Referrer"."subNames"))${notCommentWallClause('Referrer')}
     ORDER BY "sortTime" DESC
     LIMIT ${PER_KIND_LIMIT + 1}`,
    user.id, from, to
  )
}

async function getFollowActivity ({ models, user, from, to }) {
  return await models.$queryRawUnsafe(
    `SELECT "Item".id, "Item".title, "Item".text, "Item"."moneroWallEnabledAt", "Item"."moneroWallRemovedAt", "Item"."subNames", u.name AS "userName", "Item".created_at AS "sortTime"
     FROM "Item"
     JOIN "UserSubscription" ON "Item"."userId" = "UserSubscription"."followeeId"
     JOIN users u ON u.id = "Item"."userId"
     WHERE "UserSubscription"."followerId" = $1
       AND "Item"."userId" <> $1
       AND "Item".created_at > $2
       AND "Item".created_at <= $3
       AND "Item"."deletedAt" IS NULL
       AND "Item".bio = false
       AND (
         ("Item"."parentId" IS NULL AND "UserSubscription"."postsSubscribedAt" IS NOT NULL AND "Item".created_at >= "UserSubscription"."postsSubscribedAt")
         OR ("Item"."parentId" IS NOT NULL AND "UserSubscription"."commentsSubscribedAt" IS NOT NULL AND "Item".created_at >= "UserSubscription"."commentsSubscribedAt")
       )
       AND NOT EXISTS (SELECT 1 FROM "Mute" m WHERE m."muterId" = $1 AND m."mutedId" = "Item"."userId")
       AND NOT EXISTS (SELECT 1 FROM "MuteSub" ms WHERE ms."userId" = $1 AND ms."subName" = ANY("Item"."subNames"))${notCommentWallClause()}
     ORDER BY "Item".created_at DESC
     LIMIT $4`,
    user.id, from, to, SUBSCRIPTION_POOL_LIMIT
  )
}

async function getTerritoryActivity ({ models, user, from, to }) {
  return await models.$queryRawUnsafe(
    `SELECT "Item".id, "Item".title, "Item".text, "Item"."moneroWallEnabledAt", "Item"."moneroWallRemovedAt", "Item"."subNames", u.name AS "userName", "Item".created_at AS "sortTime"
     FROM "Item"
     JOIN "SubSubscription" ON "Item"."subNames" @> ARRAY["SubSubscription"."subName"]::CITEXT[]
     JOIN users u ON u.id = "Item"."userId"
     WHERE "SubSubscription"."userId" = $1
       AND "Item"."userId" <> $1
       AND "Item"."parentId" IS NULL
       AND "Item".created_at >= "SubSubscription".created_at
       AND "Item".created_at > $2
       AND "Item".created_at <= $3
       AND "Item"."deletedAt" IS NULL
       AND "Item".bio = false
       AND NOT EXISTS (SELECT 1 FROM "Mute" m WHERE m."muterId" = $1 AND m."mutedId" = "Item"."userId")
       AND NOT EXISTS (SELECT 1 FROM "MuteSub" ms WHERE ms."userId" = $1 AND ms."subName" = ANY("Item"."subNames"))
     ORDER BY "Item".created_at DESC
     LIMIT $4`,
    user.id, from, to, SUBSCRIPTION_POOL_LIMIT
  )
}

// Merge the two subscription sources into one section: dedupe by item id
// (a post from someone you follow in a turf you follow appears once), drop
// items already shown under replies/mentions, order by recency (mirroring the
// notifications page), and cap.
export function mergeSubscriptions (followRows, territoryRows, { limit = SUBSCRIPTION_LIMIT, excludeIds = new Set() } = {}) {
  const merged = new Map()
  for (const row of [...followRows, ...territoryRows]) {
    const id = String(row.id)
    if (excludeIds.has(id) || merged.has(id)) continue
    merged.set(id, row)
  }
  const items = [...merged.values()].sort((a, b) => new Date(b.sortTime) - new Date(a.sortTime))
  return { items: items.slice(0, limit), hasMore: items.length > limit }
}

async function getSubscribedActivity ({ models, user, from, to, excludeIds }) {
  const [followRows, territoryRows] = await Promise.all([
    getFollowActivity({ models, user, from, to }),
    getTerritoryActivity({ models, user, from, to })
  ])
  return mergeSubscriptions(followRows, territoryRows, { excludeIds })
}

function takeKind (rows) {
  return { items: rows.slice(0, PER_KIND_LIMIT), hasMore: rows.length > PER_KIND_LIMIT }
}

export async function gatherDigest ({ models, user, now, defaultWindowDays = 7, maxWindowDays = 30 }) {
  const { from, to } = computeWindow({ lastSentAt: user.emailDigestSentAt, now, defaultWindowDays, maxWindowDays })

  const [repliesRaw, mentionsRaw, itemMentionsRaw] = await Promise.all([
    getReplies({ models, user, from, to }),
    user.noteMentions ? getMentions({ models, user, from, to }) : [],
    user.noteItemMentions ? getItemMentions({ models, user, from, to }) : []
  ])

  // A reply that also surfaces as a mention renders once, as a mention —
  // mirroring the notifications page, where DISTINCT ON keeps the
  // higher-priority Mention over the Reply for the same item id.
  const mentionIds = new Set([...mentionsRaw, ...itemMentionsRaw].map(i => String(i.id)))
  const replies = takeKind(repliesRaw.filter(r => !mentionIds.has(String(r.id))))
  const mentions = takeKind(mentionsRaw)
  const itemMentions = takeKind(itemMentionsRaw)

  // Subscription activity deliberately has no `note*` gate (the subscription is
  // the consent); it excludes anything already surfaced as a reply or mention.
  const excludeIds = new Set([...replies.items, ...mentions.items, ...itemMentions.items].map(i => String(i.id)))
  const subscriptions = await getSubscribedActivity({ models, user, from, to, excludeIds })

  return {
    windowStart: from,
    windowEnd: to,
    replies: replies.items,
    mentions: mentions.items,
    itemMentions: itemMentions.items,
    subscriptions: subscriptions.items,
    repliesTruncated: replies.hasMore,
    mentionsTruncated: mentions.hasMore || itemMentions.hasMore,
    subscriptionsTruncated: subscriptions.hasMore,
    hasPersonalActivity: replies.items.length + mentions.items.length + itemMentions.items.length + subscriptions.items.length > 0
  }
}

export function pickHighlights (rows, { limit = 5, maxPerSub = 2 } = {}) {
  const picked = []
  const perSub = new Map()
  for (const row of rows) {
    const key = row.subNames?.[0] ?? '(uncategorized)'
    const used = perSub.get(key) ?? 0
    if (used >= maxPerSub) continue
    picked.push(row)
    perSub.set(key, used + 1)
    if (picked.length === limit) break
  }
  return picked
}

export async function getCommunityHighlights ({ models, from, to, user, poolSize = 20 }) {
  const rows = await models.$queryRawUnsafe(
    `SELECT "Item".id, "Item".title, "Item"."subNames", "Item".piconeros, "Item".ncomments, u.name AS "userName"
     FROM "Item"
     JOIN users u ON u.id = "Item"."userId"
     WHERE "Item".created_at > $1 AND "Item".created_at <= $2
       AND "Item"."parentId" IS NULL
       AND "Item".title IS NOT NULL
       AND "Item"."deletedAt" IS NULL
       AND "Item".bio = false
       AND NOT EXISTS (SELECT 1 FROM "Sub" s WHERE s.name = ANY("Item"."subNames") AND s.nsfw)
       AND NOT EXISTS (SELECT 1 FROM "Mute" m WHERE m."muterId" = $4 AND m."mutedId" = "Item"."userId")
       AND NOT EXISTS (SELECT 1 FROM "MuteSub" ms WHERE ms."userId" = $4 AND ms."subName" = ANY("Item"."subNames"))
     ORDER BY "Item".ranktop DESC, "Item".id DESC
     LIMIT $3`,
    from, to, poolSize, user.id
  )
  return pickHighlights(rows)
}
