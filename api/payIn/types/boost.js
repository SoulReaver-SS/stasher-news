import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { createPlatformFeeLeg } from '@/api/monero/ownerFeeLeg'
import { piconerosToXmr, xmrToPiconeros } from '@/lib/format'
import { GqlInputError } from '@/lib/error'
import { getItemResult } from '../lib/item'

// StasherNews boost (A-14) — upstream-faithful one-time permanent ranking
// weight, 1:1 with tips. EVERY boost pays the platform rewards wallet via an
// integrated-address invoice (legacy invoices: a DEDICATED major-5 fee
// subaddress, still observed), NOT the legacy custodial sats path. R08: the owner-direct leg was REMOVED — a boost on an item in a
// single owned turf used to route 100% to that turf's owner when the owner had
// a registered wallet; an item author could boost their own post in a
// colluding owner's turf, paying the owner (minus tx fees) and getting the
// money back privately while buying rank at network-fee cost. Boosts now
// behave like every other platform-leg boost; in-flight owner-leg boosts
// created before the change are still applied by
// api/monero/subFeeObservation.js.
//
// The payIn is born PAID (fee payIns resolve to PAID at creation with
// piconeros=0n — the FeeObservation carries the real on-chain amount): the
// client shows the monero: URI and polls `payIn(id).feeObserved`; the
// shared fee applier (api/monero/feeObservation.js) records the on-chain
// output as a FeeObservation('BOOST') and applies the ranking bump
// (Item.boost += actual on-chain amount) exactly once, at the verified
// height transition (legacy subaddress boosts: at detection) — the PESSIMISTIC-only restriction is
// deliberate: a custodial-funded boost would never produce an on-chain tx, so
// never create a FeeObservation, so never rank or fund the pool (silent
// no-op), exactly as DONATE documents.
//
// piconeros is 0n on the PayIn; the real amount is observed on-chain.

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { id, piconeros }, { me }) {
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new GqlInputError('fee config not initialized')

  const amount = BigInt(piconeros)
  if (amount < config.minTipPiconeros) {
    throw new GqlInputError(`boost below minimum (${config.minTipPiconeros} piconeros)`)
  }

  const item = await models.item.findUnique({ where: { id: parseInt(id) } })
  if (!item) throw new GqlInputError('item not found')

  const leg = await createPlatformFeeLeg(models, undefined, {
    me,
    feeType: 'BOOST',
    amountPiconeros: amount,
    description: 'StasherNews boost',
    postId: item.id
  })

  return {
    payInType: 'BOOST',
    userId: me.id,
    piconeros: 0n,
    moneroUri: leg.moneroUri,
    moneroPaymentId: leg.paymentId,
    itemPayIn: { itemId: parseInt(id) }
  }
}

export async function onRetry (tx, oldPayInId) {
  const { itemId, payIn } = await tx.itemPayIn.findUnique({ where: { payInId: oldPayInId }, include: { payIn: true } })
  const item = await getItemResult(tx, { id: itemId })
  return { id: item.id, path: item.path, piconeros: payIn.piconeros, act: 'BOOST' }
}

export async function onBegin (tx, payInId, { id }) {
  // getItemResult, not tx.item.findUnique: Item.path is an Unsupported("ltree")
  // column Prisma cannot read (findUnique returns the row without it, so the
  // response's path would be null and the client's ancestor walk would crash
  // on null.split('.')).
  const item = await getItemResult(tx, { id })
  return { id: item.id, path: item.path, piconeros: 0n, act: 'BOOST' }
}

// No-op: with the FeeObservation carrying the real amount, the ranking bump is
// applied by the fee observation path (never before the money is on-chain).
export async function onPaid (tx, payInId) {
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId } })
  const amount = amountPiconerosFromUri(payIn.moneroUri, 0n)
  return `SN: boost #${payIn.itemPayIn?.itemId ?? payIn.id} by ${piconerosToXmr(amount)}`
}

// Parse the requested piconeros out of a monero: URI's tx_amount (decimal XMR),
// falling back to the PayIn's own piconeros (0n) when the URI is absent.
// (Copied from donate.js — keep both in sync.)
function amountPiconerosFromUri (uri, fallback) {
  if (!uri) return fallback ?? 0n
  const q = uri.split('?')[1] || ''
  const xmr = new URLSearchParams(q).get('tx_amount')
  if (!xmr) return fallback ?? 0n
  try {
    return xmrToPiconeros(xmr)
  } catch {
    return fallback ?? 0n
  }
}
