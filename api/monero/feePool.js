// Rewards-wallet fee subaddress pool (spec §5.6, §6.2).
//
// Posting and territory fees land on the single platform rewards wallet via
// DEDICATED subaddresses, pre-derived OFFLINE (scripts/derive-rewards-fee-subaddresses.js)
// and stored as SubaddressIndex rows. The running app never holds the rewards
// spend key; it only draws addresses from this pool and watches them via lws.
//
// Account-index convention on the rewards wallet:
//   major 1 = posting fees
//   major 2 = territory fees (create / billing / unarchive / update)
//   major 3 = donations (rewards pool)
//   major 4 = tips to wallet-less authors (TIP_UNWALLETED)
//   major 5 = boosts (rewards pool)
// (Major 0 is the wallet's primary address; Phase 4's downvotes use payment IDs,
//  not subaddresses, so they do not consume this pool.)

import prisma from '@/api/models'
import { rateLimit } from '@/lib/rate-limit'
import { GqlInputError } from '@/lib/error'
import { USER_ID } from '@/lib/constants'

export const REWARDS_POSTING_MAJOR = 1
export const REWARDS_TERRITORY_MAJOR = 2
export const REWARDS_DONATE_MAJOR = 3
export const REWARDS_TIP_UNWALLETED_MAJOR = 4
export const REWARDS_BOOST_MAJOR = 5

// all fee subaddress majors on the platform rewards wallet (consumed by the
// rewardsWalletObserver dispatch guard + the derive script)
export const FEE_MAJORS = [
  REWARDS_POSTING_MAJOR,
  REWARDS_TERRITORY_MAJOR,
  REWARDS_DONATE_MAJOR,
  REWARDS_TIP_UNWALLETED_MAJOR,
  REWARDS_BOOST_MAJOR
]

const FEE_TYPE_TO_MAJOR = {
  POSTING: REWARDS_POSTING_MAJOR,
  TERRITORY_CREATE: REWARDS_TERRITORY_MAJOR,
  TERRITORY_BILLING: REWARDS_TERRITORY_MAJOR,
  TERRITORY_UNARCHIVE: REWARDS_TERRITORY_MAJOR,
  TERRITORY_UPDATE: REWARDS_TERRITORY_MAJOR,
  DONATE: REWARDS_DONATE_MAJOR,
  TIP_UNWALLETED: REWARDS_TIP_UNWALLETED_MAJOR,
  BOOST: REWARDS_BOOST_MAJOR
}

/** Resolve the platform_rewards wallet id for the active network. */
export async function getRewardsWalletId (models = prisma) {
  const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  // orderBy id asc pins resolution when >1 platform_rewards row exists (test
  // residue on shared dev DBs) — same deterministic first-registered-wins
  // convention as initiateTipCore's rewards-wallet lookup in api/resolvers/monero.js.
  const account = await models.moneroAccount.findFirst({
    where: { label: 'platform_rewards', network },
    orderBy: { id: 'asc' }
  })
  if (!account) throw new Error('getRewardsWalletId: platform_rewards wallet not registered')
  return account.id
}

/**
 * Choke-point attempt throttle (audit A-3 follow-up): every fee-subaddress
 * consumer (item create/update, boost, donate, territory ops) funnels through
 * reserveFeeSubaddress, and every attempt permanently consumes one pool entry
 * whether or not it is ever paid — so an unpaid-attempt loop from one account
 * (e.g. edit-window updates each attaching a new unpaid upload) exhausts the
 * finite pools (~2000 posting / ~200 others). Keyed per user (the payIn engine
 * always provides me, defaulting to the synthetic anon user); per-IP
 * backstops live at the resolver layer. Env-overridable like the email limits.
 */
export const FEE_RESERVE_ATTEMPTS_PER_USER = Number(process.env.FEE_RESERVE_ATTEMPTS_PER_USER) || 60
export const FEE_RESERVE_WINDOW_MS = Number(process.env.FEE_RESERVE_WINDOW_MS) || 10 * 60_000

/**
 * The per-user fee-invoice attempt throttle, shared by every fee issuer: the
 * legacy subaddress draw above AND integrated fee legs (api/monero/ownerFeeLeg.js),
 * which register an lws webhook per attempt. One key/limit/window, so moving
 * a fee type from subaddresses to integrated addresses never widens the budget.
 * Throws GqlInputError when exhausted; call it before any side effect.
 */
export function throttleFeeIssuance ({ me } = {}) {
  const rl = rateLimit({
    key: `feereserve:${Number(me?.id) || USER_ID.anon}`,
    limit: FEE_RESERVE_ATTEMPTS_PER_USER,
    windowMs: FEE_RESERVE_WINDOW_MS
  })
  if (!rl.allowed) throw new GqlInputError('too many fee reservations, try again shortly')
}

/**
 * The ONLY issuance-time choice of the platform wallet for integrated fee
 * invoices (createPlatformFeeLeg is its only caller). Same selection as the
 * observer's findRewardsAccount — label, active network, view key present,
 * first registered wins — so the invoice pays the account the observer and
 * reconciler actually scan; additionally requires ACTIVE status and, when
 * configured, the PLATFORM_REWARDS_ADDRESS primary (the address downvote
 * invoices already use). Everything after issuance uses the intent's frozen
 * recipient, never this lookup. Throws when no account qualifies.
 */
export async function resolvePlatformFeeRecipient (models = prisma) {
  const account = await models.moneroAccount.findFirst({
    where: {
      label: 'platform_rewards',
      network: (process.env.MONERO_NETWORK || 'STAGENET').toUpperCase(),
      viewKey: { isNot: null }
    },
    orderBy: { id: 'asc' }
  })
  if (!account || account.status !== 'ACTIVE') {
    throw new Error('resolvePlatformFeeRecipient: no ACTIVE scannable platform_rewards wallet registered')
  }
  const configured = process.env.PLATFORM_REWARDS_ADDRESS
  if (configured && configured !== account.address) {
    throw new Error(`resolvePlatformFeeRecipient: registered platform_rewards account ${account.id} does not match PLATFORM_REWARDS_ADDRESS`)
  }
  return account
}

/**
 * Atomically draw + reserve one AVAILABLE fee subaddress for a pending fee event.
 *
 * Uses FOR UPDATE SKIP LOCKED so concurrent draws never double-assign: if two
 * requests race for the last subaddress, one gets it and the other throws
 * "pool exhausted" (which the caller surfaces as "re-run derive-fee-pool").
 * Returns { id, major, minor, address }.
 */
export async function reserveFeeSubaddress (models, feeType, { me } = {}) {
  const major = FEE_TYPE_TO_MAJOR[feeType]
  if (!major) throw new Error(`reserveFeeSubaddress: unknown feeType ${feeType}`)

  throttleFeeIssuance({ me })

  const walletId = await getRewardsWalletId(models)

  const rows = await models.$queryRaw`
    WITH next AS (
      SELECT id FROM "SubaddressIndex"
      WHERE "accountId" = ${walletId}::int
        AND "majorIndex" = ${major}::int
        AND state = 'AVAILABLE'
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "SubaddressIndex" SET state = 'ASSIGNED'
    FROM next WHERE "SubaddressIndex".id = next.id
    RETURNING "SubaddressIndex".id, "SubaddressIndex"."majorIndex", "SubaddressIndex"."minorIndex", "SubaddressIndex".address`

  if (!rows || rows.length === 0) {
    throw new Error(`reserveFeeSubaddress: rewards-wallet fee pool exhausted for major=${major} (feeType=${feeType}); run sndev monero derive-fee-pool`)
  }
  const r = rows[0]
  return { id: r.id, major: r.majorIndex, minor: r.minorIndex, address: r.address }
}
