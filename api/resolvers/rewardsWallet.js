import { publicViewKeyFromAddress } from '../monero/viewKeyCheck'
import { piconerosToXmrDecimal } from '../monero/uri'
import { readRewardsInflow } from '../monero/rewardsInflow'
import { readRewardsWalletLedger } from '../monero/rewardsLedger'
import { isCurrentAccountingFingerprint } from '@/lib/rewardsAuditFingerprint'
import { sanitizeEligibleTipStages } from '@/lib/curatorBudgetStages'
import { readNextRewardsPool } from '@/lib/rewardsPool'
import { opsCarry, walletScope } from '@/lib/rewardsAccounting'
import { GqlInputError } from '@/lib/error'

// StasherNews public transparency surface for the platform rewards wallet
// (spec §4.4, §6.4, §7.3). The rewards wallet is the ONLY custodial component:
// a single Monero hot wallet (MoneroAccount { label: 'platform_rewards' }) that
// receives all platform-bound revenue (downvotes, posting fees, territory fees).
//
// This resolver exposes — publicly, no auth — the wallet address, its PUBLIC
// view key (address-embedded; derived from the address itself, never the
// stored/encrypted private key), and a truthful split of the wallet ledger:
//   - received = all-time CONFIRMED eligible receipts through the ONE shared
//     inflow reader (walletReceipt=true; funding-time accruals are not cash),
//   - sent     = EXTERNAL PRINCIPAL ONLY: recorded payout + ops-sweep
//     principal plus journal-proven relays, de-duplicated by the shared factual
//     ledger (api/monero/rewardsLedger.js). Network fees are never principal,
//   - fees     = unique RELAYED hot-wallet transaction costs (actual costs,
//     consolidations included),
//   - balance  = received - principal - network fees. A negative balance is
//     real debt and is never clamped,
//   - rewards  = the full rewards pool, including future weeks (the computation /rewards
//     uses), ops = the SIGNED fee-adjusted pending sweep. A negative ops figure
//     is an unfunded debt (hot-wallet costs and sweeps exceeded the ops
//     earmark), surfaced separately as opsDeficitPiconeros.
//
// accountingUncertain reflects unresolved journal attempts or contradictory
// ledger facts — never merely absent/stale audit evidence. The latest scoped
// published reconciliation audit is reported separately: reconciliationCheckedAt
// (nullable) and reconciliationEvidenceCurrent (the stored fingerprint is the
// current `accounting:v2:` snapshot digest; legacy stored hashes are stale by
// definition). A stored positive discrepancy keeps
// warning until a newer complete check clears it; a stale clean audit cannot.
//
// IMPORTANT: all money comes from the DATABASE LEDGER, NOT from lws's
// get_address_info. lws's total_sent/spent_outputs are unreliable for this
// account: lws attributes OTHER wallets' on-chain spends to it (observed:
// 33 foreign txs shown as 37e9 piconeros sent from a wallet whose full-key scan
// proves it never sent anything; lws's account-wide spent tracking includes
// fee-pool subaddress spends that were never backfilled into total_received).
// The ledger is the platform's own record: every piconero in is a CONFIRMED
// observation, every piconero out is a recorded or journal-proven payout/sweep.
// No wallet or lws client is ever opened here: every read runs in ONE
// Serializable database snapshot.

export default {
  Query: {
    async rewardsWalletInfo (parent, args, { models }) {
      const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
      return await models.$transaction(async tx => {
        const account = await tx.moneroAccount.findFirst({
          where: { label: 'platform_rewards', network }
        })
        if (!account) throw new GqlInputError('rewards wallet not registered')

        const config = await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
        if (!config) throw new GqlInputError('fee config not initialized')

        const scope = walletScope()

        // ONE consistent Serializable snapshot: the all-time receipt reader,
        // the factual ledger, the pool reader and the latest published audit
        // all see the exact same rows.
        const inflow = await readRewardsInflow(tx, { start: new Date(0), end: null, config })
        const ledger = await readRewardsWalletLedger(tx, { scope })
        const pool = await readNextRewardsPool(tx, config)
        const latestAudit = await tx.rewardsWalletReconciliation.findFirst({
          where: { network: scope.network, walletAddress: scope.walletAddress },
          orderBy: { checkedAt: 'desc' },
          select: { checkedAt: true, ledgerFingerprint: true }
        })

        // Principal and actual network costs are separate facts: both left the
        // wallet, so the balance debits both. Fees are never counted as sent.
        const balance = inflow.totalPiconeros - ledger.totalSentPiconeros - ledger.totalNetworkFeesPiconeros
        // A negative balance is a real inconsistency; accountingUncertain
        // covers unresolved/contradictory journals; positiveDriftPiconeros is
        // a published audit's stored discrepancy. Any of them refuses a clean
        // "verified" reading.
        const balanceNeedsReconciliation = balance < 0n ||
          ledger.accountingUncertain || ledger.positiveDriftPiconeros > 0n
        // Unfunded ops debt: the fee-adjusted ops carry goes negative when
        // hot-wallet costs and sweeps exceed the ops earmark. It is debt owed
        // by ops — never free cash, never hidden, never clamped.
        const opsDeficitPiconeros = pool.pendingSweepPiconeros < 0n ? -pool.pendingSweepPiconeros : 0n
        // Freshness is separate from uncertainty: a published check is current
        // evidence only when its stored fingerprint is EXACTLY the current
        // `accounting:v2:` snapshot digest (strict versioned comparison). A
        // legacy stored hash, a v1 string or a changed audited input is stale
        // and cannot clear a known discrepancy. Before any check, checkedAt is
        // null and current is false — that absence is NOT itself accounting
        // uncertainty.
        const reconciliationEvidenceCurrent = latestAudit != null &&
          isCurrentAccountingFingerprint(latestAudit.ledgerFingerprint, ledger.fingerprint)

        return {
          address: account.address,
          viewKey: publicViewKeyFromAddress(account.address),
          network,
          totalReceivedPiconeros: inflow.totalPiconeros,
          totalSentPiconeros: ledger.totalSentPiconeros,
          totalNetworkFeesPiconeros: ledger.totalNetworkFeesPiconeros,
          balancePiconeros: balance,
          balanceXmr: piconerosToXmrDecimal(balance),
          balanceNeedsReconciliation,
          accountingUncertain: ledger.accountingUncertain,
          reconciliationCheckedAt: latestAudit?.checkedAt ?? null,
          reconciliationEvidenceCurrent,
          outstandingRewardsPiconeros: ledger.outstandingRewardsPiconeros,
          opsDeficitPiconeros,
          // Literal current allocations (never a pro-rata slice of the
          // balance): rewards = the full pool, not the capped curator budget (same value
          // /rewards shows), ops = the signed fee-adjusted pending sweep.
          rewardsEarmarkPiconeros: pool.poolPiconeros,
          opsEarmarkPiconeros: pool.pendingSweepPiconeros,
          nextPoolPiconeros: pool.poolPiconeros,
          pendingSweepPiconeros: pool.pendingSweepPiconeros,
          // Cumulative display of where every eligible receipt came from,
          // through the same source reader and allocation split the pool uses.
          inflowBreakdown: {
            downvotePiconeros: inflow.raw.downvote,
            postingFeePiconeros: inflow.raw.posting,
            territoryFeePiconeros: inflow.raw.territory,
            walletlessTipPiconeros: inflow.raw.walletlesstip,
            totalPiconeros: inflow.totalPiconeros,
            rewardsPiconeros: inflow.rewardsPiconeros,
            opsPiconeros: inflow.opsPiconeros,
            downvoteRewardsPct: config.downvoteRewardsPct,
            postingFeeRewardsPct: config.postingFeeRewardsPct,
            territoryFeeRewardsPct: config.territoryFeeRewardsPct,
            walletlessTipRewardsPct: config.walletlessTipRewardsPct
          }
        }
      }, { isolationLevel: 'Serializable', timeout: 10000 })
    },

    // Public distribution log (spec §7.3): recent RewardDistributions with
    // their RewardPayouts, curator nym resolved, and piconeros rendered as XMR
    // decimal for display. correctedPendingOpsPiconeros is the row's carry
    // corrected with the factual ledger. Each historical row's fee adjustment
    // is BOUNDED to its own window — its successor's fee checkpoint (the next
    // distribution by periodEnd, ties by id) minus its own — so later periods'
    // fees can never make a settled row look unfunded; only the active (latest)
    // row sees today's cumulative total. A historical row's carry is an
    // adjusted snapshot of that row — NOT a second current ops allocation.
    // No auth — transparency-by-design.
    async rewardDistributions (parent, { limit = 10 }, { models }) {
      return await models.$transaction(async tx => {
        const ledger = await readRewardsWalletLedger(tx, { scope: walletScope() })
        const distributions = await tx.rewardDistribution.findMany({
          take: Math.min(limit || 10, 50),
          orderBy: { id: 'desc' },
          include: {
            payouts: {
              include: { curator: { select: { name: true } } },
              orderBy: { piconeros: 'desc' }
            }
          }
        })
        // Chronological order resolves each row's successor even though the
        // public list is newest-first (the fetched window is the newest rows,
        // so only the active/latest row lacks a successor here).
        const chronological = [...distributions].sort((a, b) => {
          const byPeriodEnd = a.periodEnd - b.periodEnd
          return byPeriodEnd !== 0 ? byPeriodEnd : a.id - b.id
        })
        const feeHorizonByDistribution = new Map()
        for (let i = 0; i < chronological.length; i++) {
          const successor = chronological[i + 1]
          feeHorizonByDistribution.set(
            chronological[i].id,
            successor
              ? (successor.opsNetworkFeesAccountedPiconeros ?? 0n)
              : ledger.totalNetworkFeesPiconeros
          )
        }
        return distributions.map(d => ({
          ...d,
          // Whitelist the public tip stages: totals and flags only. Never
          // forward arbitrary JSON keys (config exclusion IDs stay private).
          eligibleTipStages: sanitizeEligibleTipStages(d.eligibleTipStages),
          opsNetworkFeesAccountedPiconeros: d.opsNetworkFeesAccountedPiconeros ?? 0n,
          // opsCarry computes opsAvailable - proven swept - (horizon -
          // accounted); passing the bounded horizon keeps the shared formula.
          correctedPendingOpsPiconeros: opsCarry({
            distribution: d,
            totalNetworkFeesPiconeros: feeHorizonByDistribution.get(d.id) ?? ledger.totalNetworkFeesPiconeros,
            provenSweptPiconeros: ledger.sweptByDistribution.get(d.id) ?? 0n
          }),
          payouts: d.payouts.map(p => ({
            ...p,
            curatorNym: p.curator?.name || null,
            amountXmr: piconerosToXmrDecimal(p.piconeros)
          }))
        }))
      }, { isolationLevel: 'Serializable', timeout: 10000 })
    }
  }
}
