import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { decodeCursor, LIMIT, nextCursorEncoded } from '@/lib/cursor'
import { postingFeePrivatesFor, getCachedPlatformFeeConfig, canPostFree, commentQuotaFor, postQuotaFor, bankedReplyCredits } from '@/api/monero/postingFee'
import { flamePosition } from '@/lib/quests'
import { questDay, questResetsAt } from '@/lib/questClock'
import { resolveDraw } from '@/api/quests/draw'
import { completionsFor } from '@/api/quests/completions'
import { territoryFeePrivatesFor } from '@/api/monero/territoryFee'
import { resolveBoostCreditAvailability } from '@/api/quests/boost-credit'
import { bioSchema, settingsSchema, validateSchema, userSchema } from '@/lib/validate'
import { getItem, updateItem, filterClause, createItem, whereClause, muteClause, activeOrMine, payInJoinFilter } from './item'
import { USER_ID, PAY_IN_NOTIFICATION_TYPES, WALLET_RETRY_BEFORE_MS, WALLET_MAX_RETRIES, SN_SYSTEM_ONLY_IDS } from '@/lib/constants'
import { whenRange } from '@/lib/time'
import assertApiKeyNotPermitted from './apiKey'
import { isMuted } from '@/lib/user'
import { GqlAuthenticationError, GqlAuthorizationError, GqlInputError } from '@/lib/error'
import { processCrop } from '@/lib/imgproxy'
import { payInTypesSql } from '../payIn/lib/sql'
import { Prisma } from '@prisma/client'
import { enabledAuthMethods } from '@/lib/authProviderEnv'
import { phraseFingerprint } from '@/lib/recoveryPhrase'
import { isVerifiedBadgeEnabled } from '@/lib/verified-badge-flag'
import { checkNewsletterConfig, enrollContact, unsubscribeContact } from '@/lib/newsletter'
import { decryptEmail } from '@/lib/emailCrypto'
import { maskEmail } from '@/lib/crypto'
import { logWarn } from '@/lib/logger'

// The local newsletterOptIn flag is the source of truth; this best-effort push
// keeps Resend in step immediately (the daily newsletterSync reconcile
// backstops any miss). Never throws into the settings save. It applies the
// same safety guards as enroll/sync: a suppressed or unverified contact is
// never (re)subscribed, and an address the user would not recognize (hint
// drift) is never mailed.
async function pushNewsletterOptIn ({ models, me, optIn }) {
  if (optIn === undefined) return
  try {
    const missing = checkNewsletterConfig()
    const meRow = await models.user.findUnique({
      where: { id: me.id },
      select: { emailCiphertext: true, emailHint: true, emailVerified: true, newsletterSuppressed: true }
    })
    if (missing.length || !meRow?.emailCiphertext || !meRow.emailVerified) return
    const email = decryptEmail(meRow.emailCiphertext)
    if (meRow.emailHint && maskEmail({ email }) !== meRow.emailHint) return
    if (optIn) {
      if (meRow.newsletterSuppressed) return
      const r = await enrollContact({ email })
      if (r.ok && r.contactId) {
        try { await models.user.update({ where: { id: me.id }, data: { resendContactId: r.contactId } }) } catch (err) { logWarn('setSettings: newsletter contactId save failed', { code: err?.code }) }
      }
    } else {
      await unsubscribeContact({ email })
    }
  } catch (err) {
    logWarn('setSettings: newsletter push skipped', { code: err?.code })
  }
}

const contributors = new Set()

const loadContributors = async (set) => {
  try {
    const fileContent = await readFile(resolve(join(process.cwd(), 'contributors.txt')), 'utf-8')
    fileContent.split('\n')
      .map(line => line.trim())
      .filter(line => !!line)
      .forEach(name => set.add(name))
  } catch (err) {
    console.error('Error loading contributors', err)
  }
}

const DEFAULT_NAME_SIMILARITY = 0.1

function clampNameSimilarity (similarity = DEFAULT_NAME_SIMILARITY) {
  const threshold = Number(similarity)
  if (!Number.isFinite(threshold)) {
    return DEFAULT_NAME_SIMILARITY
  }

  return Math.max(0, Math.min(threshold, 1))
}

// linked-login booleans shared by the authMethods resolver and unlinkAuth's
// last-method guard. Keep the key set in sync with AUTH_METHOD_KEYS in
// lib/authMethods.js and the AuthMethods GraphQL type.
function authMethodLinks (user, oauthProviders) {
  return {
    lightning: !!user.pubkey,
    email: !!(user.emailVerified && user.emailHash),
    twitter: oauthProviders.indexOf('twitter') >= 0,
    github: oauthProviders.indexOf('github') >= 0,
    nostr: !!user.nostrAuthPubkey,
    phrase: !!user.phrasePubkey
  }
}

export async function authMethods (user, args, { models, me }) {
  const enabled = enabledAuthMethods()

  if (!me || me.id !== user.id) {
    return {
      lightning: false,
      email: false,
      twitter: false,
      github: false,
      nostr: false,
      phrase: false,
      enabled
    }
  }

  const accounts = await models.account.findMany({
    where: {
      userId: me.id
    }
  })

  const links = authMethodLinks(user, accounts.map(a => a.provider))

  return {
    ...links,
    emailHint: user.emailHint,
    phraseFingerprint: user.phrasePubkey ? phraseFingerprint(user.phrasePubkey) : null,
    apiKey: user.apiKeyEnabled ? !!user.apiKeyHash : null,
    enabled
  }
}

export async function topUsers (parent, { cursor, when, by = 'stacked', from, to, limit }, { models, me }) {
  const decodedCursor = decodeCursor(cursor)
  const [fromDate, toDate] = whenRange(when, from, to || decodeCursor.time)

  let column
  switch (by) {
    case 'stacked':
      column = Prisma.sql`stacked`; break
    case 'spent':
      column = Prisma.sql`spent`; break
    case 'items':
      column = Prisma.sql`nitems`; break
    case 'streak':
      column = Prisma.sql`streak`; break
    default:
      throw new GqlInputError('invalid sort')
  }

  const users = (await models.$queryRaw`
    WITH user_outgoing AS (
      SELECT x."userId", sum(x.piconeros)::bigint as spent
      FROM (
        SELECT d."downvoterId" AS "userId", d.piconeros
        FROM "ObservedDownvote" d
        WHERE d.state = 'CONFIRMED' AND d."downvoterId" IS NOT NULL
          AND d."confirmedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
          AND d."confirmedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
        UNION ALL
        SELECT p."userId", f.piconeros
        FROM "FeeObservation" f
        JOIN "PayIn" p ON p.id = f."payInId"
        WHERE f.state = 'CONFIRMED'
          AND f."confirmedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
          AND f."confirmedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
      ) x
      GROUP BY x."userId"
    ),
    user_item_counts AS (
      SELECT p."userId", count(*)::int as nitems
      FROM "PayIn" p
      WHERE p."payInType" = 'ITEM_CREATE' AND p."payInState" = 'PAID'
        AND p."payInStateChangedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
        AND p."payInStateChangedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
      GROUP BY p."userId"
    ),
    user_incoming AS (
      SELECT ma."ownerUserId" AS "userId", sum(t.piconeros)::bigint AS stacked
      FROM "ObservedTip" t
      JOIN "MoneroAccount" ma ON ma.id = t."recipientAccountId"
      WHERE t.state = 'CONFIRMED' AND ma."ownerUserId" IS NOT NULL
        AND t."confirmedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
        AND t."confirmedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
      GROUP BY ma."ownerUserId"
    ),
    user_stats AS (
      SELECT COALESCE(oo."userId", ic."userId", ii."userId") as "userId",
        COALESCE(oo."spent", 0) as spent, COALESCE(ic."nitems", 0) as nitems,
        COALESCE(ii."stacked", 0) as stacked
      FROM user_outgoing oo
      FULL JOIN user_item_counts ic ON ic."userId" = oo."userId"
      FULL JOIN user_incoming ii ON ii."userId" = COALESCE(oo."userId", ic."userId")
    )
    SELECT * FROM user_stats
    JOIN users ON user_stats."userId" = users.id
    WHERE users.id NOT IN (${Prisma.join([...SN_SYSTEM_ONLY_IDS, USER_ID.anon])})
      AND users."name" IS NOT NULL
    ORDER BY ${column} DESC NULLS LAST, users.created_at ASC
    OFFSET ${decodedCursor.offset}
    LIMIT ${limit}`
  ).map(
    u => u.hideFromTopUsers && (!me || me.id !== u.id) ? null : u
  )

  return {
    cursor: users.length === limit ? nextCursorEncoded(decodedCursor, limit) : null,
    users
  }
}

export default {
  Query: {
    me: async (parent, args, { models, me, userLoader }) => {
      if (!me?.id) {
        return null
      }

      return await userLoader.load(me.id)
    },
    settings: async (parent, args, { models, me, userLoader }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      return await userLoader.load(me.id)
    },
    user: async (parent, { id, name }, { models }) => {
      if (id) id = Number(id)
      if (!id && !name) {
        throw new GqlInputError('id or name is required')
      }
      return await models.user.findUnique({ where: { id, name } })
    },
    nameAvailable: async (parent, { name }, { models, me, userLoader }) => {
      let user
      if (me) {
        user = await userLoader.load(me.id)
      }
      return user?.name?.toUpperCase() === name?.toUpperCase() || !(await models.user.findUnique({ where: { name } }))
    },
    mySubscribedUsers: async (parent, { cursor }, { models, me }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const decodedCursor = decodeCursor(cursor)
      const users = await models.$queryRaw`
        SELECT users.*
        FROM "UserSubscription"
        JOIN users ON "UserSubscription"."followeeId" = users.id
        WHERE "UserSubscription"."followerId" = ${me.id}
        AND ("UserSubscription"."postsSubscribedAt" IS NOT NULL OR "UserSubscription"."commentsSubscribedAt" IS NOT NULL)
        OFFSET ${decodedCursor.offset}
        LIMIT ${LIMIT}
      `

      return {
        cursor: users.length === LIMIT ? nextCursorEncoded(decodedCursor) : null,
        users
      }
    },
    myMutedUsers: async (parent, { cursor }, { models, me }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const decodedCursor = decodeCursor(cursor)
      const users = await models.$queryRaw`
        SELECT users.*
        FROM "Mute"
        JOIN users ON "Mute"."mutedId" = users.id
        WHERE "Mute"."muterId" = ${me.id}
        OFFSET ${decodedCursor.offset}
        LIMIT ${LIMIT}
      `

      return {
        cursor: users.length === LIMIT ? nextCursorEncoded(decodedCursor) : null,
        users
      }
    },
    topCowboys: async (parent, { cursor }, { models, me }) => {
      const { users, cursor: topCowboysCursor } = await topUsers(parent, { cursor, when: 'forever', by: 'streak', limit: LIMIT }, { models, me })
      const cowboys = users.map(u => (u?.hideBadges && (!me || me.id !== u.id)) ? null : u).filter(u => u?.streak !== null)
      return {
        cursor: cowboys.length === LIMIT ? topCowboysCursor : null,
        users: cowboys
      }
    },
    userSuggestions: async (parent, { q, limit }, { models }) => {
      let users = []
      if (q) {
        users = await models.$queryRaw`
          SELECT name
          FROM search_users_by_name(${q}::text, ${DEFAULT_NAME_SIMILARITY}::real, ${Number(limit)}::integer)`
      } else {
        users = await models.$queryRaw`
          SELECT u.name
          FROM "ObservedTip" t
          JOIN "MoneroAccount" ma ON ma.id = t."recipientAccountId"
          JOIN users u ON u.id = ma."ownerUserId"
          WHERE t.state = 'CONFIRMED' AND ma."ownerUserId" IS NOT NULL
            AND NOT u."hideFromTopUsers"
            AND u."name" IS NOT NULL
          GROUP BY u.id, u.name, u.created_at
          ORDER BY sum(t.piconeros) DESC, u.created_at ASC
          LIMIT ${limit}`
      }

      return users
    },
    topUsers,
    hasNewNotes: async (parent, { viewedItemId } = {}, ctx) => {
      const { me, models, userLoader } = ctx
      if (!me) {
        return false
      }
      const user = await userLoader.load(me.id)
      // stale session (user row deleted): no notes to report
      if (!user) {
        return false
      }
      const lastChecked = user.checkedNotesAt || new Date(0)

      // viewedItemId: the user just opened this item, so the item page already
      // shows any post, reply or mention inside its subtree. Leave those out of
      // the item checks below; if nothing else is new, the checkedNotesAt bump
      // at the end clears the bell.
      let viewedPath = null
      const viewedId = Number(viewedItemId)
      if (Number.isSafeInteger(viewedId) && viewedId > 0) {
        const [viewed] = await models.$queryRaw`
          SELECT path::text AS path FROM "Item" WHERE id = ${viewedId}`
        viewedPath = viewed?.path || null
      }
      const notViewed = viewedPath ? 'NOT COALESCE("Item".path <@ $3::ltree, false)' : null
      const viewedParams = viewedPath ? [viewedPath] : []

      // if we've already recorded finding notes after they last checked, return true
      // this saves us from rechecking notifications
      // (an item view rechecks, since the viewed item may be what was found)
      if (!viewedPath && user.foundNotesAt > lastChecked) {
        return true
      }

      // this is a performance optimization, so we don't want to block the connection
      // by trying to update the user if the user is locked
      const foundNotes = () => {
        models.$queryRaw`
          UPDATE users
          SET "foundNotesAt" = now(), "lastSeenAt" = now()
          WHERE "id" = (
            SELECT "id" FROM users WHERE "id" = ${me.id}
            -- non-key best-effort update: NO KEY UPDATE skips only on real writers,
            -- not on benign KEY SHARE FK-insert locks, and never blocks (SKIP LOCKED)
            FOR NO KEY UPDATE SKIP LOCKED
          )`.catch(console.error)
      }

      const [newBulletin] = await models.$queryRawUnsafe(`
        SELECT EXISTS(
          SELECT *
          FROM "NotificationBulletin"
          WHERE "NotificationBulletin"."created_at" > $1)`, lastChecked)
      if (newBulletin.exists) {
        foundNotes()
        return true
      }

      // check if any votes have been cast for them since checkedNotesAt
      if (user.noteItemPiconeros) {
        const [newSats] = await models.$queryRawUnsafe(`
          SELECT EXISTS(
            SELECT *
            FROM "Item"
            WHERE "Item"."lastTipAt" > $2
            AND "Item"."userId" = $1)`, me.id, lastChecked)
        if (newSats.exists) {
          foundNotes()
          return true
        }
      }

      // break out thread subscription to decrease the search space of the already expensive reply query
      const [newThreadSubReply] = await models.$queryRawUnsafe(`
        SELECT EXISTS(
          SELECT *
          FROM "ThreadSubscription"
          JOIN "Reply" r ON "ThreadSubscription"."itemId" = r."ancestorId"
          JOIN "Item" ON r."itemId" = "Item".id
          ${whereClause(
            '"ThreadSubscription"."userId" = $1',
            'r.created_at > $2',
            'r.created_at >= "ThreadSubscription".created_at',
            'r."userId" <> $1',
            '"Item"."deletedAt" IS NULL',
            activeOrMine(me),
            await filterClause(null, null, null, ctx),
            muteClause(me),
            ...(user.noteAllDescendants ? [] : ['r.level = 1']),
            notViewed
          )})`, me.id, lastChecked, ...viewedParams)
      if (newThreadSubReply.exists) {
        foundNotes()
        return true
      }

      const [newUserSubs] = await models.$queryRawUnsafe(`
        SELECT EXISTS(
          SELECT *
          FROM "UserSubscription"
          JOIN "Item" ON "UserSubscription"."followeeId" = "Item"."userId"
          ${payInJoinFilter(me)}
          ${whereClause(
            '"UserSubscription"."followerId" = $1',
            '"Item".created_at > $2',
            `(
              ("Item"."parentId" IS NULL AND "UserSubscription"."postsSubscribedAt" IS NOT NULL AND "Item".created_at >= "UserSubscription"."postsSubscribedAt")
              OR ("Item"."parentId" IS NOT NULL AND "UserSubscription"."commentsSubscribedAt" IS NOT NULL AND "Item".created_at >= "UserSubscription"."commentsSubscribedAt")
            )`,
            activeOrMine(me),
            await filterClause(null, null, null, ctx),
            muteClause(me),
            notViewed)})`, me.id, lastChecked, ...viewedParams)
      if (newUserSubs.exists) {
        foundNotes()
        return true
      }

      const [newSubPost] = await models.$queryRawUnsafe(`
        SELECT EXISTS(
          SELECT *
          FROM "SubSubscription"
          JOIN "Item" ON "Item"."subNames" @> ARRAY["SubSubscription"."subName"]::CITEXT[]
          ${payInJoinFilter(me)}
          ${whereClause(
            '"SubSubscription"."userId" = $1',
            '"Item".created_at > $2',
            '"Item"."parentId" IS NULL',
            '"Item"."userId" <> $1',
            activeOrMine(me),
            await filterClause(null, null, null, ctx),
            muteClause(me),
            notViewed)})`, me.id, lastChecked, ...viewedParams)
      if (newSubPost.exists) {
        foundNotes()
        return true
      }

      // check if they have any mentions since checkedNotesAt
      if (user.noteMentions) {
        const [newMentions] = await models.$queryRawUnsafe(`
        SELECT EXISTS(
          SELECT *
          FROM "Mention"
          JOIN "Item" ON "Mention"."itemId" = "Item".id
          ${whereClause(
            '"Mention"."userId" = $1',
            '"Mention".created_at > $2',
            '"Item"."userId" <> $1',
            activeOrMine(me),
            await filterClause(null, null, null, ctx),
            muteClause(me),
            notViewed
          )})`, me.id, lastChecked, ...viewedParams)
        if (newMentions.exists) {
          foundNotes()
          return true
        }
      }

      if (user.noteItemMentions) {
        const [newMentions] = await models.$queryRawUnsafe(`
        SELECT EXISTS(
          SELECT *
          FROM "ItemMention"
          JOIN "Item" "Referee" ON "ItemMention"."refereeId" = "Referee".id
          JOIN "Item" ON "ItemMention"."referrerId" = "Item".id
          ${whereClause(
            '"ItemMention".created_at > $2',
            '"Item"."userId" <> $1',
            '"Referee"."userId" = $1',
            activeOrMine(me),
            await filterClause(null, null, null, ctx),
            muteClause(me),
            notViewed
          )})`, me.id, lastChecked, ...viewedParams)
        if (newMentions.exists) {
          foundNotes()
          return true
        }
      }

      if (user.noteEarning) {
        const earn = await models.earn.findFirst({
          where: {
            userId: me.id,
            createdAt: {
              gt: lastChecked
            },
            piconeros: {
              gte: 1000
            }
          }
        })
        if (earn) {
          foundNotes()
          return true
        }
        const [newBountyAward] = await models.$queryRawUnsafe(`
          SELECT EXISTS(
            SELECT *
            FROM "BountyPayment"
            WHERE "BountyPayment"."winnerUserId" = $1
              AND "BountyPayment".kind = 'AWARD'
              AND "BountyPayment".state IN ('SENT', 'CONFIRMED')
              AND COALESCE("BountyPayment"."confirmedAt", "BountyPayment"."sentAt") > $2)`, me.id, lastChecked)
        if (newBountyAward.exists) {
          foundNotes()
          return true
        }
      }

      // check if new invites have been redeemed
      if (user.noteInvites) {
        const [newInvites] = await models.$queryRawUnsafe(`
          SELECT EXISTS(
            SELECT *
            FROM users JOIN "Invite" on users."inviteId" = "Invite".id
            WHERE "Invite"."userId" = $1
            AND users.created_at > $2)`, me.id, lastChecked)
        if (newInvites.exists) {
          foundNotes()
          return true
        }

        const referral = await models.user.findFirst({
          where: {
            referrerId: me.id,
            createdAt: {
              gt: lastChecked
            }
          }
        })
        if (referral) {
          foundNotes()
          return true
        }
      }

      if (user.noteBadges) {
        // Mirror the notifications list's badge surface (api/resolvers/
        // notifications.js): ended flames and verified badges only. An ACTIVE
        // flame's updatedAt bumps on every day-clear advance, but the advance
        // chronicle entries are noteQuests-gated — matching those rows here
        // rings the bell for entries the dropdown then hides (M5 residual,
        // 2026-09-26 review).
        const streak = await models.streak.findFirst({
          where: {
            userId: me.id,
            updatedAt: {
              gt: lastChecked
            },
            OR: [
              { type: 'FLAME', endedAt: { not: null } },
              { type: 'VERIFIED' }
            ]
          }
        })

        if (streak) {
          foundNotes()
          return true
        }
      }

      const subStatus = await models.sub.findFirst({
        where: {
          userId: me.id,
          statusUpdatedAt: {
            gt: lastChecked
          },
          status: {
            not: 'ACTIVE'
          }
        }
      })

      if (subStatus) {
        foundNotes()
        return true
      }

      const newReminder = await models.reminder.findFirst({
        where: {
          userId: me.id,
          remindAt: {
            gt: lastChecked,
            lt: new Date()
          }
        }
      })
      if (newReminder) {
        foundNotes()
        return true
      }

      const [invoiceActionFailed] = await models.$queryRaw`
        SELECT EXISTS(
          SELECT *
          FROM "PayIn"
          WHERE "PayIn"."payInState" = 'FAILED'
          AND "PayIn"."payInType" IN (${payInTypesSql(PAY_IN_NOTIFICATION_TYPES)})
          AND "PayIn"."userId" = ${me.id}
          AND "PayIn"."successorId" IS NULL
          -- help the query planner by narrowing the range of the timestamp
          AND "PayIn"."payInStateChangedAt" > ${lastChecked}::timestamp - ${`${WALLET_RETRY_BEFORE_MS} milliseconds`}::interval
          AND (
            (
              "PayIn"."payInFailureReason" = 'USER_CANCELLED'
              AND "PayIn"."payInStateChangedAt" > ${lastChecked}::timestamp
            )
            OR (
              "PayIn"."payInStateChangedAt" <= now() - ${`${WALLET_RETRY_BEFORE_MS} milliseconds`}::interval
              AND "PayIn"."payInStateChangedAt" > ${lastChecked}::timestamp - ${`${WALLET_RETRY_BEFORE_MS} milliseconds`}::interval
            )
            OR (
              "PayIn"."retryCount" >= ${WALLET_MAX_RETRIES}
              AND "PayIn"."payInStateChangedAt" > ${lastChecked}::timestamp
            )
          )
        )`

      if (invoiceActionFailed.exists) {
        foundNotes()
        return true
      }

      // quest complete + flame day bell entries derive from quest completions
      // — gated by the same noteQuests setting as the notifications list
      // (api/resolvers/notifications.js), or the bell rings for entries the
      // dropdown then hides (M5, 2026-09-26 review).
      if (user.noteQuests) {
        const [newQuest] = await models.$queryRaw`
          SELECT EXISTS(
            SELECT *
            FROM "QuestCompletion"
            WHERE "QuestCompletion"."userId" = ${me.id}
            AND "QuestCompletion"."created_at" > ${lastChecked})`
        if (newQuest.exists) {
          foundNotes()
          return true
        }
      }

      // update checkedNotesAt to prevent rechecking same time period
      models.$queryRaw`
        UPDATE users
        SET "checkedNotesAt" = now(), "lastSeenAt" = now()
        WHERE "id" = (
          SELECT "id" FROM users WHERE "id" = ${me.id}
          -- non-key best-effort update: NO KEY UPDATE skips only on real writers,
          -- not on benign KEY SHARE FK-insert locks, and never blocks (SKIP LOCKED)
          FOR NO KEY UPDATE SKIP LOCKED
        )`.catch(console.error)

      return false
    },
    searchUsers: async (parent, { q, limit, similarity }, { models }) => {
      return await models.$queryRaw`
        SELECT *
        FROM search_users_by_name(${q}::text, ${clampNameSimilarity(similarity)}::real, ${Number(limit)}::integer)`
    }
  },

  Mutation: {
    setName: async (parent, data, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      await validateSchema(userSchema, data, { models })

      try {
        await models.user.update({ where: { id: me.id }, data })
        return data.name
      } catch (error) {
        if (error.code === 'P2002') {
          throw new GqlInputError('name taken')
        }
        throw error
      }
    },
    setSettings: async (parent, { settings: { nostrRelays, tipDefault, ...data } }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      await validateSchema(settingsSchema, { nostrRelays, tipDefault, ...data })

      const settingsData = tipDefault !== undefined
        ? { ...data, tipDefaultPiconeros: tipDefault }
        : data

      if (nostrRelays?.length) {
        const connectOrCreate = []
        for (const nr of nostrRelays) {
          await models.nostrRelay.upsert({
            where: { addr: nr },
            update: { addr: nr },
            create: { addr: nr }
          })
          connectOrCreate.push({
            where: { userId_nostrRelayAddr: { userId: me.id, nostrRelayAddr: nr } },
            create: { nostrRelayAddr: nr }
          })
        }

        const updated = await models.user.update({ where: { id: me.id }, data: { ...settingsData, nostrRelays: { deleteMany: {}, connectOrCreate } } })
        await pushNewsletterOptIn({ models, me, optIn: data.newsletterOptIn })
        return updated
      } else {
        const updated = await models.user.update({ where: { id: me.id }, data: { ...settingsData, nostrRelays: { deleteMany: {} } } })
        await pushNewsletterOptIn({ models, me, optIn: data.newsletterOptIn })
        return updated
      }
    },
    setWalkthrough: async (parent, { upvotePopover, tipPopover }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      await models.user.update({ where: { id: me.id }, data: { upvotePopover, tipPopover } })

      return true
    },
    cropPhoto: async (parent, { photoId, cropData }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const croppedUrl = await processCrop({ photoId: Number(photoId), cropData })
      if (!croppedUrl) {
        throw new GqlInputError('can\'t crop photo')
      }

      return croppedUrl
    },
    setPhoto: async (parent, { photoId }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      await models.user.update({
        where: { id: me.id },
        data: { photoId: Number(photoId) }
      })

      return Number(photoId)
    },
    upsertBio: async (parent, { text, sendProtocolId }, ctx) => {
      const { me, userLoader } = ctx
      if (!me) {
        throw new GqlAuthenticationError()
      }

      await validateSchema(bioSchema, { text })

      const user = await userLoader.load(me.id)

      if (user?.bioId) {
        return await updateItem(parent, { id: user.bioId, bio: true, text, title: `@${user?.name}'s bio`, sendProtocolId }, ctx)
      } else {
        return await createItem(parent, { bio: true, text, title: `@${user?.name}'s bio`, sendProtocolId }, ctx)
      }
    },
    generateApiKey: async (parent, { id }, { models, me, userLoader }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const user = await userLoader.load(me.id)
      if (!user?.apiKeyEnabled) {
        throw new GqlAuthorizationError('you are not allowed to generate api keys')
      }

      // I trust postgres CSPRNG more than the one from JS
      const [{ apiKey, apiKeyHash }] = await models.$queryRaw`
      SELECT "apiKey", encode(digest("apiKey", 'sha256'), 'hex') AS "apiKeyHash"
      FROM (
        SELECT encode(gen_random_bytes(32), 'base64')::CHAR(32) as "apiKey"
      ) rng`
      await models.user.update({ where: { id: me.id }, data: { apiKeyHash } })

      return apiKey
    },
    deleteApiKey: async (parent, { id }, { models, me }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      return await models.user.update({ where: { id: me.id }, data: { apiKeyHash: null } })
    },
    unlinkAuth: async (parent, { authType, lastAuthConfirm = false }, { models, me }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      assertApiKeyNotPermitted({ me })

      // Serializable: two concurrent unlinks of the last two methods must not
      // both pass the count on stale reads (the loser aborts with P2034, the
      // client retries and then sees the correct count). Same idiom as
      // api/monero/selfTip.js.
      let pendingNewsletterUnsubEmail = null
      const result = await models.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: me.id } })
        if (!user) {
          throw new GqlAuthenticationError()
        }

        // same semantics as the client's last-method count: platform-enabled ∩ linked
        const accounts = await tx.account.findMany({ where: { userId: me.id } })
        const links = authMethodLinks(user, accounts.map(a => a.provider))
        const enabled = enabledAuthMethods()
        const remaining = enabled.filter(k => links[k] && k !== authType)

        if (!lastAuthConfirm && links[authType] && enabled.includes(authType) && remaining.length === 0) {
          throw new GqlInputError('unlinking your last auth method will permanently lock you out of this account. if you really want this, pass lastAuthConfirm: true')
        }

        let updated
        if (authType === 'twitter' || authType === 'github') {
          const account = await tx.account.findFirst({ where: { userId: me.id, provider: authType } })
          if (!account) {
            throw new GqlInputError('no such account')
          }
          await tx.account.delete({ where: { id: account.id } })
          if (authType === 'twitter') {
            updated = await tx.user.update({ where: { id: me.id }, data: { hideTwitter: true, twitterId: null } })
          } else {
            updated = await tx.user.update({ where: { id: me.id }, data: { hideGithub: true, githubId: null } })
          }
        } else if (authType === 'lightning') {
          updated = await tx.user.update({ where: { id: me.id }, data: { pubkey: null } })
        } else if (authType === 'nostr') {
          updated = await tx.user.update({ where: { id: me.id }, data: { hideNostr: true, nostrAuthPubkey: null } })
        } else if (authType === 'phrase') {
          updated = await tx.user.update({ where: { id: me.id }, data: { phrasePubkey: null } })
        } else if (authType === 'email') {
          // capture the address before it is erased so the newsletter contact
          // can be unsubscribed after the transaction — a cleared ciphertext
          // would otherwise strand a subscribed Resend contact forever, with no
          // Settings surface left to control it
          const prev = await tx.user.findUnique({ where: { id: me.id }, select: { emailCiphertext: true, newsletterOptIn: true } })
          if (prev?.emailCiphertext && prev.newsletterOptIn) {
            try { pendingNewsletterUnsubEmail = decryptEmail(prev.emailCiphertext) } catch { /* undecryptable: operator/reconcile handles */ }
          }
          updated = await tx.user.update({
            where: { id: me.id },
            data: { email: null, emailVerified: null, emailHash: null, emailHint: null, emailCiphertext: null, newsletterOptIn: false, resendContactId: null }
          })
        } else {
          throw new GqlInputError('no such account')
        }

        return await authMethods(updated, undefined, { models: tx, me })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

      // best-effort, post-transaction (never network inside the tx): stop the
      // newsletter at Resend for the address we just detached
      if (pendingNewsletterUnsubEmail && !checkNewsletterConfig().length) {
        try {
          await unsubscribeContact({ email: pendingNewsletterUnsubEmail })
        } catch (err) {
          logWarn('unlinkAuth: newsletter unsubscribe failed', { code: err?.code })
        }
      }
      return result
    },
    subscribeUserPosts: async (parent, { id }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      const lookupData = { followerId: Number(me.id), followeeId: Number(id) }
      const existing = await models.userSubscription.findUnique({ where: { followerId_followeeId: lookupData } })
      const muted = await isMuted({ models, muterId: me?.id, mutedId: id })
      if (existing) {
        if (muted && !existing.postsSubscribedAt) {
          throw new GqlInputError("you can't subscribe to a stasher that you've muted")
        }
        await models.userSubscription.update({ where: { followerId_followeeId: lookupData }, data: { postsSubscribedAt: existing.postsSubscribedAt ? null : new Date() } })
      } else {
        if (muted) {
          throw new GqlInputError("you can't subscribe to a stasher that you've muted")
        }
        await models.userSubscription.create({ data: { ...lookupData, postsSubscribedAt: new Date() } })
      }
      return { id }
    },
    subscribeUserComments: async (parent, { id }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      const lookupData = { followerId: Number(me.id), followeeId: Number(id) }
      const existing = await models.userSubscription.findUnique({ where: { followerId_followeeId: lookupData } })
      const muted = await isMuted({ models, muterId: me?.id, mutedId: id })
      if (existing) {
        if (muted && !existing.commentsSubscribedAt) {
          throw new GqlInputError("you can't subscribe to a stasher that you've muted")
        }
        await models.userSubscription.update({ where: { followerId_followeeId: lookupData }, data: { commentsSubscribedAt: existing.commentsSubscribedAt ? null : new Date() } })
      } else {
        if (muted) {
          throw new GqlInputError("you can't subscribe to a stasher that you've muted")
        }
        await models.userSubscription.create({ data: { ...lookupData, commentsSubscribedAt: new Date() } })
      }
      return { id }
    },
    toggleMute: async (parent, { id }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      const lookupData = { muterId: Number(me.id), mutedId: Number(id) }
      const where = { muterId_mutedId: lookupData }
      const existing = await models.mute.findUnique({ where })
      if (existing) {
        await models.mute.delete({ where })
      } else {
        // check to see if current user is subscribed to the target user, and disallow mute if so
        const subscription = await models.userSubscription.findUnique({
          where: {
            followerId_followeeId: {
              followerId: Number(me.id),
              followeeId: Number(id)
            }
          }
        })
        if (subscription?.postsSubscribedAt || subscription?.commentsSubscribedAt) {
          throw new GqlInputError("you can't mute a stasher to whom you've subscribed")
        }
        await models.mute.create({ data: { ...lookupData } })
      }
      return { id }
    }
  },

  User: {
    privates: async (user, args, { me, models }) => {
      if (!me || me.id !== user.id) {
        return null
      }

      return user
    },
    optional: user => user,
    meSubscriptionPosts: async (user, args, { me, models }) => {
      if (!me) return false
      if (typeof user.meSubscriptionPosts !== 'undefined') return user.meSubscriptionPosts

      const subscription = await models.userSubscription.findUnique({
        where: {
          followerId_followeeId: {
            followerId: Number(me.id),
            followeeId: Number(user.id)
          }
        }
      })

      return !!subscription?.postsSubscribedAt
    },
    meSubscriptionComments: async (user, args, { me, models }) => {
      if (!me) return false
      if (typeof user.meSubscriptionComments !== 'undefined') return user.meSubscriptionComments

      const subscription = await models.userSubscription.findUnique({
        where: {
          followerId_followeeId: {
            followerId: Number(me.id),
            followeeId: Number(user.id)
          }
        }
      })

      return !!subscription?.commentsSubscribedAt
    },
    meMute: async (user, args, { me, models }) => {
      if (!me) return false
      if (typeof user.meMute !== 'undefined') return user.meMute

      return await isMuted({ models, muterId: me.id, mutedId: user.id })
    },
    since: async (user, args, { models }) => {
      // get the user's first item
      const item = await models.item.findFirst({
        where: {
          userId: user.id,
          itemPayIns: {
            some: {
              payIn: {
                payInState: 'PAID',
                payInType: 'ITEM_CREATE'
              }
            }
          }
        },
        orderBy: {
          createdAt: 'asc'
        }
      })
      return item?.id
    },
    nitems: async (user, { when, from, to }, { models }) => {
      if (typeof user.nitems !== 'undefined') {
        return user.nitems
      }

      const [gte, lte] = whenRange(when, from, to)
      return await models.payIn.count({
        where: {
          userId: user.id,
          payInStateChangedAt: {
            gte,
            lte
          },
          payInType: 'ITEM_CREATE',
          payInState: 'PAID'
        }
      })
    },
    nterritories: async (user, { when, from, to }, { models }) => {
      if (typeof user.nterritories !== 'undefined') {
        return user.nterritories
      }

      const [gte, lte] = whenRange(when, from, to)
      return await models.sub.count({
        where: {
          userId: user.id,
          status: 'ACTIVE',
          createdAt: {
            gte,
            lte
          }
        }
      })
    },
    bio: async (user, args, { models, me }) => {
      return getItem(user, { id: user.bioId }, { models, me })
    }
  },

  UserPrivates: {
    piconeros: async (user, args, { models, me }) => {
      if (!me || me.id !== user.id) {
        return 0n
      }
      // floor each bucket once so `piconeros - credits === user.stackedPiconeros`
      return BigInt(user.stackedPiconeros ?? 0) + BigInt(user.stackedCredits ?? 0)
    },
    credits: async (user, args, { models, me }) => {
      if (!me || me.id !== user.id) {
        return 0
      }
      return Number(user.stackedCredits ?? 0n)
    },
    tipDefault: user => user.tipDefaultPiconeros,
    authMethods,
    hasInvites: async (user, args, { models }) => {
      const invites = await models.user.findUnique({
        where: { id: user.id }
      }).invites({ take: 1 })

      return invites.length > 0
    },
    nostrRelays: async (user, args, { models, me }) => {
      if (user.id !== me.id) {
        return []
      }

      const relays = await models.userNostrRelay.findMany({
        where: { userId: user.id }
      })

      return relays?.map(r => r.nostrRelayAddr)
    },
    tipRandom: async (user, args, { me }) => {
      if (!me || me.id !== user.id) {
        return false
      }
      return !!user.tipRandomMin && !!user.tipRandomMax
    },
    freeCommentCount: (user) => {
      // Reset counter if past reset date
      if (user.freeCommentResetAt && new Date() >= new Date(user.freeCommentResetAt)) {
        return 0
      }
      return user.freeCommentCount || 0
    },
    freeCommentsLeft: async (user, args, { models }) =>
      (await commentQuotaFor(models, user)).left,
    freeCommentsQuota: async (user, args, { models }) =>
      (await commentQuotaFor(models, user)).quota,
    freeReplyCredits: async (user, args, { models }) =>
      (await bankedReplyCredits(models, user.id)).credits,
    questUpvoteComplete: async (user, args, { models }) =>
      (await questStateFor(models, user)).upvoteComplete,
    questDrawnType: async (user, args, { models }) =>
      (await questStateFor(models, user)).drawnType,
    questDrawnComplete: async (user, args, { models }) =>
      (await questStateFor(models, user)).drawnComplete,
    questsCompletedToday: async (user, args, { models }) =>
      (await questStateFor(models, user)).questsCompleted,
    flameCycleDay: async (user, args, { models }) =>
      user.streak == null ? 0 : flamePosition(user.streak, (await questStateFor(models, user)).questsCompleted === 2).day,
    flameWeek: async (user, args, { models }) =>
      user.streak == null ? 0 : flamePosition(user.streak, (await questStateFor(models, user)).questsCompleted === 2).week,
    goldFlame: async (user, args, { models }) => {
      const streak = await models.streak.findFirst({
        where: { userId: user.id, type: 'FLAME', endedAt: null },
        select: { goldActive: true }
      })
      return streak?.goldActive ?? false
    },
    turfDiscountHeld: async (user, args, { models }) => heldReward(models, user.id, 'TURF_DISCOUNT'),
    // Day-5 boost credit view (spec 2026-10-05-quest-rebalance-boost-credit).
    // Both fields await ONE per-request availability read: the context object
    // is built fresh per request (pages/api/graphql.js), so it is a safe
    // memoization key — unlike the process-wide `models` client — and
    // resolveBoostCreditAvailability caches the promise on it. A grant landing
    // between the two field resolutions can therefore never mix an id from one
    // row with an expiry from another (spec §5.2 "resolve both from the same
    // available-credit reader"), and the read issues once per request. The
    // explicit identity guard below is what keeps a foreign request from ever
    // reaching the ledger (no foreign leakage).
    boostCreditId: async (user, args, ctx) => {
      if (String(ctx.me?.id) !== String(user.id)) return null
      return (await resolveBoostCreditAvailability(ctx, user.id))?.id ?? null
    },
    boostCreditExpiresAt: async (user, args, ctx) => {
      if (String(ctx.me?.id) !== String(user.id)) return null
      return (await resolveBoostCreditAvailability(ctx, user.id))?.expiresAt ?? null
    },
    questResetsAt: () => questResetsAt(),
    freePostCount: (user) => {
      if (user.freePostResetAt && new Date() >= new Date(user.freePostResetAt)) {
        return 0
      }
      return user.freePostCount || 0
    },
    freePostsLeft: async (user, args, { models }) =>
      (await postQuotaFor(models, user)).left,
    freePostsQuota: async (user, args, { models }) =>
      (await postQuotaFor(models, user)).baseQuota,
    freePostCredits: async (user, args, { models }) =>
      (await postQuotaFor(models, user)).credits,
    freePostCreditsExpireAt: async (user, args, { models }) =>
      (await postQuotaFor(models, user)).nextExpiresAt,
    postingFeeRequired: async (user, args, { models, me }) =>
      (await postingFeePrivatesFor(models, user, me?.id)).postingFeeRequired,
    postingFeePiconeros: async (user, args, { models, me }) =>
      (await postingFeePrivatesFor(models, user, me?.id)).postingFeePiconeros,
    postingFeeFloorPiconeros: async (user, args, { models, me }) =>
      (await postingFeePrivatesFor(models, user, me?.id)).postingFeeFloorPiconeros,
    freePostThresholdPiconeros: async (user, args, { models, me }) =>
      (await postingFeePrivatesFor(models, user, me?.id)).freePostThresholdPiconeros,
    freePostMinAgeDays: async (user, args, { models, me }) =>
      (await postingFeePrivatesFor(models, user, me?.id)).freePostMinAgeDays,
    territoryMonthlyPiconeros: async (user, args, { models, me }) =>
      (await territoryFeePrivatesFor(models, me?.id)).territoryMonthlyPiconeros,
    territoryYearlyPiconeros: async (user, args, { models, me }) =>
      (await territoryFeePrivatesFor(models, me?.id)).territoryYearlyPiconeros,
    territoryOncePiconeros: async (user, args, { models, me }) =>
      (await territoryFeePrivatesFor(models, me?.id)).territoryOncePiconeros,
    commentFeePiconeros: async (user, args, { models, me }) =>
      (await territoryFeePrivatesFor(models, me?.id)).commentFeePiconeros,
    turfOwnerFees: () => process.env.TURF_OWNER_FEES === '1'
  },

  UserOptional: {
    streak: async (user, args, { models, me }) => {
      if (user.hideBadges && (!me || me.id !== user.id)) {
        return null
      }

      return user.streak
    },
    goldFlame: async (user, args, { models, me }) => {
      if (user.hideBadges && (!me || me.id !== user.id)) {
        return false
      }

      const streak = await models.streak.findFirst({
        where: { userId: user.id, type: 'FLAME', endedAt: null },
        select: { goldActive: true }
      })
      return streak?.goldActive ?? false
    },
    hasWallet: async (user, args, { models, me }) => {
      if (!isVerifiedBadgeEnabled()) return false

      if (user.hideBadges && (!me || me.id !== user.id)) {
        return false
      }

      const account = await models.moneroAccount.findFirst({ where: { ownerUserId: user.id } })
      if (!account) return false
      const config = await getCachedPlatformFeeConfig(models)
      if (!config) return false
      // Feed/comment user objects often omit createdAt/stackedPiconeros; fetch
      // them so canPostFree can compute. (hasWallet already does a per-user
      // moneroAccount query, so this adds at most one lightweight lookup.)
      const u = (user.createdAt != null && user.stackedPiconeros != null)
        ? user
        : await models.user.findUnique({ where: { id: user.id }, select: { stackedPiconeros: true, createdAt: true } })
      if (!u) return false
      return canPostFree(u, config)
    },
    maxStreak: async (user, args, { models, me }) => {
      if (user.hideBadges && (!me || me.id !== user.id)) {
        return null
      }

      const [{ max }] = await models.$queryRaw`
        SELECT MAX(COALESCE("endedAt"::date, (now() AT TIME ZONE 'America/Chicago')::date) - "startedAt"::date)
        FROM "Streak" WHERE "userId" = ${user.id}
        AND type = 'FLAME'`
      return max
    },
    isContributor: async (user, args, { me }) => {
      // lazy init contributors only once
      if (contributors.size === 0) {
        await loadContributors(contributors)
      }
      return contributors.has(user.name)
    },
    stacked: async (user, { when, from, to }, { models, me }) => {
      if ((!me || me.id !== user.id) && (user.hideFromTopUsers || user.hideStashAmount)) {
        return null
      }

      if (typeof user.stacked !== 'undefined') {
        return user.stacked
      }

      if (!when || when === 'forever') {
        // forever
        return user.stackedPiconeros || 0n
      }

      const [fromDate, toDate] = whenRange(when, from, to)
      const [{ stacked }] = await models.$queryRaw`
        SELECT COALESCE(sum(t.piconeros), 0) as stacked
        FROM "ObservedTip" t
        JOIN "MoneroAccount" ma ON ma.id = t."recipientAccountId"
        WHERE t.state = 'CONFIRMED' AND ma."ownerUserId" = ${user.id}
          AND t."confirmedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
          AND t."confirmedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz`
      return BigInt(stacked)
    },
    stashAmountHidden: (user, args, { me }) =>
      !!user.hideStashAmount && (!me || me.id !== user.id),
    spent: async (user, { when, from, to }, { models, me }) => {
      if ((!me || me.id !== user.id) && user.hideFromTopUsers) {
        return null
      }

      if (typeof user.spent !== 'undefined') {
        return user.spent
      }

      const [fromDate, toDate] = whenRange(when, from, to)
      const [{ spent }] = await models.$queryRaw`
        SELECT COALESCE(sum(x.piconeros), 0) as spent
        FROM (
          SELECT d.piconeros
          FROM "ObservedDownvote" d
          WHERE d.state = 'CONFIRMED' AND d."downvoterId" = ${user.id}
            AND d."confirmedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
            AND d."confirmedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
          UNION ALL
          SELECT f.piconeros
          FROM "FeeObservation" f
          JOIN "PayIn" p ON p.id = f."payInId"
          WHERE f.state = 'CONFIRMED' AND p."userId" = ${user.id}
            AND f."confirmedAt" AT TIME ZONE 'UTC' >= ${fromDate}::timestamptz
            AND f."confirmedAt" AT TIME ZONE 'UTC' <= ${toDate}::timestamptz
        ) x`
      return BigInt(spent)
    },
    referrals: async (user, { when, from, to }, { models, me }) => {
      if ((!me || me.id !== user.id) && user.hideFromTopUsers) {
        return null
      }

      if (typeof user.referrals !== 'undefined') {
        return user.referrals
      }

      const [gte, lte] = whenRange(when, from, to)
      return await models.user.count({
        where: {
          referrerId: user.id,
          createdAt: {
            gte,
            lte
          }
        }
      })
    },
    githubId: async (user, args, { me }) => {
      if ((!me || me.id !== user.id) && user.hideGithub) {
        return null
      }
      return user.githubId
    },
    twitterId: async (user, args, { models, me }) => {
      if ((!me || me.id !== user.id) && user.hideTwitter) {
        return null
      }
      return user.twitterId
    },
    nostrAuthPubkey: async (user, args, { models, me }) => {
      if ((!me || me.id !== user.id) && user.hideNostr) {
        return null
      }
      return user.nostrAuthPubkey
    }
  }
}

// --- quest privates helpers (spec 2026-09-23-daily-quests) ---

/** Today's draw + completions bundle for the module's privates fields. */
async function questStateFor (models, user) {
  const day = questDay()
  const draw = await resolveDraw(models, user.id, day)
  const done = await completionsFor(models, { userId: user.id, day, draw })
  return {
    upvoteComplete: !!done[draw.upvote],
    drawnType: draw.drawn,
    drawnComplete: !!done[draw.drawn],
    questsCompleted: [draw.upvote, draw.drawn].filter(q => done[q]).length
  }
}

async function heldReward (models, userId, type) {
  return !!(await models.streakReward.findFirst({
    where: { userId, type, consumedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true }
  }))
}
