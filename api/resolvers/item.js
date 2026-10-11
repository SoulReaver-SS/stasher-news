import { ensureProtocol, removeTracking, stripTrailingSlash } from '@/lib/url'
import { snFetch } from '@/lib/fetch'
import { decodeCursor, nextCursorEncoded } from '@/lib/cursor'
import { getMetadata, metadataRuleSets } from 'page-metadata-parser'
import { ruleSet as publicationDateRuleSet } from '@/lib/timedate-scraper'
import domino from 'domino'
import {
  ITEM_SPAM_INTERVAL,
  COMMENT_TYPE_QUERY,
  USER_ID, POLL_COST, ADMIN_ITEMS,
  NOFOLLOW_LIMIT, UNKNOWN_LINK_REL, SN_ADMIN_IDS,
  ITEM_EDIT_SECONDS,
  DEFAULT_POSTS_PICONEROS_FILTER,
  DEFAULT_COMMENTS_PICONEROS_FILTER,
  HOMEPAGE_POSTS_PICONEROS_FILTER,
  MAX_ITEM_TURFS
} from '@/lib/constants'
import { unshorten } from '@/lib/unshorten'
import { actSchema, bountySchema, commentSchema, discussionSchema, jobSchema, linkSchema, pollSchema, repostSchema, validateSchema } from '@/lib/validate'
import { string } from '@/lib/yup'
import { defaultCommentSort, isJob, deleteItemByAuthor } from '@/lib/item'
import { itemPostType } from '@/lib/subs'
import { datePivot, whenRange } from '@/lib/time'
import { uploadIdsFromText } from './upload'
import { makeExcerpt } from '@/lib/excerpt'
import assertGofacYourself from './ofac'
import assertApiKeyNotPermitted from './apiKey'
import { GqlAuthenticationError, GqlInputError } from '@/lib/error'
// Named import (never the barrel): keep boost-credit.js independent of
// item.js — the wrapper below injects this module's getItem as ctx.readItem.
import { useBoostCredit as redeemBoostCredit } from './boost-credit'
import { assertItemCreateAllowance } from '@/api/payIn/itemCreateAllowance'
import { parse } from 'tldts'
import { shuffleArray } from '@/lib/rand'
import pay from '../payIn'
import { lexicalHTMLGenerator } from '@/lib/lexical/server/html'
import { resolveItemComments } from './comment-tree'
import { itemFeeReentryFunding, feeReceivedPiconerosForPayIn } from '@/api/monero/postingFee'
import {
  moneroWallEnabled, splitMoneroWallText, stripMoneroWallMarker, buildMoneroWallView, moneroWallUpdateError
} from '@/lib/monero-wall'
import { canonicalXStatus } from '@/lib/x-preview/status-url'

export async function getItem (parent, { id }, { me, models }) {
  const [item] = await getItemsById([id], { me, models })
  return item
}

export async function getItemsById (ids, { me, models }) {
  const uniqueIds = [...new Set(ids.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0))]
  if (uniqueIds.length === 0) return []

  const values = uniqueIds.map((id, index) => `(${id}, ${index})`).join(',')
  const items = await itemQueryWithMeta({
    me,
    models,
    query: `
      WITH requested(id, rank) AS (VALUES ${values})
      ${SELECT}, rank
      FROM "Item"
      JOIN requested ON "Item".id = requested.id
      ${payInJoinFilter(me)}
      ${whereClause(activeOrMine(me))}`,
    orderBy: 'ORDER BY rank ASC'
  })

  return items.map(({ rank, ...item }) => item)
}

const orderByClause = (by, me, models, type, sub) => {
  switch (by) {
    case 'comments':
      return 'ORDER BY "Item".ncomments DESC'
    case 'sats':
      return 'ORDER BY "Item".ranktop DESC, "Item".id DESC'
    case 'downsats':
      return 'ORDER BY "Item"."downPiconeros" DESC'
    default:
      return `ORDER BY ${type === 'bookmarks' ? '"bookmarkCreatedAt"' : '"Item".created_at'} DESC`
  }
}

// this grabs all the stuff we need to display the item list and only
// hits the db once ... orderBy needs to be duplicated on the outer query because
// joining does not preserve the order of the inner query
export async function itemQueryWithMeta ({ me, models, query, orderBy = '' }, ...args) {
  if (!me) {
    return await models.$queryRawUnsafe(`
      SELECT "Item".*, to_json(users.*) as user, "subs".subs as subs, to_jsonb("PayIn".*) as "payIn"
      FROM (
        ${query}
      ) "Item"
      JOIN users ON "Item"."userId" = users.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(json_agg("Sub".*), '[]') as subs
        FROM "Sub"
        WHERE "Sub"."name" = ANY("Item"."subNames")
      ) "subs" ON true
      LEFT JOIN LATERAL (
        SELECT "PayIn".*
        FROM "ItemPayIn"
        JOIN "PayIn" ON "PayIn".id = "ItemPayIn"."payInId" AND "PayIn"."payInType" = 'ITEM_CREATE'
        WHERE "ItemPayIn"."itemId" = "Item".id AND "PayIn"."payInState" = 'PAID'
        ORDER BY "PayIn"."created_at" DESC
        LIMIT 1
      ) "PayIn" ON "PayIn".id IS NOT NULL
      ${orderBy}`, ...args)
  } else {
    return await models.$queryRawUnsafe(`
      SELECT "Item".*, to_jsonb(users.*) || jsonb_build_object('meMute', "Mute"."mutedId" IS NOT NULL) as user,
        COALESCE("MeItemPayIn"."meMsats", 0) as "meMsats", COALESCE("MeItemPayIn"."mePendingMsats", 0) as "mePendingMsats",
        COALESCE("MeItemPayIn"."meMcredits", 0) as "meMcredits", COALESCE("MeItemPayIn"."mePendingMcredits", 0) as "mePendingMcredits",
        COALESCE("MeItemPayIn"."meDontLikeMsats", 0) as "meDontLikeMsats", COALESCE("MeItemPayIn"."mePendingDontLikeMsats", 0) as "mePendingDontLikeMsats",
        COALESCE("MeItemPayIn"."mePendingBoostMsats", 0) as "mePendingBoostMsats",
        b."itemId" IS NOT NULL AS "meBookmark", "ThreadSubscription"."itemId" IS NOT NULL AS "meSubscription",
        "subs".subs as subs,
        to_jsonb("PayIn".*) || jsonb_build_object('payInStateChangedAt', "PayIn"."payInStateChangedAt" AT TIME ZONE 'UTC') as "payIn",
        "CommentsViewAt"."last_viewed_at" as "meCommentsViewedAt"
      FROM (
        ${query}
      ) "Item"
      JOIN users ON "Item"."userId" = users.id
      LEFT JOIN "Mute" ON "Mute"."muterId" = ${me.id} AND "Mute"."mutedId" = "Item"."userId"
      LEFT JOIN "Bookmark" b ON b."itemId" = "Item".id AND b."userId" = ${me.id}
      LEFT JOIN "ThreadSubscription" ON "ThreadSubscription"."itemId" = "Item".id AND "ThreadSubscription"."userId" = ${me.id}
      LEFT JOIN "CommentsViewAt" ON "CommentsViewAt"."itemId" = "Item".id AND "CommentsViewAt"."userId" = ${me.id}
      LEFT JOIN LATERAL (
        SELECT COALESCE(json_agg("Sub".*), '[]') as subs
        FROM (
          SELECT "Sub".*, "MuteSub"."userId" IS NOT NULL as "meMuteSub", "SubSubscription"."userId" IS NOT NULL as "meSubscription"
          FROM "Sub"
          LEFT JOIN "MuteSub" ON "Sub"."name" = "MuteSub"."subName" AND "MuteSub"."userId" = ${me.id}
          LEFT JOIN "SubSubscription" ON "Sub"."name" = "SubSubscription"."subName" AND "SubSubscription"."userId" = ${me.id}
          WHERE "Sub"."name" = ANY("Item"."subNames")
        ) "Sub"
      ) "subs" ON true
      -- StasherNews: the viewer's tips/downvotes on this item come from
      -- ItemUserAgg (unique on itemId+userId, maintained at DETECTION by
      -- applyTipDetected/applyDownvotePenalty — the same events that bump
      -- Item.piconeros), NOT PayIn: tips never create PayIns and DOWNVOTE
      -- PayIns are born PAID with piconeros=0n. The pending* columns are
      -- literal 0 because the old PayIn pending FILTERs were always empty in
      -- the fork (no TIP PayIns; DOWNVOTE/BOOST PayIns are born PAID).
      LEFT JOIN LATERAL (
        SELECT
          a."tipPiconeros" AS "meMsats",
          0::bigint AS "mePendingMsats",
          NULL::bigint AS "meMcredits",
          NULL::bigint AS "mePendingMcredits",
          a."downvotePiconeros" AS "meDontLikeMsats",
          0::bigint AS "mePendingDontLikeMsats",
          0::bigint AS "mePendingBoostMsats"
        FROM "ItemUserAgg" a
        WHERE a."itemId" = "Item".id AND a."userId" = ${me.id}
      ) "MeItemPayIn" ON true
      LEFT JOIN LATERAL (
        SELECT "PayIn".*
        FROM "ItemPayIn"
        JOIN "PayIn" ON "PayIn".id = "ItemPayIn"."payInId" AND "PayIn"."payInType" = 'ITEM_CREATE'
        WHERE "ItemPayIn"."itemId" = "Item".id AND ("PayIn"."userId" = ${me.id} OR "PayIn"."payInState" = 'PAID')
        ORDER BY "PayIn"."created_at" DESC
        LIMIT 1
      ) "PayIn" ON "PayIn".id IS NOT NULL
      ${orderBy}`, ...args)
  }
}

const relationClause = (type) => {
  let clause = ''
  switch (type) {
    case 'bookmarks':
      clause += ' FROM "Item" JOIN "Bookmark" ON "Bookmark"."itemId" = "Item"."id" LEFT JOIN "Item" root ON "Item"."rootId" = root.id '
      break
    case 'comments':
    case 'freebies':
    case 'desperados':
    case 'all':
      clause += ' FROM "Item" LEFT JOIN "Item" root ON "Item"."rootId" = root.id '
      break
    default: // posts which are their own root
      clause += ' FROM "Item" '
  }

  return clause
}

// Full body text to serve/render. A removed wall is inert but removal never
// rewrites the stored text, so the now-meaningless marker line is stripped;
// items that never had a wall are served verbatim.
function moneroWallFullText (item) {
  if (item.moneroWallRemovedAt != null) return stripMoneroWallMarker(item.text)
  return item.text
}

/**
 * Monerowall view for the current viewer, or null for non-walled items (and
 * removed walls). One DataLoader load per walled item per request.
 */
export async function moneroWallStateFor (item, { me, moneroWallLoader }) {
  if (!moneroWallEnabled(item)) return null
  const state = await moneroWallLoader.load({ id: item.id, enabledAt: item.moneroWallEnabledAt })
  return buildMoneroWallView({ item, meId: me?.id ?? null, ...state })
}

// Text to render for the current viewer: full (marker stripped) when
// entitled/author, teaser otherwise.
async function moneroWallRenderText (item, ctx) {
  if (!moneroWallEnabled(item)) return moneroWallFullText(item)
  const view = await moneroWallStateFor(item, ctx)
  if (!view || !view.locked) return stripMoneroWallMarker(item.text)
  return splitMoneroWallText(item.text).teaserText
}

export const excerptResolver = async (item, args, ctx) => {
  if (item.excerpt != null) return item.excerpt
  if (!moneroWallEnabled(item)) return makeExcerpt(moneroWallFullText(item))
  const view = await moneroWallStateFor(item, ctx)
  if (view?.publiclyUnlocked) return makeExcerpt(stripMoneroWallMarker(item.text))
  return makeExcerpt(splitMoneroWallText(item.text).teaserText)
}

// True iff the item was created as a freebie: a zero-cost comment or bio.
// Reads the stored `Item.freebie` column, NOT `cost === 0` — a post is never a
// freebie, even when its `cost` is 0 (e.g. a post that paid the posting fee but
// carried no per-item cost). Keeps the badge (components/item-info.js) and the
// `freebies` feed filter consistent with creation semantics in
// api/payIn/types/itemCreate.js.
export function isFreebieItem (item) {
  return !!item.freebie
}

export const payInJoinFilter = me => {
  if (me) {
    return `
      JOIN "ItemPayIn" ON "ItemPayIn"."itemId" = "Item".id
      JOIN "PayIn" ON "PayIn".id = "ItemPayIn"."payInId" AND "PayIn"."payInType" = 'ITEM_CREATE'
        AND (("PayIn"."userId" = ${me.id} AND "PayIn"."successorId" IS NULL) OR "PayIn"."payInState" = 'PAID')
    `
  }

  return `
      JOIN "ItemPayIn" ON "ItemPayIn"."itemId" = "Item".id
      JOIN "PayIn" ON "PayIn".id = "ItemPayIn"."payInId" AND "PayIn"."payInType" = 'ITEM_CREATE'
        AND "PayIn"."payInState" = 'PAID'
    `
}

const selectClause = (type) => type === 'bookmarks'
  ? `${SELECT}, "Bookmark"."created_at" as "bookmarkCreatedAt"`
  : SELECT

const subClauseTable = (type) => COMMENT_TYPE_QUERY.includes(type) ? 'root' : 'Item'

export const whereClause = (...clauses) => {
  const clause = clauses.flat(Infinity).filter(c => c).join(' AND ')
  return clause ? ` WHERE ${clause} ` : ''
}

function whenClause (when, table) {
  return `"${table}".created_at <= $2 and "${table}".created_at >= $1`
}

export const activeOrMine = (me) => {
  // StasherNews posting-fee gate (§6.2, Q8): a PENDING_FEE item is invisible to
  // everyone except its author until the rewardsWalletObserver observes its posting fee and
  // flips feeStatus to FEE_PAID. (Existing items default to FEE_NOT_REQUIRED.)
  //
  // StasherNews bounty gate (A-13): an unfunded bounty — bountyPiconeros = 0
  // with bountyStatus UNFUNDED/PENDING_FUNDING/DETECTED — is likewise invisible
  // to everyone except its author until the funding payment confirms (FUNDED).
  // Non-bounty items are identified by bountyPiconeros = 0, NOT by bountyStatus
  // (its column default is UNFUNDED for every non-bounty item). The inner
  // "userId = me.id" lets the author watch their pending funding's progress;
  // the outer OR is the existing per-viewer override.
  return me
    ? `(("Item".status <> 'STOPPED'
        AND COALESCE("Item"."feeStatus", 'FEE_NOT_REQUIRED') <> 'PENDING_FEE'
        AND ("Item"."bountyPiconeros" = 0
          OR "Item"."bountyStatus" IN ('FUNDED','EXPIRED','AWARDED','REFUNDED','ROLLED_OVER')
          OR "Item"."userId" = ${me.id}))
       OR "Item"."userId" = ${me.id})`
    : `("Item".status <> 'STOPPED'
        AND COALESCE("Item"."feeStatus", 'FEE_NOT_REQUIRED') <> 'PENDING_FEE'
        AND ("Item"."bountyPiconeros" = 0
          OR "Item"."bountyStatus" IN ('FUNDED','EXPIRED','AWARDED','REFUNDED','ROLLED_OVER')))`
}

export const muteClause = me =>
  me ? `NOT EXISTS (SELECT 1 FROM "Mute" WHERE "Mute"."muterId" = ${me.id} AND "Mute"."mutedId" = "Item"."userId")` : ''

const subClause = (sub, num, table = 'Item', me, showNsfw) => {
  // Intentionally show nsfw posts (i.e. no nsfw clause) when viewing a specific nsfw sub
  if (sub) {
    const tables = [...new Set(['Item', table])].map(t => `"${t}".`)
    return `(${tables.map(t => `${t}"subNames" @> ARRAY[$${num}]::CITEXT[]`).join(' OR ')})`
  }

  // XXX heh, we don't have any nsfw subs so we don't need to hide them
  const hideNsfwClause = undefined // `NOT EXISTS (SELECT 1 FROM "Sub" WHERE "Sub"."name" = ANY(${table ? `"${table}".` : ''}"subNames") AND "Sub"."nsfw" = TRUE)`

  if (!me) { return hideNsfwClause }

  const excludeMuted = `NOT EXISTS (SELECT 1 FROM "MuteSub" WHERE "MuteSub"."userId" = ${me.id} AND "MuteSub"."subName" = ANY(${table ? `"${table}".` : ''}"subNames"))`
  if (showNsfw) return excludeMuted

  return [excludeMuted, hideNsfwClause].filter(Boolean).join(' AND ')
}

// Inverted filter: show items BELOW the threshold (for desperados)
function invertedInvestmentClause (postsPiconerosFilter, commentsPiconerosFilter) {
  // null means "show all" — nothing is below -infinity, so return no results
  if (postsPiconerosFilter == null && commentsPiconerosFilter == null) {
    return 'FALSE'
  }

  const postsExpr = postsPiconerosFilter == null
    ? 'FALSE'
    : `"Item"."netInvestment" < ${postsPiconerosFilter}`
  const commentsExpr = commentsPiconerosFilter == null
    ? 'FALSE'
    : `"Item"."netInvestment" < ${commentsPiconerosFilter}`

  return `(
    CASE WHEN "Item"."parentId" IS NULL
      THEN ${postsExpr}
      ELSE ${commentsExpr}
    END
  )`
}

// Uses the indexed netInvestment column for efficient filtering
// ownerBypass: if true, always show the user's own items regardless of filter
function investmentClause (postsPiconerosFilter, commentsPiconerosFilter, meId, ownerBypass) {
  // null means "show all" — no filter for that dimension
  if (postsPiconerosFilter == null && commentsPiconerosFilter == null) {
    return ''
  }

  const ownerClause = ownerBypass && meId ? ` OR "Item"."userId" = ${meId}` : ''
  const postsExpr = postsPiconerosFilter == null
    ? 'TRUE'
    : `"Item"."netInvestment" >= ${postsPiconerosFilter}${ownerClause}`
  const commentsExpr = commentsPiconerosFilter == null
    ? 'TRUE'
    : `"Item"."netInvestment" >= ${commentsPiconerosFilter}${ownerClause}`

  return `(
    CASE WHEN "Item"."parentId" IS NULL
      THEN ${postsExpr}
      ELSE ${commentsExpr}
    END
  )`
}

export async function filterClause (type, sub, sort, { me, userLoader, subLoader }, by) {
  if (type === 'freebies' || type === 'bios' || by === 'downsats') {
    return ''
  }

  const isDesperados = type === 'desperados'

  let postsPiconerosFilter = DEFAULT_POSTS_PICONEROS_FILTER
  let commentsPiconerosFilter = DEFAULT_COMMENTS_PICONEROS_FILTER
  const isCurated = sort === 'lit' || sort === 'top'

  if (me) {
    const user = await userLoader.load(me.id)
    // a stale session can reference a deleted user row; treat it as logged out
    // (defaults) instead of crashing every feed query
    if (user) {
      commentsPiconerosFilter = user.commentsPiconerosFilter
      postsPiconerosFilter = user.postsPiconerosFilter
    }
  }

  const territory = sub ? await subLoader.load(sub) : null

  if (sort === 'top' && me) {
    // top sort, logged in: user's own filter, no overrides
  } else if (territory && isCurated) {
    // lit (or top logged-out) in territory: territory is authoritative
    postsPiconerosFilter = territory.postsPiconerosFilter
  } else if (territory) {
    // non-curated in territory: most permissive of user/territory
    // null (show all) beats any number since it's conceptually -infinity
    postsPiconerosFilter = me
      ? (postsPiconerosFilter == null ? null : Math.min(Number(postsPiconerosFilter), Number(territory.postsPiconerosFilter)))
      : territory.postsPiconerosFilter
  } else if (isCurated) {
    // homepage curated: the homepage floor applies only to logged-out viewers
    // (whose filter is the DEFAULT_* default). A logged-in viewer's explicit
    // filter — including "-∞ (show all)", i.e. null — must win so heavily
    // downvoted posts are reachable; matches the top/logged-in branch above.
    if (!me) {
      postsPiconerosFilter = HOMEPAGE_POSTS_PICONEROS_FILTER
    }
  }

  // On curated feeds (lit/top), your own items are filtered like everyone else's.
  // On new/notifications, your own items always pass the filter.
  if (isDesperados) {
    return invertedInvestmentClause(postsPiconerosFilter, commentsPiconerosFilter)
  }
  return investmentClause(postsPiconerosFilter, commentsPiconerosFilter, me?.id, !isCurated)
}

function typeClause (type) {
  switch (type) {
    case 'links':
      return ['"Item".url IS NOT NULL', '"Item"."parentId" IS NULL']
    case 'discussions':
      return ['"Item".url IS NULL', '"Item".bio = false', '"Item"."pollCost" IS NULL', '"Item"."parentId" IS NULL']
    case 'polls':
      return ['"Item"."pollCost" IS NOT NULL', '"Item"."parentId" IS NULL']
    case 'bios':
      return ['"Item".bio = true', '"Item"."parentId" IS NULL']
    case 'bounties':
      return ['"Item".bounty IS NOT NULL', '"Item"."parentId" IS NULL']
    case 'bounties_active':
      return ['"Item".bounty IS NOT NULL', '"Item"."parentId" IS NULL', '"Item"."bountyPaidTo" IS NULL']
    case 'comments':
      return '"Item"."parentId" IS NOT NULL'
    case 'freebies':
      return '"Item".freebie = true'
    case 'desperados':
    case 'all':
    case 'bookmarks':
      return ''
    case 'jobs':
      return '"Item"."subNames" @> ARRAY[\'jobs\']'
    default:
      return '"Item"."parentId" IS NULL'
  }
}

export default {
  Query: {
    itemRepetition: async (parent, { parentId }, { me, models }) => {
      if (!me) return 0
      // how many of the parents starting at parentId belong to me
      const [{ item_spam: count }] = await models.$queryRawUnsafe(`SELECT item_spam($1::INTEGER, $2::INTEGER, '${ITEM_SPAM_INTERVAL}')`,
        Number(parentId), Number(me.id))

      return count
    },
    items: async (parent, { sub, sort, type, cursor, name, when, from, to, by, limit }, ctx) => {
      const { me, models, userLoader } = ctx
      const decodedCursor = decodeCursor(cursor)
      let items, user, pins, table

      // special authorization for bookmarks depending on owning users' privacy settings
      if (type === 'bookmarks' && name && me?.name !== name) {
        // the calling user is either not logged in, or not the user upon which the query is made,
        // so we need to check authz
        user = await models.user.findUnique({ where: { name } })
        // additionally check if the user ids are not the same since if the nym changed
        // since the last session update we would hide bookmarks from their owners
        // see https://github.com/stackernews/stacker.news/issues/586
        if (user?.hideBookmarks && user.id !== me.id) {
          // early return with no results if bookmarks are hidden
          return {
            cursor: null,
            items: [],
            pins: []
          }
        }
      }

      // HACK we want to optionally include the subName in the query
      // but the query planner doesn't like unused parameters
      const subArr = sub ? [sub] : []

      const currentUser = me ? await userLoader.load(me.id) : null
      const showNsfw = currentUser ? currentUser.nsfwMode : false

      switch (sort) {
        case 'user':
          if (!name) {
            throw new GqlInputError('must supply name')
          }

          user ??= await models.user.findUnique({ where: { name } })
          if (!user) {
            throw new GqlInputError('no user has that name')
          }

          table = type === 'bookmarks' ? 'Bookmark' : 'Item'
          items = await itemQueryWithMeta({
            me,
            models,
            query: `
              ${selectClause(type)}
              ${relationClause(type)}
              ${payInJoinFilter(me)}
              ${whereClause(
                `"${table}"."userId" = $3`,
                activeOrMine(me),
                typeClause(type),
                by === 'downsats' && '"Item"."downPiconeros" > 0',
                whenClause(when || 'forever', table))}
              ${orderByClause(by, me, models, type, sub)}
              OFFSET $4
              LIMIT $5`,
            orderBy: orderByClause(by, me, models, type)
          }, ...whenRange(when, from, to || decodedCursor.time), user.id, decodedCursor.offset, limit)
          break
        case 'new':
          items = await itemQueryWithMeta({
            me,
            models,
            query: `
              ${SELECT}
              ${relationClause(type)}
              ${payInJoinFilter(me)}
              ${whereClause(
                '"Item".created_at <= $1',
                '"Item"."deletedAt" IS NULL',
                subClause(sub, 4, subClauseTable(type), me, showNsfw),
                activeOrMine(me),
                await filterClause(type, sub, 'new', ctx),
                typeClause(type),
                muteClause(me)
              )}
              ORDER BY "PayIn"."payInStateChangedAt" DESC
              OFFSET $2
              LIMIT $3`,
            orderBy: 'ORDER BY "PayIn"."payInStateChangedAt" DESC'
          }, decodedCursor.time, decodedCursor.offset, limit, ...subArr)
          break
        case 'top':
          items = await itemQueryWithMeta({
            me,
            models,
            query: `
              ${selectClause(type)}
              ${relationClause(type)}
              ${payInJoinFilter(me)}
              ${whereClause(
                '"Item"."deletedAt" IS NULL',
                type === 'posts' && '"Item"."subNames" IS NOT NULL',
                subClause(sub, 5, subClauseTable(type), me, showNsfw),
                typeClause(type),
                whenClause(when, 'Item'),
                activeOrMine(me),
                '"Item".status = \'ACTIVE\'',
                by === 'downsats' && '"Item"."downPiconeros" > 0',
                await filterClause(type, sub, 'top', ctx, by),
                muteClause(me))}
              ${orderByClause(by || 'sats', me, models, type, sub)}
              OFFSET $3
              LIMIT $4`,
            orderBy: orderByClause(by || 'sats', me, models, type, sub)
          }, ...whenRange(when, from, to || decodedCursor.time), decodedCursor.offset, limit, ...subArr)
          break
        default:
          if (decodedCursor.offset === 0) {
            // get pins for the page and return those separately
            pins = await itemQueryWithMeta({
              me,
              models,
              query: `
              SELECT rank_filter.*
                FROM (
                  ${SELECT}, position,
                  rank() OVER (
                      PARTITION BY "pinId"
                      ORDER BY "Item".created_at DESC
                  )
                  FROM "Item"
                  JOIN "Pin" ON "Item"."pinId" = "Pin".id
                  ${payInJoinFilter(me)}
                  ${whereClause(
                    '"pinId" IS NOT NULL',
                    '"parentId" IS NULL',
                    sub ? '"Item"."subNames" @> ARRAY[$1]::CITEXT[]' : '"Item"."subNames" IS NULL',
                    muteClause(me))}
              ) rank_filter WHERE RANK = 1
              ORDER BY position ASC`,
              orderBy: 'ORDER BY position ASC'
            }, ...subArr)
          }

          items = await itemQueryWithMeta({
            me,
            models,
            query: `
                ${SELECT}
                FROM "Item"
                ${payInJoinFilter(me)}
                ${whereClause(
                  // in home (sub undefined), filter out global pinned items since we inject them later
                  sub ? '"Item"."pinId" IS NULL' : 'NOT ("Item"."pinId" IS NOT NULL AND "Item"."subNames" IS NULL)',
                  '"Item"."deletedAt" IS NULL',
                  '"Item"."parentId" IS NULL',
                  '"Item".bio = false',
                  activeOrMine(me),
                  '"Item".status = \'ACTIVE\'',
                  await filterClause(type, sub, 'lit', ctx),
                  subClause(sub, 3, 'Item', me, showNsfw),
                  muteClause(me))}
                ORDER BY ranklit DESC, "Item".id DESC
                OFFSET $1
                LIMIT $2`,
            orderBy: 'ORDER BY ranklit DESC, "Item".id DESC'
          }, decodedCursor.offset, limit, ...subArr)
          break
      }
      return {
        cursor: items.length === limit ? nextCursorEncoded(decodedCursor, limit) : null,
        items,
        pins
      }
    },
    item: getItem,
    pageTitleAndUnshorted: async (parent, { url }, { models }) => {
      const res = {}
      try {
        const response = await snFetch(url, { protocol: 'http', redirect: 'follow', size: 2 * 1024 * 1024 })
        const html = await response.text()
        const doc = domino.createWindow(html).document
        const titleRuleSet = {
          rules: [
            ['h1 > yt-formatted-string.ytd-watch-metadata', el => el.getAttribute('title')],
            ...metadataRuleSets.title.rules
          ]
        }
        const metadata = getMetadata(doc, url, { title: titleRuleSet, publicationDate: publicationDateRuleSet })
        const dateHint = ` (${metadata.publicationDate?.getFullYear()})`
        const moreThanOneYearAgo = metadata.publicationDate && metadata.publicationDate < datePivot(new Date(), { years: -1 })

        res.title = metadata?.title
        if (moreThanOneYearAgo) res.title += dateHint
      } catch { }

      try {
        const unshorted = await unshorten(url)
        if (unshorted) {
          res.unshorted = unshorted
        }
      } catch { }

      return res
    },
    dupes: async (parent, { url }, { me, models }) => {
      const urlObj = new URL(ensureProtocol(url))
      let { hostname, pathname } = urlObj

      const parseResult = parse(urlObj.hostname)
      if (parseResult?.subdomain?.length > 0) {
        hostname = hostname.replace(`${parseResult.subdomain}.`, '')
      }
      // hostname with optional protocol, subdomain, and port
      const hostnameRegex = `^(http(s)?:\\/\\/)?(\\w+\\.)?${(hostname + '(:[0-9]+)?').replace(/\./g, '\\.')}`
      // pathname with trailing slash and escaped special characters
      const pathnameRegex = stripTrailingSlash(pathname).replace(/(\+|\.|\/)/g, '\\$1') + '\\/?'
      // url with optional trailing slash
      let similar = hostnameRegex + pathnameRegex

      const whitelist = ['news.ycombinator.com/item', 'bitcointalk.org/index.php']
      const youtube = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']

      const hostAndPath = stripTrailingSlash(urlObj.hostname + urlObj.pathname)
      if (whitelist.includes(hostAndPath)) {
        // make query string match for whitelist domains
        similar += `\\${urlObj.search}`
      } else if (youtube.includes(urlObj.hostname)) {
        // extract id and create both links
        const matches = url.match(/(https?:\/\/)?((www\.)?(youtube(-nocookie)?|youtube.googleapis)\.com.*(v\/|v=|vi=|vi\/|e\/|embed\/|user\/.*\/u\/\d+\/)|youtu\.be\/)(?<id>[_0-9a-z-]+)/i)
        similar = `^(http(s)?:\\/\\/)?((www\\.|m\\.)?youtube.com\\/(watch\\?v\\=|v\\/|live\\/)${matches?.groups?.id}|youtu\\.be\\/${matches?.groups?.id})&?`
      } else if (urlObj.hostname === 'yewtu.be') {
        const matches = url.match(/(https?:\/\/)?yewtu\.be.*(v=|embed\/)(?<id>[_0-9a-z-]+)/i)
        similar = `^(http(s)?:\\/\\/)?yewtu\\.be\\/(watch\\?v\\=|embed\\/)${matches?.groups?.id}&?`
      } else {
        // only allow ending of mismatching search params
        similar += '(?:\\?.*)?$'
      }

      return await itemQueryWithMeta({
        me,
        models,
        query: `
          ${SELECT}
          FROM "Item"
          ${payInJoinFilter(me)}
          ${whereClause('url ~* $1', activeOrMine(me))}
          ORDER BY created_at DESC
          LIMIT 3`
      }, similar)
    },
    newComments: async (parent, { itemId, after }, { models, me }) => {
      const comments = await itemQueryWithMeta({
        me,
        models,
        query: `
          ${SELECT}
          FROM "Item"
          ${payInJoinFilter(me)}
          -- comments can be nested, so we need to get all comments that are descendants of the root
          ${whereClause(
            '"Item".path <@ (SELECT path FROM "Item" WHERE id = $1 AND "Item"."lastCommentAt" > $2)',
            activeOrMine(me),
            '"Item"."created_at" > $2'
          )}
          ORDER BY "Item"."created_at" ASC
          LIMIT 50`
      }, Number(itemId), after)

      return { comments }
    }
  },

  Mutation: {
    bookmarkItem: async (parent, { id }, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      const data = { itemId: Number(id), userId: me.id }
      const old = await models.bookmark.findUnique({ where: { userId_itemId: data } })
      if (old) {
        await models.bookmark.delete({ where: { userId_itemId: data } })
      } else await models.bookmark.create({ data })
      return { id }
    },
    pinItem: async (parent, { id }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const item = await models.item.findUnique({
        where: { id: Number(id) },
        include: { pin: true, root: true, subs: { include: { sub: true } } }
      })

      if (item.parentId) {
        // OPs can only pin top level replies
        if (item.parentId !== item.rootId) {
          throw new GqlInputError('can only pin root replies')
        }

        if (item.root.userId !== Number(me.id)) {
          throw new GqlInputError('not your post')
        }
      } else if (item.subs?.length === 1) {
        // only territory founder can pin posts
        const sub = item.subs[0].sub
        if (Number(me.id) !== sub.userId) {
          throw new GqlInputError('not your sub')
        }
      } else {
        throw new GqlInputError('item must belong to a single sub or be a comment')
      }

      let pinId
      if (item.pinId) {
        // item is already pinned. remove pin
        await models.$transaction([
          models.item.update({ where: { id: item.id }, data: { pinId: null } }),
          models.pin.delete({ where: { id: item.pinId } }),
          // make sure that pins have no gaps
          models.$queryRawUnsafe(`
            UPDATE "Pin"
            SET position = position - 1
            WHERE position > $2 AND id IN (
              SELECT "pinId" FROM "Item" i
              ${whereClause(
                '"pinId" IS NOT NULL',
                item.parentId ? 'i."parentId" = $1' : 'i."subNames" @> ARRAY[$1]::CITEXT[]')}
            )`, item.parentId ?? item.subNames[0], item.pin.position)
        ])

        pinId = null
      } else {
        // only max 6 pins allowed per territory and post
        const [{ count: npins }] = await models.$queryRawUnsafe(`
          SELECT COUNT(p.id)
          FROM "Pin" p
          JOIN "Item" i ON i."pinId" = p.id
          ${whereClause(
            item.parentId ? 'i."parentId" = $1' : 'i."subNames" @> ARRAY[$1]::CITEXT[]'
          )}`, item.parentId ?? item.subNames[0])

        if (npins >= 6) {
          throw new GqlInputError('max 6 pins allowed')
        }

        const [{ pinId: newPinId }] = await models.$queryRawUnsafe(`
          WITH pin AS (
            INSERT INTO "Pin" (position)
            SELECT COALESCE(MAX(p.position), 0) + 1 AS position
            FROM "Pin" p
            JOIN "Item" i ON i."pinId" = p.id
            ${whereClause(
              item.parentId ? 'i."parentId" = $1' : 'i."subNames" @> ARRAY[$1]::CITEXT[]'
            )}
            RETURNING id
          )
          UPDATE "Item"
          SET "pinId" = pin.id
          FROM pin
          WHERE "Item".id = $2
          RETURNING "pinId"`, item.parentId ?? item.subNames[0], item.id)

        pinId = newPinId
      }

      return { id, pinId }
    },
    subscribeItem: async (parent, { id }, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      const data = { itemId: Number(id), userId: me.id }
      const old = await models.threadSubscription.findUnique({ where: { userId_itemId: data } })
      if (old) {
        await models.$executeRaw`
          DELETE FROM "ThreadSubscription" ts
          USING "Item" i
          WHERE ts."userId" = ${me.id}
          AND i.path <@ (SELECT path FROM "Item" WHERE id = ${Number(id)})
          AND ts."itemId" = i.id
        `
      } else {
        await models.threadSubscription.create({ data })
      }
      return { id }
    },
    deleteItem: async (parent, { id }, { me, models }) => {
      const old = await models.item.findUnique({ where: { id: Number(id) } })
      if (Number(old.userId) !== Number(me?.id)) {
        throw new GqlInputError('item does not belong to you')
      }
      if (old.bio) {
        throw new GqlInputError('cannot delete bio')
      }

      return await deleteItemByAuthor({ models, id, item: old })
    },
    upsertLink: async (parent, { id, ...item }, { me, models, headers }) => {
      await validateSchema(linkSchema, item, { models, me })

      if (id) {
        return await updateItem(parent, { id, ...item }, { me, models })
      } else {
        return await createItem(parent, item, { me, models, headers })
      }
    },
    upsertDiscussion: async (parent, { id, ...item }, { me, models, headers }) => {
      await validateSchema(discussionSchema, item, { models, me })

      if (id) {
        return await updateItem(parent, { id, ...item }, { me, models })
      } else {
        return await createItem(parent, item, { me, models, headers })
      }
    },
    upsertBounty: async (parent, { id, ...item }, { me, models, headers }) => {
      await validateSchema(bountySchema, item, { models, me })

      if (id) {
        return await updateItem(parent, { id, ...item }, { me, models })
      } else {
        return await createItem(parent, item, { me, models, headers })
      }
    },
    removeMoneroWall: async (parent, { id }, { me, models }) => {
      if (!me) throw new GqlAuthenticationError()
      const item = await models.item.findUnique({ where: { id: Number(id) } })
      if (!item) throw new GqlInputError('item not found')
      if (Number(item.userId) !== Number(me.id)) throw new GqlInputError('item does not belong to you')
      if (item.moneroWallEnabledAt == null) throw new GqlInputError('this post has no monerowall')
      if (item.moneroWallRemovedAt != null) throw new GqlInputError('the monerowall was already removed')
      return await models.item.update({
        where: { id: item.id },
        data: { moneroWallRemovedAt: new Date() }
      })
    },
    rateMoneroWallPost: async (parent, { itemId, stars }, { me, models, moneroWallLoader }) => {
      if (!me) throw new GqlAuthenticationError()
      if (!Number.isInteger(stars) || stars < 1 || stars > 3) throw new GqlInputError('rating must be 1, 2 or 3 stars')
      const item = await models.item.findUnique({
        where: { id: Number(itemId) },
        select: { id: true, userId: true, moneroWallPricePiconeros: true, moneroWallEnabledAt: true }
      })
      if (!item) throw new GqlInputError('item not found')
      if (Number(item.userId) === Number(me.id)) throw new GqlInputError('you cannot rate your own post')
      if (item.moneroWallEnabledAt == null) throw new GqlInputError('this post has no monerowall')
      if (item.moneroWallPricePiconeros == null) throw new GqlInputError('only posts with an individual unlock threshold can be rated')
      const { myRateablePiconeros } = await moneroWallLoader.load({ id: item.id, enabledAt: item.moneroWallEnabledAt })
      if (BigInt(myRateablePiconeros ?? 0n) < BigInt(item.moneroWallPricePiconeros)) {
        throw new GqlInputError('unlock this post before rating it')
      }
      try {
        await models.moneroWallRating.create({ data: { itemId: item.id, userId: Number(me.id), stars } })
      } catch (e) {
        if (e?.code === 'P2002') throw new GqlInputError('already rated — ratings are permanent')
        throw e
      }
      return await models.item.findUnique({ where: { id: item.id } })
    },
    upsertPoll: async (parent, { id, ...item }, { me, models, headers }) => {
      const numExistingChoices = id
        ? await models.pollOption.count({
          where: {
            itemId: Number(id)
          }
        })
        : 0

      await validateSchema(pollSchema, item, { models, me, numExistingChoices })

      if (id) {
        return await updateItem(parent, { id, ...item }, { me, models })
      } else {
        item.pollCost = item.pollCost || POLL_COST
        return await createItem(parent, item, { me, models, headers })
      }
    },
    upsertJob: async (parent, { id, ...item }, { me, models, headers }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      if (!item.subNames?.includes('jobs')) {
        throw new GqlInputError('jobs can only be posted in the jobs turf')
      }

      item.location = item.location?.toLowerCase() === 'remote' ? undefined : item.location
      await validateSchema(jobSchema, item, { models })
      if (item.logo !== undefined) {
        item.uploadId = item.logo
        delete item.logo
      }

      if (id) {
        return await updateItem(parent, { id, ...item }, { me, models })
      } else {
        return await createItem(parent, item, { me, models, headers })
      }
    },
    upsertComment: async (parent, { id, ...item }, { me, models, headers }) => {
      await validateSchema(commentSchema, item)

      if (id) {
        return await updateItem(parent, { id, ...item }, { me, models })
      } else {
        return await createItem(parent, item, { me, models, headers })
      }
    },
    updateNoteId: async (parent, { id, noteId }, { me, models }) => {
      if (!id) {
        throw new GqlInputError('id required')
      }

      await models.item.update({
        where: { id: Number(id), userId: Number(me.id) },
        data: { noteId }
      })

      return { id, noteId }
    },
    pollVote: async (parent, { id, sendProtocolId }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      return await pay('POLL_VOTE', { id }, { me, models, sendProtocolId })
    },
    act: async (parent, { id, piconeros, act = 'TIP' }, { me, models, headers }) => {
      assertApiKeyNotPermitted({ me })
      await validateSchema(actSchema, { piconeros: Number(piconeros), act })
      await assertGofacYourself({ models, headers })

      // StasherNews: tips are ObservedTip-based (the webhook + payment-ID flow in
      // the initiateTip mutation), NOT PayIn-based. `act` is typed `: PayIn!` (the
      // legacy SN zap path) and the frontend ACT_MUTATION spreads PayInFields, so it
      // cannot carry a TipInitiation. The tip button must call initiateTip directly;
      // act(TIP) redirects there with an actionable error. Downvotes (DONT_LIKE_THIS)
      // are a DOWNVOTE PayIn that returns a monero: URI to the rewards wallet; the
      // `piconeros` arg carries the piconeros amount for downvotes.
      if (act === 'TIP') {
        throw new GqlInputError('use the initiateTip mutation to tip (webhook + payment-ID flow)')
      }
      if (act === 'DONT_LIKE_THIS') {
        if (!me) {
          throw new GqlAuthenticationError()
        }
        return await pay('DOWNVOTE', { id: Number(id), piconeros }, { me })
      }
      if (act === 'BOOST') {
        if (!me) {
          throw new GqlAuthenticationError()
        }
        return await pay('BOOST', { id: Number(id), piconeros }, { me })
      }
      throw new GqlInputError(`unsupported act ${act}`)
    },
    // Thin wrapper: injects this module's path-aware META reader (getItem) so
    // the mutation response carries the same shape as the item(id) query,
    // including the ltree path, without a circular import into boost-credit.
    useBoostCredit: (parent, args, ctx) => redeemBoostCredit(parent, args, { ...ctx, readItem: getItem }),
    updateCommentsViewAt: async (parent, { id, meCommentsViewedAt }, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }

      const result = await models.commentsViewAt.upsert({
        where: {
          userId_itemId: { userId: Number(me.id), itemId: Number(id) }
        },
        update: { lastViewedAt: new Date(meCommentsViewedAt) },
        create: { userId: Number(me.id), itemId: Number(id), lastViewedAt: new Date(meCommentsViewedAt) }
      })

      return result.lastViewedAt
    },

    // Deferred reference: repostItem is declared below this map (const bindings
    // are in the temporal dead zone at map-construction time), so resolve it at
    // request time. A missing entry here makes Apollo's default resolver return
    // null for the non-nullable Mutation.repostItem field.
    repostItem: (...args) => repostItem(...args)
  },

  Item: {
    excerpt: excerptResolver,
    text: async (item, args, ctx) => {
      if (!moneroWallEnabled(item)) return moneroWallFullText(item)
      const { me } = ctx
      const view = await moneroWallStateFor(item, ctx)
      // the author needs the raw text (marker included) to keep editing the wall
      if (!view.locked && Number(item.userId) === Number(me?.id)) return item.text
      if (!view.locked) return stripMoneroWallMarker(item.text)
      return splitMoneroWallText(item.text).teaserText
    },
    moneroWall: async (item, args, ctx) => await moneroWallStateFor(item, ctx),
    // H1 (2026-09-26 review): imgproxyUrls is content-bearing — the worker
    // derives signed derivative URLs from the FULL stored text, below the wall
    // included, and signed imgproxy URLs are bearer URLs (possession = fetch).
    // Locked viewers get only entries the teaser references as a whole-token
    // URL — the same exact-key lookup the client's MediaNode transform does by
    // decoded src — so a teaser URL that merely CONTAINS a below-wall URL as a
    // substring (/uploads/202 inside /uploads/2023) cannot leak that key. (A
    // whole-token regex, not extractUrls: lib/md is ESM-only and a static
    // import here breaks every suite that imports this file unmocked; the
    // regex is a superset of mdast extraction, so it never drops a teaser
    // key, and only retains a below-wall key whose URL the author published
    // verbatim in the public teaser.) The public link's own derivatives are
    // body-independent (the wall gates the body, not the post's link) and
    // stay. Entitled viewers, authors, publicly unlocked posts, and
    // never-walled items get the raw map. The html/lexicalState resolvers
    // read item.imgproxyUrls off the row directly, so server-side rendering
    // of the teaser is unaffected by this filter.
    imgproxyUrls: async (item, args, ctx) => {
      if (item.imgproxyUrls == null || !moneroWallEnabled(item)) return item.imgproxyUrls
      const view = await moneroWallStateFor(item, ctx)
      // a null view here would mean a contract change upstream — filter (fail
      // closed) rather than serve the raw map
      if (view && !view.locked) return item.imgproxyUrls
      const { teaserText } = splitMoneroWallText(item.text)
      const filtered = {}
      for (const [url, entry] of Object.entries(item.imgproxyUrls)) {
        const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`(^|[^\\w])${escaped}(?!\\w)`).test(teaserText)) filtered[url] = entry
      }
      if (item.url && item.imgproxyUrls[item.url]) filtered[item.url] = item.imgproxyUrls[item.url]
      return filtered
    },
    // xPreview carries tweet text and signed image derivatives selected from
    // the FULL stored text (below the wall included). A locked viewer may only
    // see a preview proven to come from the public main URL or the public
    // teaser; old rows written without provenance fail closed unless they
    // match the validated main URL. One DataLoader load per walled item.
    xPreview: async (item, args, ctx) => {
      const preview = item.xPreview
      if (!preview || !moneroWallEnabled(item)) return preview
      const view = await moneroWallStateFor(item, ctx)
      if (view && !view.locked) return preview
      const fromPublicMain = canonicalXStatus(item.url)?.statusUrl === preview.statusUrl
      const fromPublicTeaser = preview.publicSource === true &&
        canonicalXStatus(preview.sourceUrl)?.statusUrl === preview.statusUrl
      return fromPublicMain || fromPublicTeaser ? preview : null
    },
    moneroWallRating: async (item, args, ctx) => await ctx.moneroWallRatingLoader.load(Number(item.id)),
    payIn: async (item, args, { models }) => {
      if (typeof item.payIn !== 'undefined') {
        return item.payIn
      }

      // TODO: very inefficient on a relative basis, so if need be we can:
      // 1. denormalize payInId that created the item to it
      // 2. add this to the getItemMeta query (done)
      const payIn = await models.payIn.findFirst({
        where: {
          itemPayIn: {
            itemId: item.id
          },
          payInType: 'ITEM_CREATE',
          successorId: null
        }
      })
      return payIn
    },
    // Cumulative on-chain piconeros observed for this item's posting-fee
    // PayIn — FeeObservation rows on platform-routed legs, ObservedSubFee
    // receipts on owner-routed legs (fee: webhook), summed across both. 0n
    // when no fee PayIn exists (free posts) — drives the client's
    // underpayment hint.
    feeReceivedPiconeros: async (item, args, { models }) => {
      if (!item.feePayInId) return 0n
      if (typeof item.feeReceivedPiconeros !== 'undefined') return item.feeReceivedPiconeros
      return await feeReceivedPiconerosForPayIn(models, item.feePayInId)
    },
    // StasherNews top-up URI for a PENDING_FEE item: re-quotes only the REMAINDER
    // after a partial fee (mirrors territoryReentryFunding), so the pending-fee
    // modal's QR + copyable amount show what the user still owes instead of the
    // full original fee. Null for non-fee items and before any fee PayIn exists.
    // The stored URI is never rewritten, so the observer gate keeps gating on the
    // full amount.
    feeTopUpUri: async (item, args, { models, me }) => {
      if (me?.id !== item.userId) return null
      const funding = await itemFeeReentryFunding(models, item)
      return funding?.moneroUri ?? null
    },
    piconeros: async (item, args, { models, me }) => {
      if (me?.id === item.userId) {
        return item.piconeros
      }
      return BigInt(item.piconeros) + BigInt(item.mePendingMsats || 0) + BigInt(item.mePendingMcredits || 0)
    },
    downPiconeros: async (item, args, { models, me }) => {
      if (me?.id === item.userId) {
        return item.downPiconeros
      }
      return BigInt(item.downPiconeros) + BigInt(item.mePendingDontLikeMsats || 0)
    },
    commentDownPiconeros: async (item, args, { models }) => {
      return item.commentDownPiconeros
    },
    boost: async (item, args, { models, me }) => {
      if (me?.id !== item.userId) {
        return item.boost
      }
      return BigInt(item.boost) + BigInt(item.mePendingBoostMsats || 0)
    },
    credits: async (item, args, { models, me }) => {
      if (me?.id === item.userId) {
        return Number(item.credits ?? 0n)
      }
      return Number(item.credits) + Number(item.mePendingMcredits || 0)
    },
    commentPiconeros: async (item, args, { models }) => {
      return item.commentPiconeros
    },
    commentCredits: async (item, args, { models }) => {
      return Number(item.commentCredits ?? 0n)
    },
    bountyPaidTo: (item) => item.bountyPaidTo,
    commentCost: async (item) => item.commentCost || 0,
    commentBoost: async (item) => item.commentBoost || 0,
    isJob: async (item, args, { models }) => {
      return item.subNames?.includes('jobs') ?? false
    },
    sub: async (item, args, { models, subLoader }) => {
      if (!item.subNames?.length && !item.root?.subNames?.length) {
        return null
      }
      return item.subs?.[0] || item.root?.subs?.[0] ||
        await subLoader.load(item.subNames?.[0] ?? item.root?.subNames?.[0])
    },
    subName: async (item, args, { models }) => {
      return item.subNames?.[0]
    },
    subs: async (item, args, { models }) => {
      if (!item.subNames?.length && !item.root) {
        return null
      }

      if (item.subs) {
        return item.subs
      }

      return await models.sub.findMany({ where: { name: { in: item.subNames || item.root?.subNames } } })
    },
    position: async (item, args, { models }) => {
      if (!item.pinId) {
        return null
      }

      const pin = await models.pin.findUnique({ where: { id: item.pinId } })
      if (!pin) {
        return null
      }

      return pin.position
    },
    prior: async (item, args, { models }) => {
      if (!item.pinId) {
        return null
      }

      const prior = await models.item.findFirst({
        where: {
          pinId: item.pinId,
          createdAt: {
            lt: item.createdAt
          }
        },
        orderBy: {
          createdAt: 'desc'
        }
      })

      if (!prior) {
        return null
      }

      return prior.id
    },
    poll: async (item, args, { models, me }) => {
      if (!item.pollCost) {
        return null
      }

      // votes that are paid for have a null payInId
      const options = await models.$queryRaw`
        SELECT "PollOption".id, option, count("PollVote".id) FILTER (WHERE "PollVote"."payInId" IS NULL)::INTEGER as count
        FROM "PollOption"
        LEFT JOIN "PollVote" on "PollVote"."pollOptionId" = "PollOption".id
        WHERE "PollOption"."itemId" = ${item.id}
        GROUP BY "PollOption".id
        ORDER BY "PollOption".id ASC
      `

      const poll = {}
      if (me) {
        const meVoted = await models.payIn.findFirst({
          where: {
            userId: me.id,
            payInType: 'POLL_VOTE',
            payInState: 'PAID',
            itemPayIn: {
              itemId: item.id
            }
          }
        })
        poll.meVoted = !!meVoted
      } else {
        poll.meVoted = false
      }

      poll.randPollOptions = item?.randPollOptions
      poll.options = poll.randPollOptions ? shuffleArray(options) : options
      poll.count = options.reduce((t, o) => t + o.count, 0)

      return poll
    },
    user: async (item, args, { models }) => {
      if (item.user) {
        return item.user
      }
      return await models.user.findUnique({ where: { id: item.userId } })
    },
    comments: async (item, { sort, cursor }, ctx) => {
      const { me } = ctx
      if (typeof item.comments !== 'undefined') {
        if (Array.isArray(item.comments)) {
          return {
            comments: item.comments,
            cursor: null
          }
        }
        return item.comments
      }

      // if we're logged in, there might be pending comments from us we want to show but weren't counted
      if (!me && item.ncomments === 0) {
        return {
          comments: [],
          cursor: null
        }
      }

      return await resolveItemComments(item, sort || defaultCommentSort(item.pinId, item.bioId, item.createdAt), cursor, { ...ctx, itemQueryWithMeta, payInJoinFilter, activeOrMine, select: SELECT })
    },
    freedFreebie: async (item) => {
      return item.weightedVotes - item.weightedDownVotes > 0
    },
    freebie: isFreebieItem,
    netInvestment: async (item) => {
      // Maintained by the item_net_investment trigger
      return BigInt(item.netInvestment ?? 0)
    },
    mePiconeros: async (item, args, { me, models }) => {
      if (!me) return 0n
      if (typeof item.meMsats !== 'undefined' && typeof item.meMcredits !== 'undefined') {
        return BigInt(item.meMsats) + BigInt(item.meMcredits)
      }

      // StasherNews: tips are ObservedTip-based and never create TIP PayIns;
      // the viewer's per-item tip total lives in ItemUserAgg (maintained by
      // applyTipDetected at DETECTED, mirroring the Item.piconeros bump).
      const agg = await models.itemUserAgg.findUnique({
        where: { itemId_userId: { itemId: Number(item.id), userId: Number(me.id) } }
      })
      return agg?.tipPiconeros ?? 0n
    },
    meCredits: async (item, args, { me, models }) => {
      if (!me) return 0
      if (typeof item.meMcredits !== 'undefined') {
        return Number(item.meMcredits ?? 0n)
      }

      // credits were removed with the custodial strip
      return 0
    },
    meDontLikePiconeros: async (item, args, { me, models }) => {
      if (!me) return 0n
      if (typeof item.meDontLikeMsats !== 'undefined') {
        return BigInt(item.meDontLikeMsats ?? 0n)
      }

      // StasherNews: DOWNVOTE PayIns are born PAID with piconeros=0n (the real
      // amount is in ObservedDownvote), so the viewer's per-item downvote total
      // lives in ItemUserAgg (maintained by applyDownvotePenalty).
      const agg = await models.itemUserAgg.findUnique({
        where: { itemId_userId: { itemId: Number(item.id), userId: Number(me.id) } }
      })
      return agg?.downvotePiconeros ?? 0n
    },
    meBookmark: async (item, args, { me, models }) => {
      if (!me) return false
      if (typeof item.meBookmark !== 'undefined') return item.meBookmark

      const bookmark = await models.bookmark.findUnique({
        where: {
          userId_itemId: {
            itemId: Number(item.id),
            userId: me.id
          }
        }
      })

      return !!bookmark
    },
    meSubscription: async (item, args, { me, models }) => {
      if (!me) return false
      if (typeof item.meSubscription !== 'undefined') return item.meSubscription

      const subscription = await models.threadSubscription.findUnique({
        where: {
          userId_itemId: {
            itemId: Number(item.id),
            userId: me.id
          }
        }
      })

      return !!subscription
    },
    rel: async (item, args, { me, models }) => {
      // Use netInvestment for nofollow decision (items with low investment get nofollow)
      const netInvestment = item.netInvestment ?? 0
      return netInvestment < NOFOLLOW_LIMIT ? UNKNOWN_LINK_REL : 'noopener noreferrer'
    },
    mine: async (item, args, { me, models }) => {
      return me?.id === item.userId
    },
    root: async (item, args, { models, me }) => {
      if (!item.rootId) {
        return null
      }
      if (item.root) {
        return item.root
      }

      // we can't use getItem because activeOrMine will prevent root from being fetched
      const [root] = await itemQueryWithMeta({
        me,
        models,
        query: `
          ${SELECT}
          FROM "Item"
          ${whereClause(
            '"Item".id = $1')}`
      }, Number(item.rootId))

      return root
    },
    parent: async (item, args, { models }) => {
      if (!item.parentId) {
        return null
      }
      return await models.item.findUnique({ where: { id: item.parentId } })
    },
    parentOtsHash: async (item, args, { models }) => {
      if (!item.parentId) {
        return null
      }
      // ?. — a hard-missing parent row must not 500 the ots page / preimage
      // endpoint; a hashless parent yields null (standalone-stamped replies
      // recompute exactly this preimage)
      const parent = await models.item.findUnique({ where: { id: item.parentId } })
      return parent?.otsHash ?? null
    },
    deleteScheduledAt: async (item, args, { me, models }) => {
      const meId = me?.id ?? USER_ID.anon
      if (meId !== item.userId) {
        // Only query for deleteScheduledAt for your own items to keep DB queries minimized
        return null
      }
      const deleteJobs = await models.$queryRaw`
        SELECT startafter
        FROM pgboss.job
        WHERE name = 'deleteItem' AND data->>'id' = ${item.id}::TEXT
        AND state = 'created'`
      return deleteJobs[0]?.startafter ?? null
    },
    reminderScheduledAt: async (item, args, { me, models }) => {
      const meId = me?.id ?? USER_ID.anon
      if (meId !== item.userId || meId === USER_ID.anon) {
        // don't show reminders on an item if it isn't yours
        // don't support reminders for ANON
        return null
      }
      const reminderJobs = await models.$queryRaw`
        SELECT startafter
        FROM pgboss.job
        WHERE name = 'reminder'
        AND data->>'itemId' = ${item.id}::TEXT
        AND data->>'userId' = ${meId}::TEXT
        AND state = 'created'`
      return reminderJobs[0]?.startafter ?? null
    },
    lexicalState: async (item, args, { me, moneroWallLoader, lexicalStateLoader }) => {
      if (!item.text) return null
      return lexicalStateLoader.load({
        text: await moneroWallRenderText(item, { me, moneroWallLoader }),
        context: {
          imgproxyUrls: item.imgproxyUrls,
          rel: item.rel,
          userId: item.userId,
          parentId: item.parentId,
          netInvestment: Number(item.netInvestment)
        }
      })
    },
    html: async (item, args, { me, moneroWallLoader, lexicalStateLoader }) => {
      if (!item.text) return null
      try {
        const lexicalState = await lexicalStateLoader.load({
          text: await moneroWallRenderText(item, { me, moneroWallLoader }),
          context: {
            imgproxyUrls: item.imgproxyUrls,
            rel: item.rel,
            userId: item.userId,
            parentId: item.parentId,
            netInvestment: Number(item.netInvestment)
          }
        })
        if (!lexicalState) return null
        return lexicalHTMLGenerator(lexicalState, { readerXLinks: true })
      } catch (error) {
        console.error('error generating HTML from Lexical State:', error)
        return null
      }
    }
  }
}

export const updateItem = async (parent, { hash, hmac, sendProtocolId, ...item }, { me, models }) => {
  // update iff this item belongs to me
  const old = await models.item.findUnique({
    where: { id: Number(item.id) },
    include: {
      itemPayIns: {
        where: {
          payIn: {
            payInType: 'ITEM_CREATE',
            payInState: 'PAID'
          }
        },
        include: {
          payIn: true
        }
      }
    }
  })

  if (old.deletedAt) {
    throw new GqlInputError('item is deleted')
  }

  const meId = Number(me?.id ?? USER_ID.anon)

  // author can edit their own item (except anon)
  const authorEdit = !!me && Number(old.userId) === meId
  // admins can edit special items
  const adminEdit = ADMIN_ITEMS.includes(old.id) && SN_ADMIN_IDS.includes(meId)
  // anybody can edit with valid hash+hmac
  const hmacEdit = false
  const payIn = old.itemPayIns[0]?.payIn
  // ownership permission check
  const ownerEdit = authorEdit || adminEdit || hmacEdit
  if (!ownerEdit) {
    throw new GqlInputError('item does not belong to you')
  }

  // Turf repost (2026-09-24): content edits can never change turfs — adding a
  // turf is a paid, always-available repost (repostItem), so the only
  // turf-addition path adds exactly one turf per call and every fee stays a
  // single payment to a single destination.
  if (item.subNames != null) {
    const next = [...item.subNames].sort()
    const prev = [...(old.subNames ?? [])].sort()
    if (next.length !== prev.length || next.some((name, i) => name !== prev[i])) {
      throw new GqlInputError('territories can only be changed with the repost action')
    }
  }

  // Forms send explicit null wall vars from initial values; null-null on
  // update means "untouched" (removal goes through removeMoneroWall only).
  if (item.moneroWallPricePiconeros == null && item.moneroWallThresholdPiconeros == null) {
    delete item.moneroWallPricePiconeros
    delete item.moneroWallThresholdPiconeros
  }
  delete item.moneroWallEnabledAt // clients can never move the window; create stamps it once
  await assertMoneroWallWrite({ models, me, item, old })

  // A bounty's amount is escrow-backed: once funding has been initiated
  // (PENDING_FUNDING) or completed (FUNDED onward), changing bountyPiconeros
  // desyncs the escrow — the funding quote/URI was minted on the old amount, so
  // a payer who sends that quoted total gets a fee and booked bounty computed
  // on the NEW declared amount, dispositions would exceed the held balance (the
  // signer would skip forever) or edits downward would strand dust. Freeze the
  // amount from the moment funding is in progress; an author who mis-entered
  // the amount can delete and recreate the bounty (deleteItemByAuthor is
  // unaffected by this gate).
  if (item.bountyPiconeros != null &&
      old.bountyStatus !== 'UNFUNDED' &&
      BigInt(item.bountyPiconeros) !== BigInt(old.bountyPiconeros)) {
    throw new GqlInputError('the bounty amount cannot be changed once funding is in progress or complete')
  }

  const user = await models.user.findUnique({ where: { id: meId } })

  // edits are only allowed for own items within 10 minutes
  // but forever if an admin is editing an "admin item", it's their bio or a job
  const myBio = user.bioId === old.id
  const timer = Date.now() < datePivot(new Date(payIn?.payInStateChangedAt ?? old.createdAt), { seconds: ITEM_EDIT_SECONDS })
  const canEdit = payIn?.payInState !== 'PAID' || (timer && ownerEdit) || adminEdit || myBio || isJob(old)
  if (!canEdit) {
    throw new GqlInputError('item can no longer be edited')
  }

  if (item.url && !isJob(item)) {
    item.url = ensureProtocol(item.url)
    item.url = removeTracking(item.url)
  } else if (item.url && !string().email().isValidSync(item.url)) {
    item.url = ensureProtocol(item.url)
  }

  if (old.bio) {
    // prevent editing a bio like a regular item
    item = { id: Number(item.id), text: item.text, title: `@${user.name}'s bio` }
  } else if (old.parentId) {
    // prevent editing a comment like a post
    item = { id: Number(item.id), text: item.text }
  }
  // note for the future: could also check MediaNodes directly via Lexical
  item.uploadIds = uploadIdsFromText(item.text)

  // never change author of item
  item.userId = old.userId

  return await pay('ITEM_UPDATE', item, { models, me, sendProtocolId })
}

export const repostItem = async (parent, { id, subName }, { me, models }) => {
  if (!me) {
    throw new GqlAuthenticationError()
  }

  const old = await models.item.findUnique({ where: { id: Number(id) } })
  if (!old || old.deletedAt) {
    throw new GqlInputError('item not found')
  }
  if (Number(old.userId) !== Number(me.id)) {
    throw new GqlInputError('item does not belong to you')
  }
  if (old.parentId) {
    throw new GqlInputError('comments cannot be reposted')
  }
  if (old.bio) {
    throw new GqlInputError('bios cannot be reposted')
  }
  const postType = itemPostType(old)
  if (postType === 'JOB') {
    throw new GqlInputError('jobs cannot be reposted')
  }

  const current = old.subNames ?? []
  // Citext comparison: Item.subNames is case-insensitive, so a case-variant
  // repost of an existing turf must be rejected before pay() — otherwise a
  // duplicate turf row is created and a fee charged for a no-op.
  if (current.some(name => String(name).toLowerCase() === subName.toLowerCase())) {
    throw new GqlInputError('item is already in this territory')
  }
  if (current.length >= MAX_ITEM_TURFS) {
    throw new GqlInputError(`items can be in at most ${MAX_ITEM_TURFS} territories`)
  }

  await validateSchema(repostSchema(postType, { models, me }), { subNames: [subName] }, { models, me })

  // No ITEM_EDIT_SECONDS gate: reposting changes distribution, never content,
  // so it stays available for the item's lifetime (unlike content edits).
  // The ITEM_UPDATE engine defers the addition until the fee is observed and
  // routes it owner-direct when exactly one non-owned turf is added.
  return await pay('ITEM_UPDATE', { id: Number(id), userId: old.userId, subNames: [...current, subName] }, { models, me })
}

// Validate a create/update wall write. Throws GqlInputError on violation.
// Walls are create-time only and removal is one-way (2026-09-21 amendment):
// update calls may only tweak X/T on an existing active unfrozen wall;
// enabling at edit, re-adding after removal, and nulling both settings are
// rejected here or in moneroWallUpdateError.
async function assertMoneroWallWrite ({ models, me, item, old }) {
  const hasNew = item.moneroWallPricePiconeros !== undefined || item.moneroWallThresholdPiconeros !== undefined
  const text = item.text ?? old?.text

  if (!hasNew) {
    // No wall args: on a post without an active wall the [monerowall] marker
    // must not appear in the text either (marker requires a wall).
    if (!moneroWallEnabled(old) && splitMoneroWallText(text ?? '').hasMarker) {
      throw new GqlInputError('the [monerowall] marker requires a monerowall')
    }
    return
  }

  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new GqlInputError('fee config not initialized')

  let frozen = false
  if (moneroWallEnabled(old) && old?.id) {
    const detected = await models.observedTip.findFirst({
      where: { postId: old.id, detectedAt: { gte: old.moneroWallEnabledAt }, state: { notIn: ['EXPIRED'] } },
      select: { id: true }
    })
    frozen = !!detected
  }

  const error = moneroWallUpdateError({
    old,
    nextPrice: item.moneroWallPricePiconeros,
    nextThreshold: item.moneroWallThresholdPiconeros,
    frozen,
    minTipPiconeros: config.minTipPiconeros,
    text
  })
  if (error) throw new GqlInputError(error)

  if (old) return // update path: wall already exists, account was checked at create
  if (item.moneroWallPricePiconeros == null && item.moneroWallThresholdPiconeros == null) return
  if (me?.id == null) throw new GqlInputError('sign up to enable a monerowall')
  const account = await models.moneroAccount.findFirst({
    where: { ownerUserId: Number(me.id), status: 'ACTIVE' },
    select: { id: true }
  })
  if (!account) throw new GqlInputError('add a Monero wallet before enabling a monerowall')
}

export const createItem = async (parent, { sendProtocolId, ...item }, { me, models, headers }) => {
  // Turf repost (2026-09-24): creation is single-turf. Additional turfs are
  // added after the post is live via repostItem — one paid repost per turf,
  // so every posting fee stays a single payment to a single destination.
  if ((item.subNames?.length ?? 0) > 1) {
    throw new GqlInputError('posts can only be created in one territory — use the repost action to add more')
  }

  // abuse gate BEFORE any DB work or fee-subaddress reservation (audit A-3)
  await assertItemCreateAllowance({ models, me, headers })

  // Forms send explicit null wall vars from initial values; on create that
  // means "no wall" — strip them so assertMoneroWallWrite sees no wall args.
  if (item.moneroWallPricePiconeros == null && item.moneroWallThresholdPiconeros == null) {
    delete item.moneroWallPricePiconeros
    delete item.moneroWallThresholdPiconeros
  }

  await assertMoneroWallWrite({ models, me, item, old: null })
  if ((item.moneroWallPricePiconeros != null || item.moneroWallThresholdPiconeros != null) && item.moneroWallEnabledAt == null) {
    item.moneroWallEnabledAt = new Date()
  }

  item.userId = me ? Number(me.id) : USER_ID.anon

  item.uploadIds = uploadIdsFromText(item.text)

  if (item.url && !isJob(item)) {
    item.url = ensureProtocol(item.url)
    item.url = removeTracking(item.url)
  } else if (item.url && !string().email().isValidSync(item.url)) {
    item.url = ensureProtocol(item.url)
  }

  if (item.parentId) {
    const parent = await models.itemPayIn.findFirst({ where: { itemId: parseInt(item.parentId), payIn: { payInType: 'ITEM_CREATE', payInState: 'PAID' } } })
    if (!parent) {
      throw new GqlInputError('cannot comment on unpaid item')
    }
  }

  // mark item as created with API key
  item.apiKey = me?.apiKey

  return await pay('ITEM_CREATE', item, { models, me, sendProtocolId })
}

// we have to do our own query because ltree is unsupported
export const SELECT =
  `SELECT "Item".*, "Item".created_at as "createdAt", "Item".updated_at as "updatedAt",
    ltree2text("Item"."path") AS "path"`
