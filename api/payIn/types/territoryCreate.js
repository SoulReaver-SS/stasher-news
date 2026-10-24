import { PAID_ACTION_PAYMENT_METHODS, TERRITORY_PERIOD_COST } from '@/lib/constants'
import { nextBilling } from '@/lib/territory'
import { initialTrust } from '../lib/territory'
import { discountedTerritoryFee, territoryFeePiconeros } from '@/api/monero/territoryFee'
import { createPlatformFeeLeg } from '@/api/monero/ownerFeeLeg'
import { scheduleTerritoryBilling } from '../lib/scheduleTerritoryBilling'
import { assertUploadsWithinFreeSize, throwOnExpiredUploads } from '@/api/resolvers/upload'

// StasherNews territory creation (spec §6.2). The founder pays a territory fee to
// the platform rewards wallet via an integrated-address invoice (legacy:
// a major-2 subaddress); the territory is created billingStatus=PENDING_FEE
// (invisible/inactive) until the fee is observed and flipped to PAID. piconeros=0 (no custodial sats) so the SN
// payIn engine yields payInState=PAID; the fee itself is on-chain.

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { billingType, name, uploadIds = [] }, { me }) {
  // StasherNews: turf descriptions cannot carry >10MB media (there is no
  // upload-fee path for turfs) and stale/deleted upload ids must fail with the
  // actionable "expired" error rather than saving a dead URL. Both checks run
  // before any subaddress draw.
  await throwOnExpiredUploads(uploadIds, { tx: models })
  await assertUploadsWithinFreeSize(uploadIds, { models })

  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  const fee = territoryFeePiconeros(billingType, config)
  // Day-7 quest-streak discount (spec §2.4): applied to the quoted fee here and
  // consumed at creation; one held max, one month expiry.
  const discountHeld = !!(await models.streakReward.findFirst({
    where: { userId: me.id, type: 'TURF_DISCOUNT', consumedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true }
  }))
  const amount = discountedTerritoryFee(fee, discountHeld)
  const leg = await createPlatformFeeLeg(models, undefined, {
    me,
    feeType: 'TERRITORY_CREATE',
    amountPiconeros: amount,
    description: `StasherNews territory ${name} (${billingType})`,
    subName: name
  })
  return {
    payInType: 'TERRITORY_CREATE',
    userId: me?.id,
    piconeros: 0n,
    moneroUri: leg.moneroUri,
    moneroPaymentId: leg.paymentId
  }
}

export async function onBegin (tx, payInId, { billingType, uploadIds, ...data }) {
  const payIn = await tx.payIn.findUnique({ where: { id: payInId } })
  const billedLastAt = new Date()
  const billPaidUntil = nextBilling(billedLastAt, billingType)

  const sub = await tx.sub.create({
    data: {
      ...data,
      billedLastAt,
      billPaidUntil,
      billingCost: TERRITORY_PERIOD_COST(billingType), // vestigial SN sats field
      billingType,
      billingStatus: 'PENDING_FEE',
      billingPayInId: payInId,
      rankingType: 'WOT',
      userId: payIn.userId,
      subPayIn: {
        create: [{ payInId }]
      },
      SubSubscription: {
        create: {
          userId: payIn.userId
        }
      }
    }
  })

  await tx.userSubTrust.createMany({
    data: await initialTrust(tx, { name: sub.name, userId: sub.userId })
  })

  await scheduleTerritoryBilling(tx, sub.name, sub.billPaidUntil)

  return sub
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { subPayIn: true, pessimisticEnv: true } })
  const subName = payIn.subPayIn?.subName || payIn.pessimisticEnv?.args?.name
  return `SN: create territory ${subName}`
}
