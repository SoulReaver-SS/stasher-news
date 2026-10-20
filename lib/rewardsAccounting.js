// Exact money accounting for the platform rewards hot wallet (rewards
// accounting repair §5). ONE source of truth for:
//   - the CONFIRMED receipt allocation between the next pool (rewards) and the
//     ops earmark (lib/rewardsPool.js, api/resolvers/rewards.js),
//   - the fee-adjusted unswept ops carry and the protected sweep debit bound
//     (api/monero/rewards.js, worker/rewardsDistributor.js),
//   - the standing fee reserve and the configured wallet identity
//     (api/monero/rewardsLedger.js, api/monero/rewardsTransactions.js).
//
// Pure BigInt helpers only: no Prisma client and no wallet is created here, so
// importing this module is inert and tests can inject their own models.

// Networks the platform rewards wallet is provisioned for. TESTNET is
// deliberately excluded — walletScope fails closed before any send.
const REWARDS_NETWORKS = ['STAGENET', 'MAINNET']

// Fixed weekly curator budget used whenever the dynamic budget is not in
// charge: LEGACY/SHADOW modes, invalid config, or a failed dynamic
// calculation (spec 2026-10-19 D13).
// Referrals may be additional; fees are ops.
export const CURATOR_FALLBACK_CAP_PICONEROS = 200_000_000_000n

// Convert an exact money value to BigInt. Rejects null/undefined ("unknown")
// and non-integer or unsafe numbers so a lossy Number can never silently round
// a piconero total.
export function money (value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('unsafe money number')
  if (value == null) throw new Error('unknown money value')
  return BigInt(value)
}

// BigInt with a zero default for optional reader fields.
const amount = value => (value == null ? 0n : money(value))

// Rewards earmark per the PlatformFeeConfig allocation split (spec §6.4):
// downvote 100% / posting 70% / turf 30% / boosts 30% / wallet-less tips 70%.
// `raw.donate` is already scaled by the payer's per-row percentage (the read
// query floors every donation row); `raw.donateRaw` is the unscaled total and
// only feeds the true inflow — the two stay distinct. BOUNTY_ROLLOVER uses the
// receipt's exact rewards component (`raw.bountyrolloverRewards`) when supplied
// — an explicit zero is authoritative — and the full legacy rollover amount
// when the row pre-dates the split (NULL/missing). BOUNTY_FEE is 100% ops and
// never appears as a rewards source. Each percentage source floors
// independently (aggregate floor), matching the distributor and the previous
// rewardsFromInflow rule exactly.
export function allocateInflow (raw = {}, config = {}) {
  const downvote = amount(raw.downvote)
  const posting = amount(raw.posting)
  const territory = amount(raw.territory)
  const donate = amount(raw.donate)
  const donateRaw = raw.donateRaw == null ? donate : amount(raw.donateRaw)
  const boost = amount(raw.boost)
  const walletlesstip = amount(raw.walletlesstip)
  const bountyrollover = amount(raw.bountyrollover)
  const bountyrolloverRewards = raw.bountyrolloverRewards == null ? bountyrollover : amount(raw.bountyrolloverRewards)
  const bountyfee = amount(raw.bountyfee)

  const sourceShares = [
    { name: 'downvote', piconeros: downvote * BigInt(config.downvoteRewardsPct) / 100n },
    { name: 'posting fee', piconeros: posting * BigInt(config.postingFeeRewardsPct) / 100n },
    { name: 'turf fee', piconeros: territory * BigInt(config.territoryFeeRewardsPct) / 100n },
    { name: 'donations', piconeros: donate },
    { name: 'boosts', piconeros: boost * BigInt(config.boostRewardsPct) / 100n },
    { name: 'wallet-less tips', piconeros: walletlesstip * BigInt(config.walletlessTipRewardsPct) / 100n },
    { name: 'bounty rollovers', piconeros: bountyrolloverRewards },
    // BOUNTY_FEE is 100% ops (escrow -> rewards wallet fee receipt); its pool
    // share is always zero. Kept in the list for stable source ordering.
    { name: 'bounty fees', piconeros: 0n }
  ]
  const sources = sourceShares.filter(s => s.piconeros > 0n).map(s => ({ name: s.name, value: s.piconeros.toString() }))
  const rewardsPiconeros = sourceShares.reduce((acc, s) => acc + s.piconeros, 0n)
  const totalPiconeros =
    downvote + posting + territory + donateRaw + boost + walletlesstip + bountyrollover + bountyfee
  return { totalPiconeros, rewardsPiconeros, opsPiconeros: totalPiconeros - rewardsPiconeros, sources }
}

// Signed unswept ops carry: the latest distribution's unswept ops snapshot
// (opsAvailable - proven swept) less the network costs incurred after that
// snapshot's checkpoint (spec §5). `distribution` may be NULL before the first
// distribution: zero available/swept/expense checkpoint, but already-incurred
// network costs still debit this cycle's ops. `provenSweptPiconeros` is the
// recorded opsSweptPiconeros, or the journal-proven swept principal when a
// sweep was relayed but not persisted. Negative carries stay negative: a
// deficit is never hidden.
export function opsCarry ({ distribution, totalNetworkFeesPiconeros, provenSweptPiconeros }) {
  const available = money(distribution?.opsAvailablePiconeros ?? 0n)
  const accounted = money(distribution?.opsNetworkFeesAccountedPiconeros ?? 0n)
  return available - money(provenSweptPiconeros) - (money(totalNetworkFeesPiconeros) - accounted)
}

// Nonnegative ops-sweep debit limit covering principal plus the future network
// fee: ops may never dip into outstanding reward commitments, the next pool,
// or the standing reserve. A signed (possibly negative) ops carry yields 0 —
// a deficit does not authorize a spend.
export function sweepDebitLimit ({ opsPiconeros, unlockedPiconeros, commitmentsPiconeros, nextPoolPiconeros, reservePiconeros }) {
  const commitments = money(commitmentsPiconeros)
  if (commitments < 0n) throw new Error('negative commitments amount')
  const room = money(unlockedPiconeros) - commitments - money(nextPoolPiconeros) - money(reservePiconeros)
  const ops = money(opsPiconeros)
  const cap = ops < room ? ops : room
  return cap > 0n ? cap : 0n
}

// Standing hot-wallet fee reserve: one fee-headroom allowance per funded signer
// account (balance > 0), at least one allowance, never below the sweep dust
// floor. Retained liquidity, not an expense or revenue.
export function standingReserve (balances, { feeHeadroom, dustFloor }) {
  const headroom = money(feeHeadroom)
  if (headroom < 0n) throw new Error('negative fee headroom')
  const dust = money(dustFloor)
  if (dust < 0n) throw new Error('negative dust floor')
  const funded = Math.max(1, Object.values(balances).filter(b => money(b) > 0n).length)
  const reserve = BigInt(funded) * headroom
  return reserve > dust ? reserve : dust
}

// The configured rewards-wallet identity `{ network, walletAddress }` that
// scopes every journal/ledger read and send. Fails closed before any spend
// when the identity is missing/empty or the network is not a rewards network.
// Error messages never echo configured values (no secret leakage).
export function walletScope () {
  const walletAddress = process.env.PLATFORM_REWARDS_ADDRESS
  if (typeof walletAddress !== 'string' || walletAddress.trim() === '') {
    throw new Error('rewards wallet scope: PLATFORM_REWARDS_ADDRESS is not configured')
  }
  const network = String(process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  if (!REWARDS_NETWORKS.includes(network)) {
    throw new Error(`rewards wallet scope: unsupported network (expected ${REWARDS_NETWORKS.join(' or ')})`)
  }
  return { network, walletAddress }
}
