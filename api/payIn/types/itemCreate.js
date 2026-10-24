import { ANON_COMMENT_FEE_MULTIPLIER, ANON_ITEM_SPAM_INTERVAL, ANON_POST_FEE_MULTIPLIER, ITEM_SPAM_FEE_ESCALATION_NUMERATOR, ITEM_SPAM_FEE_ESCALATION_DENOMINATOR, ITEM_SPAM_INTERVAL, PAID_ACTION_PAYMENT_METHODS, USER_ID } from '@/lib/constants'
import { denormalizeComment, runItemLiveSideEffects } from '@/lib/itemLiveEffects'
import { getItemMentions, getMentions, performBotBehavior, getSubs, getRootPrimarySub, countNonOwnedSubs } from '../lib/item'
import { extractMentions } from '@/lib/lexical/server/mentions'
import { canonicalizeItemText } from '@/lib/url'
import { GqlInputError } from '@/lib/error'
import { moneroUriAmountPiconeros } from '@/lib/format'
import { getItem } from '@/api/resolvers/item'
import { getTempImgproxyUrls } from '../lib/upload'
import { incrementFreeCommentCount, incrementFreePostCount } from '../lib/freebie'
import { postingFeePiconeros, commentQuotaFor, postQuotaFor } from '@/api/monero/postingFee'
import { resolveOwnerFeeRoute, postFeePiconerosForSubs, postFloorPiconerosForSubs, commentFeePiconerosForSubs, commentFloorPiconerosForSubs } from '@/api/monero/turfFeeRouting'
import { createOwnerFeeLeg, createPlatformFeeLeg } from '@/api/monero/ownerFeeLeg'
import { lwsClient } from '@/api/monero/lwsClient'
import { uploadFees } from '@/api/resolvers/upload'
import * as MEDIA_UPLOAD from './mediaUpload'

export const anonable = true

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.OPTIMISTIC,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

// 1.5x spam-fee escalation: the flat posting/comment fee is multiplied by
// (3/2)^n — the author's prior posts, or self-replies to this parent, within
// the window — rounded to the nearest piconero. Gentle enough that honest
// users pay it; steep enough that sustained spam compounds into real XMR.
// Anons use interval '0' so item_spam returns 0 (their x10/x3 is a separate
// flat multiplier handled in the anon branch).
export async function escalatedFeePiconeros (models, { parentId, userId, basePiconeros }) {
  if (basePiconeros <= 0n) return basePiconeros
  const within = userId === USER_ID.anon ? ANON_ITEM_SPAM_INTERVAL : ITEM_SPAM_INTERVAL
  const [{ n }] = await models.$queryRaw`
    SELECT item_spam(${parentId ? parseInt(parentId) : null}::INTEGER, ${userId}::INTEGER, ${within}::INTERVAL)::INTEGER AS n`
  const multiplier = ITEM_SPAM_FEE_ESCALATION_NUMERATOR ** BigInt(n)
  const divisor = ITEM_SPAM_FEE_ESCALATION_DENOMINATOR ** BigInt(n)
  return (basePiconeros * multiplier + divisor / 2n) / divisor
}

// Build the fee payment prospect for a fee-charging branch: owner-direct leg
// when the route resolves (one non-owned turf + owner wallet + no upload fees),
// else a platform rewards-wallet leg. Both are integrated-address invoices
// (api/monero/ownerFeeLeg.js); legacy subaddress invoices issued before the
// migration keep settling through rewardsWalletObserver. `fee` is the
// platform FLOOR math only; `premiumPiconeros` (the turf-owner surcharge
// delta) is added EXCLUSIVELY on the owner-routed leg — a premium must never
// be charged when the payment would land in the platform wallet.
//
// R10: shared with api/payIn/types/itemUpdate.js for edit-time turf-addition
// fees. Callers pass `payInType`/`itemPayIn` when the prospect belongs to a
// non-ITEM_CREATE flow; the routing/pricing math is identical, so an editor
// adding turfs pays exactly what a creator would have.
export async function itemFeeLeg (models, { subs, userId, fee, premiumPiconeros = 0n, uploadFeesPiconeros, description, payInType = 'ITEM_CREATE', itemPayIn = undefined, beneficiaries }) {
  const me = { id: userId }
  const route = await resolveOwnerFeeRoute(models, { subs, userId, uploadFeesPiconeros })
  const leg = route
    ? await createOwnerFeeLeg(models, lwsClient, {
      me,
      ownerAccount: route.ownerAccount,
      subName: route.sub.name,
      amountPiconeros: fee + premiumPiconeros + uploadFeesPiconeros,
      description
    })
    : await createPlatformFeeLeg(models, lwsClient, {
      me,
      feeType: 'POSTING',
      amountPiconeros: fee + uploadFeesPiconeros,
      description,
      // edits know their item now; creations bind it in onBegin
      postId: itemPayIn?.itemId ?? null
    })
  return {
    payInType,
    userId,
    piconeros: 0n,
    moneroUri: leg.moneroUri,
    moneroPaymentId: leg.paymentId,
    ...(itemPayIn ? { itemPayIn } : {}),
    beneficiaries
  }
}

// Upload-fee-only prospect (bios, owner-free items, in-quota items): the
// >10MB upload fee is platform revenue, so it always takes a platform leg.
async function uploadFeeLeg (models, { me, uploadFeesPiconeros, beneficiaries }) {
  const leg = await createPlatformFeeLeg(models, lwsClient, {
    me,
    feeType: 'POSTING',
    amountPiconeros: uploadFeesPiconeros,
    description: 'StasherNews upload fee'
  })
  return {
    payInType: 'ITEM_CREATE',
    userId: me.id,
    piconeros: 0n,
    moneroUri: leg.moneroUri,
    moneroPaymentId: leg.paymentId,
    beneficiaries
  }
}

export async function getInitial (models, args, { me }) {
  // StasherNews posting-fee gate (spec §6.2, Q5). Posting is free within the
  // monthly quota (established 5/month: stacked >= 1e10 piconeros AND age >= 7d;
  // low-rep 1/month); past the quota the user pays a posting fee to the platform
  // rewards wallet before their post goes live.
  //
  // piconeros is 0 in BOTH cases — StasherNews does not charge custodial sats for
  // posting. The fee (when required) is on-chain Monero to a rewards-wallet fee
  // subaddress, observed by the rewardsWalletObserver. The SN payIn engine therefore sees
  // piconeros=0 -> payInState=PAID; the post's VISIBILITY is gated independently by
  // Item.feeStatus (set in onBegin), which the rewardsWalletObserver flips PENDING_FEE ->
  // FEE_PAID when it observes the fee output.
  // Comments are free within the daily freebie quota (1/day low-rep, 3/day
  // established, +1 per quest completed today, +1 while the flame shows cycle
  // day 3); beyond it each comment costs the flat comment fee (see below).
  const beneficiaries = []
  let uploadFeesPiconeros = 0n
  if (args.uploadIds?.length) {
    const fees = await uploadFees(args.uploadIds, { models, me })
    uploadFeesPiconeros = fees.totalFeesPiconeros
    beneficiaries.push(await MEDIA_UPLOAD.getInitial(models, { uploadIds: args.uploadIds }, { me }))
  }

  // Bios are always free to create — the posting/comment fee gate targets spam
  // in turfs, not profile content. Upload fees (>10MB images in the bio text)
  // still apply, exactly like posts/comments.
  if (args.bio) {
    if (uploadFeesPiconeros > 0n) {
      return await uploadFeeLeg(models, { me, uploadFeesPiconeros, beneficiaries })
    }
    return { payInType: 'ITEM_CREATE', userId: me.id, piconeros: 0n }
  }

  // StasherNews per-turf-scaled POST fee: the posting fee is the flat floor
  // × the number of target turfs the author does NOT own. Owned turfs are free.
  // COMMENT fees are FLAT: a replier's cost never scales with how many turfs
  // the thread's author chose to post to. The per-turf count still gates the
  // owner-free waiver below (a reply is free only when the replier owns ALL
  // turfs the root post is in). When ALL target turfs are owned the item is
  // free (no fee subaddress). When no turfs are resolved (empty subNames —
  // defensive/legacy) the multiplier is 1, preserving the original flat-fee
  // behavior.
  const itemSubs = await getSubs(models, { subNames: args.subNames, parentId: args.parentId })
  // Turf repost (2026-09-24): a comment's fee follows the ROOT post's HOME
  // turf (primarySubName) when it has one — reposts buy feed distribution,
  // not conversation revenue, so the home turf owner keeps comment fees and
  // the owner-free reply waiver. Grandfathered roots (primarySubName null)
  // keep the legacy all-root-turfs rule.
  const homeSub = args.parentId ? await getRootPrimarySub(models, Number(args.parentId)) : null
  const feeSubs = args.parentId && homeSub ? [homeSub] : itemSubs
  const feeMultiplier = feeSubs.length === 0 ? 1n : BigInt(countNonOwnedSubs(feeSubs, me.id))

  if (feeMultiplier === 0n) {
    if (uploadFeesPiconeros > 0n) {
      return await uploadFeeLeg(models, { me, uploadFeesPiconeros, beneficiaries })
    }
    return { payInType: 'ITEM_CREATE', userId: me.id, piconeros: 0n }
  }

  if (args.parentId) {
    // StasherNews comment fee (spec §6.2): comments are free while the author has
    // freebies left (1/day low-rep, 3/day established, +1 per quest completed
    // today, +1 while the flame shows cycle day 3, resetting 00:00 UTC); beyond
    // the quota each comment costs the flat comment fee (commentFeePiconeros,
    // the operator-tunable flat comment fee)
    // to the platform rewards wallet, observed by the rewardsWalletObserver like
    // the posting fee. The fee is FLAT — it never scales with the root post's
    // turfs. Anon comments pay the comment fee x ANON_COMMENT_FEE_MULTIPLIER.
    if (me.id === USER_ID.anon) {
      // anon has no freebie quota and pays the comment fee x ANON_COMMENT_FEE_MULTIPLIER.
      // No spam escalation: ANON_ITEM_SPAM_INTERVAL '0' -> item_spam returns 0.
      // Anon CAN route owner-direct (they own no turf, so the single-turf root
      // resolves), so the comment premium rides that leg — scaled by the same
      // anon multiplier as the floor to keep the owner-routed total unchanged —
      // while the platform fallback charges floor-only x multiplier.
      const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
      if (!config) throw new GqlInputError('fee config not initialized')
      const nonOwned = feeSubs.filter(s => Number(s.userId) !== Number(USER_ID.anon))
      const base = commentFloorPiconerosForSubs(config, nonOwned) * BigInt(ANON_COMMENT_FEE_MULTIPLIER)
      const premium = (commentFeePiconerosForSubs(config, nonOwned) - commentFloorPiconerosForSubs(config, nonOwned)) * BigInt(ANON_COMMENT_FEE_MULTIPLIER)
      return await itemFeeLeg(models, {
        subs: feeSubs,
        userId: me.id,
        fee: base,
        premiumPiconeros: premium,
        uploadFeesPiconeros,
        description: 'StasherNews anon comment fee',
        beneficiaries
      })
    }
    const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
    if (!config) throw new GqlInputError('fee config not initialized')
    const commenter = await models.user.findUnique({ where: { id: me.id } })
    const commentsLeft = (await commentQuotaFor(models, commenter)).left
    if (commentsLeft > 0) {
      if (uploadFeesPiconeros > 0n) {
        return await uploadFeeLeg(models, { me, uploadFeesPiconeros, beneficiaries })
      }
      return { payInType: 'ITEM_CREATE', userId: me.id, piconeros: 0n }
    }
    const nonOwned = feeSubs.filter(s => Number(s.userId) !== Number(me.id))
    // spam escalation scales the platform FLOOR only; the turf premium is the
    // owner's surcharge — it rides exclusively the owner-routed leg, un-escalated
    const base = await escalatedFeePiconeros(models, {
      parentId: args.parentId,
      userId: me.id,
      basePiconeros: commentFloorPiconerosForSubs(config, nonOwned)
    })
    return await itemFeeLeg(models, {
      subs: feeSubs,
      userId: me.id,
      fee: base,
      premiumPiconeros: commentFeePiconerosForSubs(config, nonOwned) - commentFloorPiconerosForSubs(config, nonOwned),
      uploadFeesPiconeros,
      description: 'StasherNews comment fee',
      beneficiaries
    })
  }
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new GqlInputError('fee config not initialized')

  // anon has no user row and never qualifies for free posting: they pay the
  // flat fee x ANON_POST_FEE_MULTIPLIER directly (no spam escalation:
  // ANON_ITEM_SPAM_INTERVAL '0' -> item_spam returns 0). Like the anon comment
  // branch above, this must run BEFORE the user lookup.
  if (me.id === USER_ID.anon) {
    // empty subNames (defensive/legacy) keeps the flat floor via feeMultiplier's
    // 1n default — postFloorPiconerosForSubs over an empty list would sum to zero.
    // Anon CAN route owner-direct (they own no turf), so the post premium rides
    // that leg scaled by the same anon multiplier — the platform fallback
    // charges floor-only x multiplier.
    const nonOwned = feeSubs.filter(s => Number(s.userId) !== Number(USER_ID.anon))
    const base = (feeSubs.length === 0 ? postingFeePiconeros(config) : postFloorPiconerosForSubs(config, nonOwned)) * BigInt(ANON_POST_FEE_MULTIPLIER)
    const premium = (postFeePiconerosForSubs(config, nonOwned) - postFloorPiconerosForSubs(config, nonOwned)) * BigInt(ANON_POST_FEE_MULTIPLIER)
    return await itemFeeLeg(models, {
      subs: feeSubs,
      userId: me.id,
      fee: base,
      premiumPiconeros: premium,
      uploadFeesPiconeros,
      description: 'StasherNews anon posting fee',
      beneficiaries
    })
  }

  const user = await models.user.findUnique({ where: { id: me.id } })
  if (!user) throw new GqlInputError('user not found')

  const postsLeft = (await postQuotaFor(models, user, config)).left

  if (postsLeft > 0) {
    if (uploadFeesPiconeros > 0n) {
      return await uploadFeeLeg(models, { me, uploadFeesPiconeros, beneficiaries })
    }
    return {
      payInType: 'ITEM_CREATE',
      userId: me.id,
      piconeros: 0n
    }
  }

  // User past their free-post quota (established 5/month, low-rep 1/month):
  // route the posting fee — owner-direct when it resolves to a single non-owned
  // turf with a registered owner wallet, else a rewards-wallet subaddress. The
  // post is created PENDING_FEE (invisible) until the fee is observed on-chain
  // (rewardsWalletObserver for subaddresses, the fee: webhook for owner-direct
  // legs) and flipped to FEE_PAID. (Anon posts are handled in the early-return
  // branch above.) Spam escalation scales the floor; the premium delta rides
  // only the owner-routed leg.
  const nonOwned = feeSubs.filter(s => Number(s.userId) !== Number(me.id))
  const base = await escalatedFeePiconeros(models, {
    parentId: null,
    userId: me.id,
    basePiconeros: feeSubs.length === 0 ? postingFeePiconeros(config) : postFloorPiconerosForSubs(config, nonOwned)
  })
  return await itemFeeLeg(models, {
    subs: feeSubs,
    userId: me.id,
    fee: base,
    premiumPiconeros: postFeePiconerosForSubs(config, nonOwned) - postFloorPiconerosForSubs(config, nonOwned),
    uploadFeesPiconeros,
    description: 'StasherNews posting fee',
    beneficiaries
  })
}

export async function validateBeforeCreate (tx, payInProspect, payInArgs, { me }) {
  if (me.id === USER_ID.anon || payInArgs.bio || (payInArgs.parentId && payInProspect.piconeros === 0n)) {
    return
  }

  const recentItems = await tx.item.findMany({
    where: { userId: me.id },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: {
      id: true,
      itemPayIns: {
        where: {
          payIn: {
            payInType: 'ITEM_CREATE',
            payInState: 'PAID'
          }
        },
        select: { payInId: true },
        take: 1
      }
    }
  })

  if (recentItems.length >= 3 && recentItems.every(item => item.itemPayIns.length === 0)) {
    throw new GqlInputError('you have too many unpaid items')
  }
}

export async function onBegin (tx, payInId, args) {
  const { parentId, uploadIds = [], options: pollOptions = [], subNames = [], ...data } = args
  // never persist signed imgproxy preview urls: decode them to their embedded
  // source url (canonical https://<host>/uploads/N) so text survives key rotations
  if (data.text) data.text = canonicalizeItemText(data.text)
  const payIn = await tx.payIn.findUnique({ where: { id: payInId } })

  // StasherNews posting-fee gate: a PayIn carrying a fee invoice — an
  // integrated-address leg (moneroPaymentId set, platform or owner-direct) or
  // a legacy rewards-wallet subaddress (moneroSubaddressMajor set) — creates
  // the Item PENDING_FEE (invisible until the fee
  // is observed on-chain and flipped to FEE_PAID); otherwise the Item is live
  // (FEE_NOT_REQUIRED). feeStatus is derived here from the PayIn's fee markers
  // rather than threaded through the prospect, since feeStatus is an Item
  // column (not a PayIn column).
  const feeRequired = payIn.moneroSubaddressMajor != null || payIn.moneroPaymentId != null
  const feeStatus = feeRequired ? 'PENDING_FEE' : 'FEE_NOT_REQUIRED'

  // R01: an in-quota item whose only on-chain cost is the upload fee is born
  // PENDING_FEE, so the creation-time incrementFree* calls skip it (not
  // freeborn). Mark it here to consume its free quota at the fee flip
  // (flipPendingToLive). Only items that would have been free but for the
  // upload fee are marked: over-quota authors, anons, bios, and owner-free
  // items never consume quota. Recomputed here rather than threaded from
  // getInitial — the same-payer row lock serializes this user's payIn
  // operations, so it agrees with getInitial's branch decision.
  //
  // The quota helpers are RESERVATION-AWARE: a PENDING_FEE feeQuotaEligible
  // item holds its unit from creation (pendingQuotaReservations), so `left`
  // here is the slot count still spendable. That makes the re-check below the
  // concurrency gate for the upload-fee race: two simultaneous submissions
  // both priced upload-fee-only off the same unspent unit (getInitial runs
  // before the payer lock), and the loser must be rejected HERE — before any
  // payment — instead of alerting at its fee flip.
  let feeQuotaEligible = false
  if (feeRequired && !data.bio && payIn.userId !== USER_ID.anon) {
    const homeSub = parentId ? await getRootPrimarySub(tx, Number(parentId)) : null
    const markerSubs = parentId && homeSub ? [homeSub] : await getSubs(tx, { subNames, parentId })
    const ownerFree = markerSubs.length > 0 && countNonOwnedSubs(markerSubs, payIn.userId) === 0
    if (!ownerFree) {
      const quotaConfig = await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
      const payer = quotaConfig ? await tx.user.findUnique({ where: { id: payIn.userId } }) : null
      if (payer) {
        const quota = parentId
          ? await commentQuotaFor(tx, payer)
          : await postQuotaFor(tx, payer, quotaConfig)
        feeQuotaEligible = quota.left > 0
        // Concurrent double-submit guard: this pay-in was priced
        // upload-fee-ONLY (the quota had a slot at getInitial), but under the
        // lock the reservation-aware quota has none left — another submission
        // reserved or spent the unit in between. Throwing rolls back the
        // unpaid payIn/item; a fresh submit re-prices against the held unit.
        //
        // "Priced upload-fee-only" is recognizable from the stored payIn's
        // full quote alone: getInitial's in-quota branch prices the URI at
        // exactly the upload fees. A charged URI is item fee + upload fees >
        // upload fees, and an owner-direct leg never carries upload fees
        // (resolveOwnerFeeRoute refuses them) while its item fee is positive,
        // so both fail the amount equality — for legacy subaddress and
        // integrated invoices alike. Owner-free items, bios, and anons never
        // enter the quota block.
        if (!feeQuotaEligible) {
          const expected = moneroUriAmountPiconeros(payIn.moneroUri)
          if (expected != null && expected > 0n) {
            const { totalFeesPiconeros } = await uploadFees(uploadIds, { models: tx, me: { id: payIn.userId } })
            if (expected === totalFeesPiconeros) {
              throw new Error(parentId ? 'no free comments left' : 'no free posts left')
            }
          }
        }
      }
    }
  }

  const { userNames, itemIds } = extractMentions(data.text)
  const mentions = await getMentions(tx, { names: userNames, userId: payIn.userId })
  const itemMentions = await getItemMentions(tx, { itemIds, userId: payIn.userId })

  // start with median vote
  if (payIn.userId !== USER_ID.anon) {
    const [row] = await tx.$queryRaw`SELECT
      COALESCE(percentile_cont(0.5) WITHIN GROUP(
        ORDER BY "weightedVotes" - "weightedDownVotes"), 0)
      AS median FROM "Item" WHERE "userId" = ${payIn.userId}::INTEGER`
    if (row?.median < 0) {
      data.weightedDownVotes = -row.median
    }
  }

  const imgproxyUrls = await getTempImgproxyUrls(tx, uploadIds)

  // freebie is true when no on-chain fee is required and it's a comment or bio
  const isFreebie = !feeRequired && !!(parentId || data.bio)

  const itemData = {
    parentId: parentId ? parseInt(parentId) : null,
    ...data,
    // Turf repost (2026-09-24): the home turf — the single turf chosen at
    // creation. Comment fees follow it; reposts never change it. Null for
    // comments, bios, and legacy rows.
    primarySubName: !parentId && !data.bio && subNames.length === 1 ? subNames[0] : null,
    cost: Number(BigInt(payIn.piconeros) / 1000n),
    freebie: isFreebie,
    imgproxyUrls,
    feeStatus,
    feeQuotaEligible,
    feePayInId: feeStatus === 'PENDING_FEE' ? payInId : null,
    itemPayIns: {
      create: [{ payInId }]
    },
    subs: {
      createMany: {
        data: subNames.map(subName => ({ subName }))
      }
    },
    threadSubscriptions: {
      createMany: {
        data: [{ userId: data.userId }]
      }
    },
    pollOptions: {
      createMany: {
        data: pollOptions.map(option => ({ option }))
      }
    },
    itemUploads: {
      create: uploadIds.map(id => ({ uploadId: id }))
    },
    mentions: {
      createMany: {
        data: mentions
      }
    },
    itemReferrers: {
      create: itemMentions
    }
  }

  let item
  if (data.bio && payIn.userId !== USER_ID.anon) {
    item = (await tx.user.update({
      where: { id: data.userId },
      include: { bio: true },
      data: {
        bio: {
          create: itemData
        }
      }
    })).bio
  } else {
    try {
      item = await tx.item.create({ data: itemData })
    } catch (err) {
      if (err.message.includes('violates exclusion constraint \\"Item_unique_time_constraint\\"')) {
        const message = `you already submitted this ${itemData.title ? 'post' : 'comment'}`
        throw new GqlInputError(message)
      }
      throw err
    }
  }

  // Bind the created item to its platform fee intent (retained attribution:
  // a late receipt on an abandoned invoice still books the right postId).
  if (payIn.moneroPaymentId != null) {
    await tx.subFeePidMap.updateMany({
      where: { paymentId: payIn.moneroPaymentId, feeType: { not: null } },
      data: { postId: item.id }
    })
  }

  await performBotBehavior(tx, { ...item, userId: payIn.userId })

  return await getItem(null, { id: item.id }, { models: tx, me: { id: payIn.userId } })
}

export async function onRetry (tx, oldPayInId, newPayInId) {
  const itemPayIn = await tx.itemPayIn.findUnique({ where: { payInId: oldPayInId }, include: { payIn: true } })
  return await getItem(null, { id: itemPayIn.itemId }, { models: tx, me: { id: itemPayIn.payIn.userId } })
}

export async function onPaid (tx, payInId) {
  const { item, payIn } = await tx.itemPayIn.findUnique({
    where: { payInId },
    include: { item: true, payIn: true }
  })
  if (!item) {
    throw new Error('Item not found')
  }

  // StasherNews turf-owner perk: owner-free items must not consume the monthly
  // freebie quota — the owner's posting/commenting in their own turf is always
  // free, independent of the 15-comment / 5-post counters. Re-derive ownership
  // here (item.subNames for posts; the parent thread for comments) since the
  // prospect carries no owner marker.
  // Turf repost (2026-09-24): a comment's fee follows the ROOT post's HOME
  // turf (primarySubName) when it has one — mirrors getInitial so the
  // owner-free reply waiver agrees with the branch decision that created the
  // item (a past-quota home-turf owner's free reply on a reposted root must
  // never reach incrementFreeCommentCount — an exhausted quota throws P2025
  // here and rolls back the whole begin() tx). Grandfathered roots
  // (primarySubName null) keep the legacy all-root-turfs rule.
  const itemSubs = await getSubs(tx, { subNames: item.subNames, parentId: item.parentId })
  const homeSub = item.parentId ? await getRootPrimarySub(tx, item.parentId) : null
  const feeSubs = item.parentId && homeSub ? [homeSub] : itemSubs
  const ownerFree = feeSubs.length > 0 && countNonOwnedSubs(feeSubs, payIn.userId) === 0
  if (!ownerFree) {
    // If this is a freebie comment, increment the free comment counter.
    await incrementFreeCommentCount(tx, { item, userId: payIn.userId })
    // If this is a free top-level post within the monthly quota, increment the
    // free post counter. Self-guarding (no-op for comments, bios, paid posts).
    await incrementFreePostCount(tx, { item, userId: payIn.userId })
  }

  // retry OpenTimestamps stamp up to 12x with 10 minutes spacing
  //
  // NOTE: we cannot use pgboss' backoff mechanism as its jitter is up to an entire
  // `retrydelay` period, and thus would make it possible for a parent to be
  // consistently processed after a child, making this fragile; we have to maintain
  // item creation order for this.
  // pg-boss v9 dropped the DB-side default on pgboss.job.id (uuids are now minted
  // by the JS client), so these raw INSERTs must supply it via gen_random_uuid.
  await tx.$executeRaw`INSERT INTO pgboss.job (id, name, data, startafter, priority, retrylimit, retrydelay, retrybackoff)
    VALUES (gen_random_uuid(), 'timestampItem', jsonb_build_object('id', ${item.id}::INTEGER), now() + interval '10 minutes', -2, 12, 600, false)`
  await tx.$executeRaw`
    INSERT INTO pgboss.job (id, name, data, retrylimit, retrybackoff, startafter)
    VALUES (gen_random_uuid(), 'imgproxy', jsonb_build_object('id', ${item.id}::INTEGER), 21, true, now() + interval '5 seconds')`

  // denormalize the comment into its ancestors + Reply rows. A PENDING_FEE
  // comment is not live yet — its denormalization (and notifications) happen
  // when rewardsWalletObserver flips it FEE_PAID (flipPendingToLive).
  if (item.parentId && item.feeStatus !== 'PENDING_FEE') {
    await denormalizeComment(tx, item)
  }
}

export async function onPaidSideEffects (models, payInId) {
  const { item } = await models.itemPayIn.findUnique({
    where: { payInId },
    include: {
      item: {
        include: {
          mentions: true,
          itemReferrers: { include: { refereeItem: true } },
          user: true
        }
      }
    }
  })

  // StasherNews: a PENDING_FEE item is not live yet (invisible until the
  // rewardsWalletObserver observes its fee and flips feeStatus to FEE_PAID), so
  // suppress all creation side effects here. They fire at the flip instead.
  if (item.feeStatus === 'PENDING_FEE') {
    return
  }

  await runItemLiveSideEffects(models, item)
}

export async function describe (models, payInId) {
  const itemPayIn = await models.itemPayIn.findUnique({ where: { payInId }, include: { item: true } })
  if (itemPayIn?.item) {
    return `SN: create ${itemPayIn.item.parentId ? `reply #${itemPayIn.item.id} to #${itemPayIn.item.parentId}` : `post #${itemPayIn.item.id}`}`
  }
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { pessimisticEnv: true } })
  if (payIn.pessimisticEnv?.args) {
    const { subNames, parentId, bio } = payIn.pessimisticEnv.args
    if (bio) {
      return 'SN: create bio'
    }
    if (parentId) {
      return `SN: create reply to #${parentId}`
    }
    return `SN: create post in ${subNames.join(', ')}`
  }
  return 'SN: create item'
}
