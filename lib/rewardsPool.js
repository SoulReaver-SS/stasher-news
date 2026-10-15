// Shared "what is currently allocated where" computation for the platform
// rewards wallet (MoneroAccount { label: 'platform_rewards' }). ONE source of
// truth for:
//   - the /rewards page's active pool + countdown (api/resolvers/rewards.js),
//   - the transparency page's literal rewards/ops allocation
//     (api/resolvers/rewardsWallet.js),
// so those surfaces can never drift apart.
//
// Rewards allocation = the FULL pool, not the capped weekly curator budget:
// this cycle's
// rewards-earmarked CONFIRMED inflow (split per PlatformFeeConfig, BigInt
// floors per source exactly like worker/rewardsDistributor.js) + the latest
// distribution's rolledOverPiconeros. Before the first distribution the cycle
// window falls back to the trailing 7 days (the same fallback /rewards uses).
// Never cap this reader: ops sweeps must protect rewards held for future weeks.
//
// Ops allocation = the funds awaiting the ops sweep: the latest distribution's
// fee-adjusted unswept carry (opsCarry: opsAvailable - proven swept - the
// network costs incurred after its checkpoint) PLUS this cycle's ops-earmarked
// inflow (totalInflow - rewardsInflow). The distributor's next run allocates
// exactly this much (opsAvailable = opsInflow + opsCarry) and records the
// cumulative RELAYED network cost as its checkpoint, so every hot-wallet fee
// debits ops exactly once. Before the first distribution nothing has ever been
// swept, but already-incurred network costs still debit this cycle's ops. This
// is also the definition of the monero_ops_pending_piconeros metric in
// lib/metrics.js.
//
// outstandingRewardsPiconeros (older QUEUED / unreconciled FAILED rows whose
// relay is not proven) is deliberately NOT part of pendingSweepPiconeros: it is
// money the pool has already allocated and must never look like sweepable ops.
//
// Everything is DB-ledger derived; lws is never consulted. BigInt only.

import { allocateInflow, opsCarry, walletScope } from './rewardsAccounting'
import { readRewardsInflow } from '@/api/monero/rewardsInflow'
import { readRewardsWalletLedger } from '@/api/monero/rewardsLedger'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function toBigInt (v) {
  if (v == null) return 0n
  return BigInt(v)
}

// Rewards earmark per the PlatformFeeConfig allocation split (spec §6.4):
// downvote 100% / posting 70% / turf 30% / boosts 30% / wallet-less tips 70%.
// Donations go the payer-chosen % to the pool (default 100); bounty rollovers
// (BOUNTY_ROLLOVER) go 100% to the pool for legacy rows, or use the receipt's
// exact `bountyrolloverRewards` mixed split when the reader supplies one;
// BOUNTY_FEE is 100% ops (booked at funding, physically arrives with the
// rollover) so its pool share is 0. BigInt division floors each source
// independently, matching worker/rewardsDistributor.js. The allocation rules
// live in lib/rewardsAccounting.js (allocateInflow) — this is the legacy
// `{ total, time, sources }` view over them.
export function rewardsFromInflow (inflow, time, config) {
  const { rewardsPiconeros, sources } = allocateInflow(inflow, config)
  return { total: rewardsPiconeros, time, sources }
}

// Active (next) distribution pool + the current literal ops allocation.
// Returns:
//   poolPiconeros          — rewards: this cycle's rewards earmark + latest rollover
//   rewardsInflowPiconeros — this cycle's rewards earmark before the rollover
//   totalInflowPiconeros   — this cycle's raw CONFIRMED eligible inflow (all sources)
//   pendingSweepPiconeros  — ops: the latest distribution's fee-adjusted carry
//                            (opsCarry) + this cycle's ops inflow
//   rolledOverPiconeros    — latest distribution's rolledOver (0n if none)
//   totalNetworkFeesPiconeros   — cumulative unique RELAYED hot-wallet fees
//   outstandingRewardsPiconeros — allocated full rewards not yet delivered
//   accountingUncertain         — unresolved attempts / conflicting ledger facts
//   ledgerFingerprint           — the shared versioned accounting audit
//                                 fingerprint (`accounting:v2:…` of the ONE
//                                 safe snapshot the ledger reader consumes)
//   time                   — the next distribution slot, computed in SQL
//   sources                — this cycle's rewards-earmarked sources (for /rewards)
//
// The whole read runs inside ONE Serializable transaction so the inflow, the
// ledger and the distribution snapshot can never disagree with each other.
export async function getNextRewardsPool (models) {
  return await models.$transaction(tx => readNextRewardsPool(tx), { isolationLevel: 'Serializable', timeout: 10000 })
}

// The transaction-scoped pool read (same readers/formula as
// getNextRewardsPool) so a caller can fold it into its OWN consistent DB
// snapshot — the ops sweep does. `config` may be supplied by a caller that
// already read the allocation config in the same snapshot; otherwise it is
// read here. No wallet/network call ever happens inside this DB work.
export async function readNextRewardsPool (tx, config = null) {
  // Allocation config and every monetary fact are read in the SAME
  // Serializable snapshot, so a concurrent config change can never combine
  // an old split with newer inflow/ledger facts.
  const cfg = config ?? await tx.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  const lastDistribution = await tx.rewardDistribution.findFirst({ orderBy: { periodEnd: 'desc' } })
  const periodStart = lastDistribution?.periodEnd ?? new Date(Date.now() - WEEK_MS)

  // ONE inflow reader for every consumer (no end: the open cycle is
  // everything confirmed since the last distribution ended).
  const inflow = await readRewardsInflow(tx, { start: periodStart, config: cfg })
  // ONE factual ledger, scoped to the configured rewards wallet.
  const ledger = await readRewardsWalletLedger(tx, { scope: walletScope() })

  // Fee-adjusted unswept carry: the latest distribution's snapshot less the
  // proven swept principal less the network costs incurred after its
  // checkpoint. A journal-proven (but unpersisted) sweep substitutes for the
  // recorded swept amount, so carry can never release funds for a relay that
  // actually left the wallet.
  const opsRolledOver = opsCarry({
    distribution: lastDistribution,
    totalNetworkFeesPiconeros: ledger.totalNetworkFeesPiconeros,
    provenSweptPiconeros: lastDistribution
      ? (ledger.sweptByDistribution.get(lastDistribution.id) ?? 0n)
      : 0n
  })

  const rolledOver = toBigInt(lastDistribution?.rolledOverPiconeros)
  return {
    poolPiconeros: inflow.rewardsPiconeros + rolledOver,
    rewardsInflowPiconeros: inflow.rewardsPiconeros,
    totalInflowPiconeros: inflow.totalPiconeros,
    pendingSweepPiconeros: opsRolledOver + inflow.opsPiconeros,
    rolledOverPiconeros: rolledOver,
    totalNetworkFeesPiconeros: ledger.totalNetworkFeesPiconeros,
    outstandingRewardsPiconeros: ledger.outstandingRewardsPiconeros,
    accountingUncertain: ledger.accountingUncertain,
    ledgerFingerprint: ledger.fingerprint,
    time: inflow.raw.time,
    sources: inflow.sources
  }
}
