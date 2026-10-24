import { PAID_ACTION_PAYMENT_METHODS, TERRITORY_PERIOD_COST } from '@/lib/constants'
import { nextBilling } from '@/lib/territory'
import { territoryFeePiconeros } from '@/api/monero/territoryFee'
import { createPlatformFeeLeg } from '@/api/monero/ownerFeeLeg'
import { scheduleTerritoryBilling } from '../lib/scheduleTerritoryBilling'
import { subOccWhere } from '../lib/territory'

// StasherNews territory billing/renewal (spec §6.2). Same shape as territoryCreate
// but for an existing Sub at renewal: issues an integrated fee invoice, emits the
// fee URI, and sets billingStatus=PENDING_FEE until the rewardsWalletObserver observes the
// fee. ONCE territories are never billed.

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { name }, { me }) {
  const sub = await models.sub.findUnique({ where: { name } })
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  const fee = territoryFeePiconeros(sub.billingType, config)
  // A NEW invoice (and pid) per renewal — never a reused per-turf pid.
  const leg = await createPlatformFeeLeg(models, undefined, {
    me,
    feeType: 'TERRITORY_BILLING',
    amountPiconeros: fee,
    description: `StasherNews territory ${name} renewal (${sub.billingType})`,
    subName: name
  })
  return {
    payInType: 'TERRITORY_BILLING',
    userId: me?.id,
    piconeros: 0n,
    moneroUri: leg.moneroUri,
    moneroPaymentId: leg.paymentId
  }
}

export async function onBegin (tx, payInId, { name }) {
  const sub = await tx.sub.findUnique({ where: { name } })

  if (sub.billingType === 'ONCE') {
    throw new Error('Cannot bill a ONCE territory')
  }

  let billedLastAt = sub.billPaidUntil
  let billingCost = sub.billingCost

  // if the sub is archived, they are paying to reactivate it
  if (sub.status === 'STOPPED') {
    billedLastAt = new Date()
    billingCost = TERRITORY_PERIOD_COST(sub.billingType)
  }

  const billPaidUntil = nextBilling(billedLastAt, sub.billingType)

  // StasherNews: mark PENDING_FEE until the rewardsWalletObserver observes the renewal fee.
  // The territory stays ACTIVE during the grace period; the territory worker lapses
  // it if PENDING_FEE persists past the grace window.
  const updated = await tx.sub.update({
    // optimistic concurrency control
    where: subOccWhere(sub),
    data: {
      billedLastAt,
      billPaidUntil,
      billingCost,
      status: 'ACTIVE',
      billingStatus: 'PENDING_FEE',
      billingPayInId: payInId,
      subPayIn: { create: [{ payInId }] }
    }
  })

  await scheduleTerritoryBilling(tx, updated.name, updated.billPaidUntil)

  return updated
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId }, include: { subPayIn: true, pessimisticEnv: true } })
  const subName = payIn.subPayIn?.subName || payIn.pessimisticEnv?.args?.name
  return `SN: billing for territory ${subName}`
}
