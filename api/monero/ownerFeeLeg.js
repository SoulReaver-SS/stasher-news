import { randomUUID } from 'node:crypto'
import { generateSubFeePaymentId } from '@/api/monero/paymentId'
import { makeIntegratedAddress } from '@/api/monero/integratedAddress'
import { buildMoneroUri } from '@/api/monero/uri'
import { lwsClient } from '@/api/monero/lwsClient'
import { resolvePlatformFeeRecipient, throttleFeeIssuance } from '@/api/monero/feePool'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'

// Integrated-address fee legs — the single issuer for owner-routed fees AND
// (since integrated platform fees) platform posting/turf/boost fees. The file
// keeps its historical name; see the SubFeePidMap schema comment.

// 7-day liveness for a fee leg: unpaid legs are swept by webhookCleanup after
// this window (the item itself rides the existing abandonFeeItems machinery).
// It is webhook retention, not address validity: the map row is retained.
export const FEE_PID_TTL_MS = 7 * 86_400_000

/**
 * Build an integrated-address fee leg paying `recipientAccount`: HMAC fee:
 * payment id, integrated address derived from the recipient's registered
 * primary, a monero: URI quoting the FULL amount, an lws tx-confirmation
 * webhook on (recipient address, pid), and a SubFeePidMap row freezing the
 * recipient (account id + address snapshot) and the attribution receipts copy.
 * Called from payIn getInitial (before the PayIn exists — the URI is only
 * returned to the client after begin() commits, so a payment can never
 * precede the PayIn). A failed webhook or map write fails issuance, so no
 * URI is ever exposed without its intent row.
 *
 * Platform legs pass `feeType` (ownerUserId null); owner legs pass
 * `ownerUserId` + `subName` (feeType null). The DB route check enforces it.
 */
export async function createFeeLeg (models, monero = lwsClient, {
  me, recipientAccount, amountPiconeros, description,
  feeType = null, ownerUserId = null, subName = null, postId = null, now = new Date()
}) {
  throttleFeeIssuance({ me })
  const paymentId = generateSubFeePaymentId(randomUUID(), now.getTime())
  const { integratedAddress } = makeIntegratedAddress(recipientAccount.address, paymentId)
  const moneroUri = buildMoneroUri(
    [{ address: integratedAddress, amount: amountPiconeros }],
    { description }
  )

  const webhook = await monero.addWebhook({
    type: 'tx-confirmation',
    url: process.env.LWS_WEBHOOK_URL,
    address: recipientAccount.address,
    paymentId,
    token: process.env.LWS_WEBHOOK_TOKEN || '',
    confirmations: REQUIRED_CONFIRMATIONS
  })

  await models.subFeePidMap.create({
    data: {
      paymentId,
      subName,
      ownerUserId,
      amountPiconeros,
      webhookEventId: webhook.event_id ?? null,
      expiresAt: new Date(now.getTime() + FEE_PID_TTL_MS),
      recipientAccountId: recipientAccount.id,
      recipientAddress: recipientAccount.address,
      feeType,
      postId
    }
  })

  return { paymentId, integratedAddress, moneroUri }
}

// Owner-routed leg (turf owner's wallet). Receipts land in ObservedSubFee.
export async function createOwnerFeeLeg (models, monero = lwsClient, { me, ownerAccount, subName, amountPiconeros, description }) {
  return await createFeeLeg(models, monero, {
    me,
    recipientAccount: ownerAccount,
    ownerUserId: ownerAccount.ownerUserId,
    subName,
    amountPiconeros,
    description
  })
}

// Platform leg (rewards wallet primary). Receipts land in FeeObservation as
// `feeType`. The ONLY caller of resolvePlatformFeeRecipient.
export async function createPlatformFeeLeg (models, monero = lwsClient, { me, feeType, amountPiconeros, description, subName = null, postId = null, now }) {
  const recipientAccount = await resolvePlatformFeeRecipient(models)
  return await createFeeLeg(models, monero, { me, recipientAccount, feeType, amountPiconeros, description, subName, postId, now })
}

/**
 * The account whose view key verifies receipts for a fee intent. New intents
 * use their FROZEN recipient — never a re-resolved "current" wallet — and get
 * null (defer/unscannable) when that account is gone or its address no longer
 * equals the issuance snapshot. Historical owner intents (no recipient
 * snapshot) keep the legacy owner-account resolution. Includes viewKey and
 * subaddresses (isSelfSend input).
 */
export async function resolveFeeAccount (models, feeMap) {
  if (!feeMap) return null
  if (feeMap.recipientAddress != null) {
    const account = await models.moneroAccount.findUnique({
      where: { id: feeMap.recipientAccountId },
      include: { viewKey: true, subaddresses: true }
    })
    return account && account.address === feeMap.recipientAddress ? account : null
  }
  if (feeMap.ownerUserId == null) return null
  return await models.moneroAccount.findFirst({
    where: { ownerUserId: feeMap.ownerUserId, status: 'ACTIVE' },
    include: { viewKey: true, subaddresses: true }
  })
}
