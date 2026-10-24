import { USER_ID, PAY_IN_NOTIFICATION_TYPES, WALLET_MAX_RETRIES, WALLET_RETRY_BEFORE_MS } from '@/lib/constants'
import { GqlAuthenticationError } from '@/lib/error'
import { moneroUriAmountPiconeros } from '@/lib/format'
import { feeReceivedPiconerosForPayIn } from '@/api/monero/postingFee'
import { retry } from '../payIn'
import { payInTypesSql } from '../payIn/lib/sql'
import { decodeCursor, LIMIT, nextCursorEncoded } from '@/lib/cursor'
import { getItem, getItemsById } from './item'
import { getSub } from './sub'
import { Prisma } from '@prisma/client'

function payInResultType (payInType) {
  switch (payInType) {
    case 'ITEM_CREATE':
    case 'ITEM_UPDATE':
    case 'BOUNTY_PAYMENT':
      return 'Item'
    case 'TIP':
    case 'DOWNVOTE':
    case 'BOOST':
      return 'ItemAct'
    case 'POLL_VOTE':
      return 'PollVote'
    case 'TERRITORY_CREATE':
    case 'TERRITORY_UPDATE':
    case 'TERRITORY_BILLING':
    case 'TERRITORY_UNARCHIVE':
      return 'Sub'
  }
}

function isMine (payIn, { me }) {
  const meId = me?.id ?? USER_ID.anon
  return Number(meId) === Number(payIn.userId)
}

export async function getPayIn (parent, { id }, { me, models }) {
  const payIn = (await getPayInFull({
    models,
    query: Prisma.sql`SELECT * FROM "PayIn" WHERE "PayIn"."id" = ${id}`
  }))[0]

  if (!payIn) {
    throw new Error('PayIn not found')
  }

  const meId = me?.id ?? USER_ID.anon
  if (Number(payIn.userId) !== Number(meId) &&
    !payIn.payOutCustodialTokens.some(token => Number(token.userId) === Number(meId))) {
    throw new GqlAuthenticationError()
  }
  return payIn
}

export default {
  Query: {
    payIn: getPayIn,
    statistics: async (parent, { cursor, walletId }, { models, me }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      const userId = me.id
      // StasherNews: per-wallet filtering was removed with the Lightning strip.
      if (walletId != null) {
        return { payIns: [], cursor: null }
      }
      const decodedCursor = decodeCursor(cursor)
      const offset = decodedCursor.offset
      const limit = LIMIT

      // StasherNews: the history feed is built from the observation tables (the
      // fork's real source of truth), NOT from PayIn rows — PayIn.piconeros is 0
      // for every monero fee/downvote, tips never create PayIns, and the receive
      // side (tips) has no PayIn at all. Only CONFIRMED observations count.
      // Synthetic rows get negative ids so they never collide with real PayIn.id
      // or the Apollo cache key ['id', 'isSend'].
      //
      // Posting/downvote rows carry their postId; TERRITORY_* fees carry subName
      // instead (postId is NULL for territory fees), so the row can link to the
      // turf and payInContext can render the TerritoryDetails.
      // Tips the viewer SENT (tipperId = viewer) get their own isSend=true row.
      // Same negative id expression as the receive branch — the Apollo cache key
      // is ['id', 'isSend'], so a self-tip's two rows never collide.
      const rows = await models.$queryRaw`
        (
          SELECT
            (-t.id)::int AS id,
            t."confirmedAt" AS "createdAt",
            t."confirmedAt" AS "updatedAt",
            t.piconeros AS piconeros,
            'TIP'::"PayInType" AS "payInType",
            'PAID'::"PayInState" AS "payInState",
            t."confirmedAt" AS "payInStateChangedAt",
            NULL::int AS "userId",
            false AS "isSend",
            t."postId" AS "itemId",
            NULL::citext AS "subName"
          FROM "ObservedTip" t
          JOIN "MoneroAccount" ma ON ma.id = t."recipientAccountId"
          WHERE t.state = 'CONFIRMED'
            AND ma."ownerUserId" = ${userId}
            AND t."confirmedAt" <= ${decodedCursor.time}
        )
        UNION ALL
        (
          SELECT
            (-t.id)::int AS id,
            t."confirmedAt" AS "createdAt",
            t."confirmedAt" AS "updatedAt",
            t.piconeros AS piconeros,
            'TIP'::"PayInType" AS "payInType",
            'PAID'::"PayInState" AS "payInState",
            t."confirmedAt" AS "payInStateChangedAt",
            ${userId}::int AS "userId",
            true AS "isSend",
            t."postId" AS "itemId",
            NULL::citext AS "subName"
          FROM "ObservedTip" t
          WHERE t.state = 'CONFIRMED'
            AND t."tipperId" = ${userId}
            AND t."confirmedAt" <= ${decodedCursor.time}
        )
        UNION ALL
        (
          SELECT
            (-1000000000 - b.id)::int AS id,
            b."confirmedAt",
            b."confirmedAt",
            b.piconeros,
            'DOWNVOTE'::"PayInType",
            'PAID'::"PayInState",
            b."confirmedAt",
            ${userId}::int,
            true AS "isSend",
            b."postId",
            NULL::citext
          FROM "ObservedDownvote" b
          WHERE b.state = 'CONFIRMED'
            AND b."downvoterId" = ${userId}
            AND b."confirmedAt" <= ${decodedCursor.time}
        )
        UNION ALL
        (
          SELECT
            (-2000000000 - f.id)::int AS id,
            f."confirmedAt",
            f."confirmedAt",
            f.piconeros,
            p."payInType",
            'PAID'::"PayInState",
            f."confirmedAt",
            ${userId}::int,
            true AS "isSend",
            f."postId",
            f."subName"
          FROM "FeeObservation" f
          JOIN "PayIn" p ON p.id = f."payInId"
          WHERE f.state = 'CONFIRMED'
            AND p."userId" = ${userId}
            AND f."confirmedAt" <= ${decodedCursor.time}
        )
        ORDER BY "payInStateChangedAt" DESC, "isSend" ASC
        OFFSET ${offset}
        LIMIT ${limit}`

      // hydrate item (for tips/downvotes/posting fees) and, for territory fees,
      // leave subPayIn populated so PayerPrivates.sub + PayInContext render the turf.
      const itemIds = rows.map(r => Number(r.itemId)).filter(id => Number.isInteger(id) && id > 0)
      const items = await getItemsById(itemIds, { me, models })
      const itemMap = new Map(items.map(item => [Number(item.id), item]))

      const payIns = rows.map(row => ({
        ...row,
        itemPayIn: row.itemId ? { itemId: row.itemId } : null,
        subPayIn: row.subName ? { subName: row.subName } : null,
        pessimisticEnv: null,
        payInCustodialTokens: [],
        payOutCustodialTokens: [],
        beneficiaries: [],
        refundCustodialTokens: [],
        item: row.itemId ? (itemMap.get(Number(row.itemId)) ?? null) : null
      }))

      return {
        payIns,
        cursor: payIns.length === limit ? nextCursorEncoded(decodedCursor) : null
      }
    },
    failedPayIns: async (parent, args, { me, models }) => {
      if (!me) {
        throw new GqlAuthenticationError()
      }
      return await models.$queryRaw`
          -- payIns whose most recent attempt failed, are not retried enough times yet,
          -- are not too old, and weren't manually cancelled
          SELECT "PayIn".*
          FROM "PayIn"
          WHERE "PayIn"."payInState" = 'FAILED'
          AND "PayIn"."payInType" IN (${payInTypesSql(PAY_IN_NOTIFICATION_TYPES)})
          AND "PayIn"."userId" = ${me.id}
          AND "PayIn"."successorId" IS NULL
          AND "PayIn"."benefactorId" IS NULL
          AND "PayIn"."payInFailureReason" <> 'USER_CANCELLED'
          AND "PayIn"."payInStateChangedAt" > now() - ${`${WALLET_RETRY_BEFORE_MS} milliseconds`}::interval
          AND "PayIn"."retryCount" < ${WALLET_MAX_RETRIES}
          ORDER BY "PayIn"."payInStateChangedAt" ASC`
    }
  },
  Mutation: {
    retryPayIn: async (parent, { payInId, sendProtocolId }, { models, me }) => {
      return await retry(payInId, { me, sendProtocolId })
    }
  },
  PayIn: {
    // On-chain confirmation signal for fee payIns (DONATE/posting/territory). The
    // payIn is born PAID (piconeros=0n; the observation carries the real
    // amount), so this checks whether an observation in a "payment succeeded"
    // state has landed for it — mirroring shouldTriggerPaymentSuccess (DETECTED
    // or CONFIRMED). FeeObservation.payInId is @unique, so at most one row.
    // Owner-routed legs (turf-owner-revenue) record ObservedSubFee receipts
    // instead: those are born DETECTED and only mature, so any receipt row
    // means coins landed — no state filter needed. Only resolved when a query
    // explicitly requests it (e.g. the DONATE modal poll), so it costs nothing
    // on the general payIn queries.
    feeObserved: async (payIn, args, { models }) => {
      if (typeof payIn.feeObserved !== 'undefined') return payIn.feeObserved
      return await isFeeObserved(payIn, { models })
    },
    // Coverage-aware companion to feeObserved (see the typeDef doc). Fee payIns
    // are born PAID, so the client's fee modals poll observation state; modals
    // whose gated record settles only at FULL coverage (Upload.paid) must poll
    // this instead of feeObserved, which flips on any partial payment. The sums
    // mirror the settle gates: integrated (payment-id) invoices count only
    // verified receipts (api/monero/feeObservation.js); legacy subaddress
    // invoices keep their unfiltered sum (rewardsWalletObserver
    // attributeFeeBySubaddress).
    feeCovered: async (payIn, args, { models }) => {
      if (typeof payIn.feeCovered !== 'undefined') return payIn.feeCovered
      const expected = payIn.moneroUri ? moneroUriAmountPiconeros(payIn.moneroUri) : null
      // Integrated (payment-id) invoices: coverage means exactly what their
      // gate counts — height-bearing, live-state receipts — so provisional
      // money never reads as settled.
      if (payIn.moneroPaymentId != null) {
        if (expected == null || expected <= 0n) return false
        return (await feeReceivedPiconerosForPayIn(models, payIn.id, { verifiedOnly: true })) >= expected
      }
      // no parseable URI = a legacy/ungated fee: any observation covers it
      if (expected === null) return await isFeeObserved(payIn, { models })
      const [fees, subFees] = await Promise.all([
        models.feeObservation.aggregate({ _sum: { piconeros: true }, where: { payInId: payIn.id } }),
        models.observedSubFee.aggregate({ _sum: { piconeros: true }, where: { payInId: payIn.id } })
      ])
      return (fees._sum.piconeros ?? 0n) >= expected || (subFees._sum.piconeros ?? 0n) >= expected
    },
    payerPrivates: (payIn, args, { models, me }) => {
      if (!isMine(payIn, { me })) {
        return null
      }
      return payIn
    },
    item: async (payIn, args, { models, me }) => {
      // downzaps are private to the payer
      if (!payIn.itemPayIn || (!isMine(payIn, { me }) && payIn.payInType === 'DOWNVOTE')) {
        return null
      }
      if (typeof payIn.item !== 'undefined') {
        return payIn.item
      }
      return await getItem(payIn, { id: payIn.itemPayIn.itemId }, { me, models })
    },
    walletInfo: () => {
      // StasherNews: walletInfo was backed by Lightning wallet protocols, which are
      // gone with the Monero strip — there is never a wallet to report.
      return null
    },
    payOutCustodialTokens: async (payIn, args, { models, me }) => {
      const payOutCustodialTokens = [
        ...(payIn.payOutCustodialTokens ?? []),
        ...(payIn.beneficiaries ?? []).reduce((acc, beneficiary) => {
          if (beneficiary.payOutCustodialTokens) {
            return [...acc, ...beneficiary.payOutCustodialTokens]
          }
          return acc
        }, [])
      ]

      // obscure rewards if they are not mine
      if (payIn.payInType === 'REWARDS') {
        const meId = Number(me.id)
        const myReward = payOutCustodialTokens.find(t => t.payOutType === 'REWARD' && Number(t.userId) === Number(meId))
        const remainingOtherReward = payOutCustodialTokens.find(t => t.payOutType === 'REWARD' && Number(t.userId) !== Number(meId))
        const visibleRewards = myReward ? [myReward] : []
        if (remainingOtherReward) {
          const remainingRewardPiconeros = BigInt(payIn.piconeros) - BigInt(myReward?.mtokens ?? 0)
          if (remainingRewardPiconeros > 0n) {
            visibleRewards.push({
              id: remainingOtherReward.id,
              payOutType: 'REWARD',
              mtokens: remainingRewardPiconeros,
              custodialTokenType: 'SATS'
            })
          }
        }
        return visibleRewards
      }

      // StasherNews: the routing-fee hiding branch was driven by Lightning pay-out
      // membership, which is gone with the Monero strip — there is nothing to obscure,
      // so the full custodial token list is always visible.
      return payOutCustodialTokens
    }
  },
  PayOutCustodialToken: {
    privates: (payOutCustodialToken, args, { models, me }) => {
      if (!isMine(payOutCustodialToken, { me })) {
        return null
      }
      return payOutCustodialToken
    },
    sometimesPrivates: (payOutCustodialToken, args, { models, me }) => {
      if (!isMine(payOutCustodialToken, { me }) && payOutCustodialToken.payOutType !== 'TIP') {
        return null
      }
      return payOutCustodialToken
    },
    sub: async (payOutCustodialToken, args, { models }) => {
      if (payOutCustodialToken.sub) {
        return payOutCustodialToken.sub
      }
      if (payOutCustodialToken.subPayOutCustodialToken) {
        return payOutCustodialToken.subPayOutCustodialToken.sub
      }
      if (payOutCustodialToken.subId == null) {
        return null
      }
      return await models.sub.findUnique({ where: { id: payOutCustodialToken.subId } })
    }
  },
  PayerPrivates: {
    payInCustodialTokens: (payIn, args, { me }) =>
      (payIn.payInCustodialTokens ?? []).map(token => ({
        ...token,
        mtokensAfter: isMine(payIn, { me }) ? token.mtokensAfter : null
      })),
    refundCustodialTokens: (payIn, args, { me }) =>
      (payIn.refundCustodialTokens ?? []).map(token => ({
        ...token,
        mtokensAfter: isMine(payIn, { me }) ? token.mtokensAfter : null
      })),
    pessimisticEnv: (payIn) => payIn.pessimisticEnv ?? null,
    result: (payIn, args, { models, me }) => {
      // if the payIn was paid pessimistically, the result is permanently in the pessimisticEnv
      const result = payIn.result || payIn.pessimisticEnv?.result
      if (result) {
        const __typename = payInResultType(payIn.payInType)
        if (payIn.payInType === 'BOUNTY_PAYMENT' && __typename === 'Item') {
          // Bounty result items should not carry item-creation payIn metadata.
          return { ...result, payIn: null, __typename }
        }
        return { ...result, __typename }
      }
      return null
    },
    invite: async (payIn, args, { models, me }) => {
      return payIn.payOutCustodialTokens.find(token => token.payOutType === 'INVITE_GIFT')?.user?.invite
    },
    sub: async (payIn, args, { models, me }) => {
      if (!payIn.subPayIn) {
        return null
      }
      return await getSub(payIn, { name: payIn.subPayIn.subName }, { models, me })
    }
  }
}

// The "payment succeeded" observation predicate shared by feeObserved and the
// URI-less fallback of feeCovered: a FeeObservation in a success state, or an
// owner-routed ObservedSubFee receipt in a live state (a refused EXCLUDED or
// reversed REORGED receipt never signals payment).
async function isFeeObserved (payIn, { models }) {
  const obs = await models.feeObservation.findFirst({
    where: { payInId: payIn.id, state: { in: ['DETECTED', 'CONFIRMED'] } }
  })
  if (obs) return true
  const subFee = await models.observedSubFee.findFirst({ where: { payInId: payIn.id, state: { in: ['DETECTED', 'CONFIRMED'] } } })
  return !!subFee
}

/*
  getPayInFull mimics a Prisma query with the same includes, but uses raw SQL
  so we can do more complex selection of payIns

  const INCLUDE_PAYOUT_CUSTODIAL_TOKENS = {
    include: {
      user: {
        include: {
          invite: true
        }
      },
      subPayOutCustodialToken: {
        include: {
          sub: true
        }
      }
    }
  }

  const INCLUDE = {
    pessimisticEnv: true,
    payInCustodialTokens: true,
    payOutCustodialTokens: INCLUDE_PAYOUT_CUSTODIAL_TOKENS,
    beneficiaries: {
      include: {
        payOutCustodialTokens: INCLUDE_PAYOUT_CUSTODIAL_TOKENS
      }
    },
    itemPayIn: true,
    subPayIn: true
  }
*/

async function getPayInFull ({ models, query, orderBy = Prisma.empty }) {
  // StasherNews: the custodial/Lightning pay-in/out tables (PayOutCustodialToken,
  // PayInCustodialToken, RefundCustodialToken, PessimisticEnv, SubPayOutCustodialToken,
  // ...) were removed in the Monero strip. The Lightning wallet history this query fed
  // is obsolete; a Monero wallet history is a separate feature. We return the bare PayIn
  // rows plus the surviving ItemPayIn/SubPayIn links, and default the removed relations
  // to null/empty so the PayIn field resolvers take their fast path and never fall
  // through to the (also removed) lazy-load Prisma models.
  const rows = await models.$queryRaw`
    WITH payins AS (
      ${query}
    )
    SELECT
      p.*,
      p.created_at AS "createdAt",
      p.updated_at AS "updatedAt",
      ip."itemPayIn",
      sp."subPayIn"
    FROM payins p
    LEFT JOIN LATERAL (
      SELECT to_jsonb(x.*) AS "itemPayIn"
      FROM "ItemPayIn" x
      WHERE x."payInId" = p.id
      ORDER BY x.id
      LIMIT 1
    ) ip ON true
    LEFT JOIN LATERAL (
      SELECT to_jsonb(x.*) AS "subPayIn"
      FROM "SubPayIn" x
      WHERE x."payInId" = p.id
      ORDER BY x.id
      LIMIT 1
    ) sp ON true
    ${orderBy}`

  return rows.map(r => ({
    ...r,
    pessimisticEnv: null,
    payInCustodialTokens: [],
    payOutCustodialTokens: [],
    beneficiaries: [],
    refundCustodialTokens: []
  }))
}
