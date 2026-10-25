import { gql } from 'graphql-tag'

// StasherNews transparency surface: the public rewardsWalletInfo query (spec
// §4.4, §6.4, §7.3). Exposes the platform rewards wallet address, its public
// view key (embedded in the address; cannot decode transaction amounts), and
// the ledger-derived received/principal/network-fee split with the LITERAL
// rewards/ops allocations (next distribution pool / signed pending ops sweep).
// No auth — this is a public-good transparency query. No wallet or lws client
// is ever consulted: every figure is a database-ledger fact.
//
// All monetary fields are BigInt piconeros (1e-12 XMR); balanceXmr is the same
// balance rendered as a decimal XMR string for direct display.

export default gql`
  extend type Query {
    rewardsWalletInfo: RewardsWalletInfo!
    rewardDistributions(limit: Int): [RewardDistribution!]!
  }

  type RewardsWalletInfo {
    address: String!
    # The wallet's public view key (embedded in the address; cannot decode
    # transaction amounts). Never the private view key.
    viewKey: String!
    network: String!
    # All-time CONFIRMED eligible receipts through the ONE shared inflow reader
    # (FeeObservation walletReceipt=true; funding-time accruals are not cash).
    totalReceivedPiconeros: BigInt!
    # EXTERNAL PRINCIPAL only: recorded payout + ops-sweep principal plus
    # journal-proven relays, de-duplicated by the factual ledger. Network fees
    # are a separate cost line and are never counted as sent.
    totalSentPiconeros: BigInt!
    # Unique RELAYED hot-wallet transaction fees (actual costs; consolidations
    # included). Every on-chain send debits exactly one fee fact.
    totalNetworkFeesPiconeros: BigInt!
    # received - principal - network fees. A negative balance is a real
    # inconsistency (more left the wallet than arrived) and is never clamped.
    balancePiconeros: BigInt!
    balanceXmr: String!
    # True when the LEDGER-derived balance is negative, when accounting is
    # uncertain (unresolved journal attempts / contradictory facts), or when a
    # published audit reports a positive discrepancy. The individual facts are
    # exposed separately (accountingUncertain, reconciliation*).
    balanceNeedsReconciliation: Boolean!
    # Unresolved journal attempts, contradictory proven facts, or other
    # conditions where the ledger cannot be trusted to be complete. A missing
    # or stale audit is NOT uncertainty by itself.
    accountingUncertain: Boolean!
    # The latest scoped published CHECK/APPLY reconciliation audit, or null
    # before any check has been published.
    reconciliationCheckedAt: Date
    # True only when that latest audit's safe ledger fingerprint still matches
    # the current ledger. A stale check cannot clear a known discrepancy; it
    # does not by itself imply an unknown relay.
    reconciliationEvidenceCurrent: Boolean!
    # Allocated full rewards not yet delivered: older QUEUED / unreconciled
    # FAILED payout rows whose relay is not proven. Never sweepable ops cash.
    outstandingRewardsPiconeros: BigInt!
    # Unfunded ops debt: max(0, -pendingSweepPiconeros). Hot-wallet network
    # costs and sweeps can exceed the ops earmark; the deficit is explicit debt
    # owed by ops, never hidden and never clamped to zero in the carry.
    opsDeficitPiconeros: BigInt!
    # Literal rewards allocation = the next distribution's pool: this cycle's
    # rewards-earmarked CONFIRMED inflow + the latest distribution's rollover.
    # Identical to the /rewards pool total (one shared computation) — NOT a
    # pro-rata slice of the balance.
    nextPoolPiconeros: BigInt!
    # Literal ops allocation = funds awaiting the ops sweep: the latest
    # distribution's fee-adjusted unswept carry (opsAvailable - proven swept -
    # network costs past its checkpoint) plus this cycle's ops-earmarked inflow.
    # SIGNED: a negative value is unfunded ops debt (opsDeficitPiconeros is its
    # absolute value). Matches the monero_ops_pending_piconeros metric.
    pendingSweepPiconeros: BigInt!
    # Deprecated aliases of nextPoolPiconeros / pendingSweepPiconeros, kept so
    # existing clients' queries keep validating. The old pro-rata semantics
    # (tracking the all-time inflow mix rather than the actual allocation) were
    # misleading; these now return the literal values.
    rewardsEarmarkPiconeros: BigInt! @deprecated(reason: "Use nextPoolPiconeros — the value is now the literal allocation, not a pro-rata slice.")
    opsEarmarkPiconeros: BigInt! @deprecated(reason: "Use pendingSweepPiconeros — the value is now the literal allocation, not a pro-rata slice.")
    inflowBreakdown: RewardsInflowBreakdown!
  }

  # All-time CONFIRMED eligible inflow by source through the shared reader,
  # plus the allocation % applied to each source (the exact split the pool uses).
  type RewardsInflowBreakdown {
    downvotePiconeros: BigInt!
    postingFeePiconeros: BigInt!
    territoryFeePiconeros: BigInt!
    walletlessTipPiconeros: BigInt!
    totalPiconeros: BigInt!
    rewardsPiconeros: BigInt!
    opsPiconeros: BigInt!
    downvoteRewardsPct: Int!
    postingFeeRewardsPct: Int!
    territoryFeeRewardsPct: Int!
    walletlessTipRewardsPct: Int!
  }

  # A weekly rewards distribution run (spec §5, §6.2). Each distribution records
  # the pool total, the amount distributed to curators, the rollover, and its
  # individual RewardPayout rows with real on-chain tx hashes. The ops-sweep
  # fields expose what happened to the ops earmark's share this period: it is
  # swept to the ops wallet when the hot wallet has enough unlocked change,
  # otherwise it is deferred (SKIPPED_LOCKED) and rolls into next period's
  # opsAvailable.
  type RewardDistribution {
    id: Int!
    periodStart: Date!
    periodEnd: Date!
    poolPiconeros: BigInt!
    distributedPiconeros: BigInt!
    rolledOverPiconeros: BigInt!
    payoutCount: Int!
    status: String!
    startedAt: Date
    completedAt: Date
    opsInflowPiconeros: BigInt!
    opsAvailablePiconeros: BigInt!
    opsSweptPiconeros: BigInt!
    # Cumulative RELAYED hot-wallet network cost already included in this row's
    # opsAvailablePiconeros checkpoint. Every later fee (Fnow - this) debits the
    # active carry exactly once.
    opsNetworkFeesAccountedPiconeros: BigInt!
    # This row's carry corrected with the factual ledger: opsAvailable - proven
    # swept principal - network costs incurred IN ITS OWN WINDOW (through the
    # next distribution's fee checkpoint; the active/latest row uses today's
    # cumulative total). Historical rows are ADJUSTED SNAPSHOTS of their own
    # carry, not a second current-ops allocation (only the latest is current).
    correctedPendingOpsPiconeros: BigInt!
    opsSweepTxHash: String
    opsSweepState: String!
    # Dynamic curator budget record (spec §6). Nullable because pre-feature
    # rows and backfilled history may not have these figures. Every tip stage
    # is a TOTAL; no tipper identity or config exclusion ID is exposed here.
    rawTipPiconeros: BigInt
    trustedTipPiconeros: BigInt
    tipperCount: Int
    breakerTripped: Boolean
    breakerRawTPiconeros: BigInt
    makeupPiconeros: BigInt
    incomePiconeros: BigInt
    tipT4Piconeros: BigInt
    incomeF4Piconeros: BigInt
    # This run's drawdown reserve and spending limit (spec §3.1). NULL on
    # pre-feature rows and backfilled history: no dynamic budget ran, so no
    # limit is invented.
    reservePiconeros: BigInt
    spendLimitPiconeros: BigInt
    multBps: Int
    dynamicBudgetPiconeros: BigInt
    dynamicBudgetMode: String
    curatorBudgetMode: String
    appliedCuratorBudgetPiconeros: BigInt
    eligibleTipStages: JSONObject
    payouts: [RewardPayout!]!
  }

  # A single curator payout within a distribution. curatorNym is the user's
  # display name (or null if anonymous); amountXmr is the piconeros rendered as
  # a decimal XMR string for direct display.
  #
  # NOTE: recipientAddress is deliberately NOT exposed here. The
  # rewardDistributions query is unauthenticated (transparency-by-design), and
  # exposing the payout address would link a curator's nym to their Monero
  # address — a linkage the Monero blockchain itself hides. The resolver may
  # still spread the column through; an undeclared field is invisible to
  # GraphQL clients.
  type RewardPayout {
    id: Int!
    curatorId: Int!
    curatorNym: String
    piconeros: BigInt!
    amountXmr: String!
    txHash: String
    state: String!
  }
`
