import { PAID_ACTION_PAYMENT_METHODS, TERRITORY_PERIOD_COST } from '@/lib/constants'
import { nextBilling, needsCadenceFee } from '@/lib/territory'
import { territoryFeePiconeros } from '@/api/monero/territoryFee'
import { createPlatformFeeLeg } from '@/api/monero/ownerFeeLeg'
import { GqlInputError } from '@/lib/error'
import { scheduleTerritoryBilling } from '../lib/scheduleTerritoryBilling'
import { subOccWhere } from '../lib/territory'
import { assertUploadsWithinFreeSize, throwOnExpiredUploads } from '@/api/resolvers/upload'

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { oldName, billingType, uploadIds = [] }, { me }) {
  // StasherNews: turf descriptions cannot carry >10MB media (there is no
  // upload-fee path for turfs) and stale/deleted upload ids must fail with the
  // actionable "expired" error rather than saving a dead URL. Both checks run
  // before any subaddress draw.
  await throwOnExpiredUploads(uploadIds, { tx: models })
  await assertUploadsWithinFreeSize(uploadIds, { models })

  const oldSub = await models.sub.findUnique({
    where: {
      name: oldName
    }
  })

  const prospect = {
    payInType: 'TERRITORY_UPDATE',
    userId: me?.id,
    piconeros: 0n
  }

  // cadence switch to a longer/once plan: charge the FULL new fee on-chain at the
  // switch; the new period starts at the end of the current paid coverage so the
  // remaining days are never double-charged (spec §4b).
  const cadenceFee = needsCadenceFee(oldSub, billingType)
  if (cadenceFee) {
    const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
    if (!config) throw new GqlInputError('fee config not initialized')
    const cadencePiconeros = territoryFeePiconeros(billingType, config)
    const leg = await createPlatformFeeLeg(models, undefined, {
      me,
      feeType: 'TERRITORY_UPDATE',
      amountPiconeros: cadencePiconeros,
      description: `StasherNews turf ${oldSub.name} switch to ${billingType}`,
      subName: oldSub.name
    })
    prospect.moneroUri = leg.moneroUri
    prospect.moneroPaymentId = leg.paymentId
  }

  return prospect
}

export async function onBegin (tx, payInId, { oldName, billingType, uploadIds, ...data }) {
  const payIn = await tx.payIn.findUnique({ where: { id: payInId } })
  const oldSub = await tx.sub.findUnique({
    where: {
      name: oldName
    }
  })

  data.billingCost = TERRITORY_PERIOD_COST(billingType) // vestigial SN sats field

  const cadenceFee = needsCadenceFee(oldSub, billingType)

  // we never want to bill them again if they are changing to ONCE
  if (billingType === 'ONCE') {
    data.billPaidUntil = null
    data.billingAutoRenew = false
  } else if (cadenceFee) {
    // the new period starts at the end of the current paid coverage (or now if
    // the coverage has lapsed), so the remaining days are never double-charged
    const base = oldSub.billPaidUntil && new Date(oldSub.billPaidUntil) > new Date()
      ? new Date(oldSub.billPaidUntil)
      : new Date()
    data.billPaidUntil = nextBilling(base, billingType)
  }
  // yearly -> monthly: billPaidUntil stays; monthly billing begins once the
  // paid year ends (the territoryBilling worker picks up the new billingType)

  // if this billing change makes their bill paid up, set them to active
  if (data.billPaidUntil === null || data.billPaidUntil >= new Date()) {
    data.status = 'ACTIVE'
  }

  if (cadenceFee) {
    data.billingStatus = 'PENDING_FEE'
    data.billingPayInId = payInId
  }

  const updatedSub = await tx.sub.update({
    data: {
      ...data,
      billingType,
      subPayIn: {
        create: [{ payInId }]
      }
    },
    // optimistic concurrency control
    // make sure none of the relevant fields have changed since we fetched the sub
    where: {
      ...subOccWhere(oldSub),
      name: oldName,
      userId: payIn.userId
    }
  })

  await scheduleTerritoryBilling(tx, updatedSub.name, updatedSub.billPaidUntil)

  return updatedSub
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { subPayIn: true, pessimisticEnv: true } })
  const subName = payIn.subPayIn?.subName || payIn.pessimisticEnv?.args?.name
  return `SN: update territory billing ${subName}`
}
