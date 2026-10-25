// Dynamic curator budget orchestrator (spec
// 2026-10-19-dynamic-curator-budget-design.md §3–§6).
//
// This module composes the pure math (lib/curatorBudget.js) with the eligible
// tip volume SQL (worker/eligibleTipVolume.js) and the recorded weekly history,
// and returns the exact RewardDistribution fields to persist. It is called by
// worker/rewardsDistributor.js INSIDE the weekly serializable transaction and
// inside a SAVEPOINT, so a planning failure can never abort the ledger write.
//
// Every monetary value is BigInt piconeros. JSON snapshots (eligibleTipStages,
// curatorBudgetParams) contain only strings, numbers and booleans: BigInts are
// serialized as decimal strings.

import {
  applySpikeBreaker,
  computeCuratorBudget,
  makeupPiconeros as computeMakeupPiconeros,
  resolveCuratorBudgetConfig
} from '@/lib/curatorBudget'
import { readRewardsInflow } from '@/api/monero/rewardsInflow'
import { readNextRewardsPool } from '@/lib/rewardsPool'
import { CURATOR_FALLBACK_CAP_PICONEROS } from '@/lib/rewardsAccounting'
import { effectiveTrustWeightFloor, resolveExcludedCuratorIds } from './curatorShares'
import { computeEligibleTipVolume } from './eligibleTipVolume'

export const CURATOR_BUDGET_BACKFILL_VERSION = 'backfill-curator-budget-history/v1'

// Twelve T queries plus their inflow readers run inside one Serializable
// transaction; 60 s leaves generous headroom over the measured dev-box time.
export const CURATOR_BUDGET_BACKFILL_TRANSACTION_TIMEOUT_MS = 60000

const HISTORY_FIELDS = {
  id: true,
  trustedTipPiconeros: true,
  incomePiconeros: true,
  breakerTripped: true,
  breakerRawTPiconeros: true,
  breakerMakeupApproved: true,
  multBps: true,
  reservePiconeros: true,
  spendLimitPiconeros: true,
  curatorBudgetMode: true
}

const HISTORY_ORDER = [{ periodEnd: 'desc' }, { id: 'desc' }]

// The persisted/API representation of the effective multiple: the Prisma
// `RewardDistribution.multBps` column is int4 (prisma/schema.prisma) and both
// GraphQL `multBps` fields are `Int` (api/typeDefs/rewards.js,
// api/typeDefs/rewardsWallet.js) — the signed 32-bit range, exactly.
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

// Whole-branch review I1 / controller ruling: the planned EFFECTIVE multiple
// (budget × 10000 ÷ T4) is the recorded and GraphQL-exposed value. With a tiny
// positive T4 plus an approved make-up it is no longer bounded by the
// configured k and can exceed int4 — and eventually Number's exact-integer
// range — so the run must fail safe INSIDE planning instead of aborting on the
// record write. The value is never clamped, rounded or dropped: an
// unrecordable multiple is a dynamic-budget calculation failure, and the
// documented fallback path pays min(pool, 0.2 XMR) and alerts CRITICAL after
// commit (the live projection serves its safe fallback the same way).
export class CuratorBudgetOverflowError extends Error {
  constructor (multBps) {
    // Code-owned diagnostic text only: no user input can enter this message.
    super(`effective multBps ${String(multBps)} cannot be recorded exactly (int4/GraphQL Int range ${INT32_MIN}..${INT32_MAX})`)
    this.name = 'CuratorBudgetOverflowError'
  }
}

// The recorded/exposed value must be exactly representable by int4 and
// GraphQL Int; a Number outside the safe-integer range could not round-trip
// either. NULL (T4 = 0) is recorded as-is.
export function assertRecordableMultBps (multBps) {
  if (multBps == null) return
  if (!Number.isSafeInteger(multBps) || multBps < INT32_MIN || multBps > INT32_MAX) {
    throw new CuratorBudgetOverflowError(multBps)
  }
}

const toBigInt = value => (value == null ? 0n : BigInt(value))

const minBigInt = (a, b) => (a < b ? a : b)

// Curator trust weighting (#6): config floor + staleness fail-safe. Weighting
// keys off the nightly trust walk's DEDICATED heartbeat
// (HealthSnapshot.trustCompletedAt, written only after a fully-successful run).
// max(UserSubTrust.updated_at) was rejected: territory create/unarchive also
// write fresh rows, so a territory event inside the window would mask a broken
// walk. Heartbeat missing/stale (> TRUST_STALENESS_MS) or trust table empty =>
// force 1.0 (weighting disabled) so a broken walk can never slash payouts.
// Shared by the distributor and the live projection so their rules cannot drift.
export async function readTrustWeighting (tx, config) {
  const configTrustFloor = config?.curatorTrustWeightFloor ?? 1.0
  const heartbeat = await tx.healthSnapshot.findUnique({
    where: { id: 1 },
    select: { trustCompletedAt: true }
  })
  const trustRows = await tx.userSubTrust.count()
  const trustWeightFloor = trustRows > 0
    ? effectiveTrustWeightFloor(configTrustFloor, heartbeat?.trustCompletedAt ?? null)
    : 1.0

  return {
    trustWeightFloor,
    trustStale: configTrustFloor < 1.0 && trustWeightFloor !== configTrustFloor
  }
}

// Pool income F (spec §3.1): the rewards earmark excluding donations. A
// donation's rewards share is exactly `raw.donate` (allocateInflow), so it
// raises the pool but never the weekly run rate. Floors at zero.
export function incomeFromInflow (inflow) {
  const rewards = inflow?.rewardsPiconeros == null ? 0n : BigInt(inflow.rewardsPiconeros)
  const donations = inflow?.raw?.donate == null ? 0n : BigInt(inflow.raw.donate)
  const income = rewards - donations
  return income > 0n ? income : 0n
}

// The T history retained by every consumer must cover all three uses: the
// averaging window, the breaker's median floor, and the number of recorded
// periods the breaker needs before it arms. Truncating to only the first two
// silently disarmed a valid `breakerArmPeriods > max(avgPeriods,
// breakerFloorMedianPeriods)` configuration (whole-branch review I1). F stays
// independently bounded by its averaging requirement.
export function curatorBudgetHistoryLimit (params) {
  return Math.max(
    params.avgPeriods,
    params.breakerFloorMedianPeriods,
    params.breakerArmPeriods
  )
}

// Prior distributions with a recorded T, newest first. `limit` must be at least
// curatorBudgetHistoryLimit(params) so the breaker can arm.
export async function readCuratorBudgetHistory (tx, { limit }) {
  return await tx.rewardDistribution.findMany({
    where: { trustedTipPiconeros: { not: null } },
    orderBy: HISTORY_ORDER,
    take: limit,
    select: HISTORY_FIELDS
  })
}

// Prior distributions with a recorded F, newest first. This is an INDEPENDENT
// query: legacy rows may have one recording but not the other, and F must never
// be derived from the T-filtered window.
export async function readCuratorBudgetIncomeHistory (tx, { limit }) {
  if (limit <= 0) return []
  return await tx.rewardDistribution.findMany({
    where: { incomePiconeros: { not: null } },
    orderBy: HISTORY_ORDER,
    take: limit,
    select: HISTORY_FIELDS
  })
}

// The CURRENT configuration verdict (PlatformFeeConfig id 1), validated by the
// pure rules. Read-only on purpose: the make-up approval tool sizes its
// configured-k estimate from this and must refuse without writing when the row
// is missing or invalid, so it cannot use the backfill's self-healing upsert.
export async function readCuratorBudgetConfig (tx) {
  const config = await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
  return resolveCuratorBudgetConfig(config)
}

/**
 * Plan one week's dynamic curator budget.
 *
 * @returns {Promise<{
 *   record: object,
 *   appliedCuratorBudgetPiconeros: bigint,
 *   breaker: object|null,
 *   configErrors: string[],
 *   fallbackError?: Error
 * }>}
 */
export async function planCuratorBudget (tx, {
  periodStart,
  periodEnd,
  poolPiconeros,
  incomePiconeros,
  config,
  excludedCuratorIds,
  trustWeightFloor,
  trustStale = false,
  previousDistribution = null,
  fallbackCapPiconeros = CURATOR_FALLBACK_CAP_PICONEROS
}) {
  const resolved = resolveCuratorBudgetConfig(config)
  const pool = toBigInt(poolPiconeros)
  const income = toBigInt(incomePiconeros)
  const fallback = toBigInt(fallbackCapPiconeros)

  // Invalid configuration fails closed to LEGACY and the fallback cap. The
  // record is deliberately minimal: no fabricated T/F/budget figures.
  if (!resolved.ok) {
    const applied = minBigInt(pool, fallback)
    return {
      record: {
        curatorBudgetMode: 'LEGACY',
        appliedCuratorBudgetPiconeros: applied,
        curatorBudgetParams: {
          errors: resolved.errors,
          configured: resolved.params
        }
      },
      appliedCuratorBudgetPiconeros: applied,
      breaker: null,
      configErrors: resolved.errors
    }
  }

  const { params, mode } = resolved
  const history = await readCuratorBudgetHistory(tx, {
    limit: curatorBudgetHistoryLimit(params)
  })
  const incomeHistory = await readCuratorBudgetIncomeHistory(tx, {
    limit: params.avgPeriods - 1
  })

  // Stale trust only matters while weighting is on. With a recorded previous T,
  // reuse it as this week's T (spec §4 step 8) while still computing the
  // stages at floor 1.0 so the record stays informative. With no recorded T,
  // the effective floor has already been forced to 1.0 by the distributor.
  const previousT = history[0]?.trustedTipPiconeros
  const staleTrustFallback = Boolean(trustStale && previousT != null)
  const volume = await computeEligibleTipVolume(tx, {
    periodStart,
    periodEnd,
    trustWeightFloor: staleTrustFallback ? 1.0 : trustWeightFloor,
    excludedCuratorIds,
    capShareBps: params.capShareBps
  })

  const tipBeforeBreaker = staleTrustFallback ? toBigInt(previousT) : volume.cappedPiconeros
  const breaker = applySpikeBreaker({
    tPiconeros: tipBeforeBreaker,
    priorTs: history.map(row => toBigInt(row.trustedTipPiconeros)),
    params
  })
  const tPiconeros = breaker.tPiconeros

  const tipVolumes = [tPiconeros, ...history.map(row => toBigInt(row.trustedTipPiconeros))]
  const incomeVolumes = [income, ...incomeHistory.map(row => toBigInt(row.incomePiconeros))]

  // Two-step make-up (spec §5): compute the budget first, then add the
  // approved make-up — at the CONFIGURED k, never this run's effective
  // multiple — and recompute. Approval only pays on the immediately following
  // run: a later row means the window closed, and a backfilled approval is
  // never consumed.
  const previousIsLatest = previousDistribution != null &&
    history[0] != null &&
    previousDistribution.id === history[0].id
  const makeupEligible = previousIsLatest &&
    previousDistribution.breakerTripped &&
    previousDistribution.breakerMakeupApproved &&
    previousDistribution.breakerRawTPiconeros != null &&
    previousDistribution.trustedTipPiconeros != null

  let budget = computeCuratorBudget({
    poolPiconeros: pool,
    tipVolumes,
    incomeVolumes,
    params
  })
  let makeup = 0n
  if (makeupEligible) {
    makeup = computeMakeupPiconeros({
      rawTPiconeros: toBigInt(previousDistribution.breakerRawTPiconeros),
      capTPiconeros: toBigInt(previousDistribution.trustedTipPiconeros),
      multBps: params.multBps
    })
    if (makeup > 0n) {
      budget = computeCuratorBudget({
        poolPiconeros: pool,
        tipVolumes,
        incomeVolumes,
        makeupPiconeros: makeup,
        params
      })
    }
  }

  // Review I1: validate the planned effective multiple (the value `record`
  // persists and GraphQL exposes) here, inside the protected planning
  // savepoint. Serialization errors never look like this — the dedicated typed
  // error carries no SQLSTATE — so the distributor's catch pays the fallback
  // while genuine serialization conflicts still escape for retry.
  assertRecordableMultBps(budget.multBps)

  // LEGACY and SHADOW record the dynamic calculation but pay the fallback cap;
  // ACTIVE pays the calculated budget. Both are additionally bounded by the pool
  // inside computeCuratorBudget.
  const applied = mode === 'ACTIVE' ? budget.budgetPiconeros : minBigInt(pool, fallback)

  const record = {
    rawTipPiconeros: volume.rawPiconeros,
    eligibleTipStages: {
      ...volume.stages,
      final: tPiconeros.toString(),
      staleTrustFallback,
      breakerThreshold: breaker.thresholdPiconeros.toString(),
      breakerArmed: breaker.armed
    },
    trustedTipPiconeros: tPiconeros,
    tipperCount: volume.tipperCount,
    breakerTripped: breaker.tripped,
    breakerRawTPiconeros: breaker.rawTPiconeros,
    // This row's own trip has not been approved yet; a make-up approved on the
    // PREVIOUS row is what `makeupPiconeros` records here.
    breakerMakeupApproved: false,
    makeupPiconeros: makeup,
    incomePiconeros: income,
    tipT4Piconeros: budget.t4Piconeros,
    incomeF4Piconeros: budget.f4Piconeros,
    reservePiconeros: budget.reservePiconeros,
    spendLimitPiconeros: budget.limitPiconeros,
    multBps: budget.multBps,
    dynamicBudgetPiconeros: budget.budgetPiconeros,
    dynamicBudgetMode: budget.outcome,
    curatorBudgetMode: mode,
    appliedCuratorBudgetPiconeros: applied,
    curatorBudgetParams: {
      ...params,
      mode,
      trustWeightFloor,
      trustStale,
      historyIds: history.map(row => row.id)
    }
  }

  return {
    record,
    appliedCuratorBudgetPiconeros: applied,
    breaker,
    configErrors: []
  }
}

// --- History backfill (spec §9.1) -----------------------------------------

const optionalBigInt = value => (value == null ? null : BigInt(value))

function sortHistoryDesc (rows) {
  return [...rows].sort((a, b) => {
    const byPeriod = b.periodEnd.getTime() - a.periodEnd.getTime()
    return byPeriod !== 0 ? byPeriod : b.id - a.id
  })
}

function backfillStages (volume, breaker) {
  return {
    ...volume.stages,
    final: breaker.tPiconeros.toString(),
    staleTrustFallback: false,
    breakerThreshold: breaker.thresholdPiconeros.toString(),
    breakerArmed: breaker.armed,
    backfilled: true
  }
}

function skippedRowSummary (row, priorTCount) {
  const stages = row.eligibleTipStages ?? null
  return {
    id: row.id,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    skipped: true,
    wrote: false,
    rawPiconeros: row.rawTipPiconeros,
    stages,
    tipperCount: row.tipperCount,
    finalTPiconeros: row.trustedTipPiconeros,
    breakerRawTPiconeros: row.breakerRawTPiconeros,
    breaker: {
      armed: stages?.breakerArmed === true,
      tripped: row.breakerTripped,
      thresholdPiconeros: optionalBigInt(stages?.breakerThreshold),
      rawTPiconeros: row.breakerRawTPiconeros
    },
    earmarkPiconeros: null,
    donationsPiconeros: null,
    incomePiconeros: row.incomePiconeros,
    readerRewardsPiconeros: null,
    readerEarmarkMismatch: null,
    previousDistributionId: null,
    priorTCount
  }
}

// The distributor's predecessor is the latest row by periodEnd. The explicit id
// tiebreak keeps same-period rows deterministic without changing normal data.
async function readBackfillPredecessor (tx, row) {
  return await tx.rewardDistribution.findFirst({
    where: {
      OR: [
        { periodEnd: { lt: row.periodEnd } },
        { periodEnd: row.periodEnd, id: { lt: row.id } }
      ]
    },
    orderBy: HISTORY_ORDER,
    select: { id: true, periodEnd: true, rolledOverPiconeros: true }
  })
}

async function backfillOneRow (tx, {
  row,
  priorTs,
  config,
  params,
  excludedCuratorIds,
  capShareBps,
  at,
  dryRun
}) {
  const volume = await computeEligibleTipVolume(tx, {
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    trustWeightFloor: 1.0,
    excludedCuratorIds,
    capShareBps
  })
  const breaker = applySpikeBreaker({
    tPiconeros: volume.cappedPiconeros,
    priorTs,
    params
  })
  const predecessor = await readBackfillPredecessor(tx, row)
  const inflow = await readRewardsInflow(tx, {
    start: row.periodStart,
    end: row.periodEnd,
    config
  })
  // The earmark the distributor actually used, independent of today's
  // allocation splits. The whole pool for the very first distribution.
  const earmark = predecessor == null
    ? row.poolPiconeros
    : row.poolPiconeros - predecessor.rolledOverPiconeros
  const donations = inflow.raw.donate
  const afterDonations = earmark - donations
  const income = afterDonations > 0n ? afterDonations : 0n
  const stages = backfillStages(volume, breaker)
  const backfillParams = {
    backfilled: true,
    at,
    trustWeightFloor: 1.0,
    capShareBps,
    excludedCuratorIds,
    scriptVersion: CURATOR_BUDGET_BACKFILL_VERSION
  }

  let wrote = false
  if (!dryRun) {
    // Every write is guarded on the row still being unfilled, and exactly one
    // row must change or the whole (Serializable) transaction aborts.
    const changed = await tx.rewardDistribution.updateMany({
      where: { id: row.id, trustedTipPiconeros: null },
      data: {
        rawTipPiconeros: volume.rawPiconeros,
        eligibleTipStages: stages,
        trustedTipPiconeros: breaker.tPiconeros,
        tipperCount: volume.tipperCount,
        breakerTripped: breaker.tripped,
        breakerRawTPiconeros: breaker.rawTPiconeros,
        incomePiconeros: income,
        curatorBudgetParams: backfillParams
      }
    })
    if (changed.count !== 1) {
      throw new Error(`curator budget backfill: guarded update changed ${changed.count} rows for distribution ${row.id}`)
    }
    wrote = true
  }

  return {
    summary: {
      id: row.id,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      status: row.status,
      skipped: false,
      wrote,
      rawPiconeros: volume.rawPiconeros,
      stages,
      tipperCount: volume.tipperCount,
      finalTPiconeros: breaker.tPiconeros,
      breakerRawTPiconeros: breaker.rawTPiconeros,
      breaker: {
        armed: breaker.armed,
        tripped: breaker.tripped,
        thresholdPiconeros: breaker.thresholdPiconeros,
        rawTPiconeros: breaker.rawTPiconeros
      },
      earmarkPiconeros: earmark,
      donationsPiconeros: donations,
      incomePiconeros: income,
      readerRewardsPiconeros: inflow.rewardsPiconeros,
      readerEarmarkMismatch: inflow.rewardsPiconeros !== earmark,
      previousDistributionId: predecessor?.id ?? null,
      priorTCount: priorTs.length
    },
    priorTs: [breaker.tPiconeros, ...priorTs]
  }
}

async function deriveFirstRunInputs (tx, {
  config,
  selected,
  summaries,
  earlierT,
  earlierF,
  excludedCuratorIds,
  capShareBps,
  params
}) {
  const selectedT = new Map(summaries.map(row => [row.id, row.finalTPiconeros]))
  const selectedF = new Map(summaries.map(row => [row.id, row.incomePiconeros]))
  const tRows = sortHistoryDesc([
    ...selected.map(row => ({ id: row.id, periodEnd: row.periodEnd, piconeros: selectedT.get(row.id) })),
    ...earlierT.map(row => ({ id: row.id, periodEnd: row.periodEnd, piconeros: row.trustedTipPiconeros }))
  ].filter(row => row.piconeros != null))
  const fRows = sortHistoryDesc([
    ...selected.map(row => ({ id: row.id, periodEnd: row.periodEnd, piconeros: selectedF.get(row.id) })),
    ...earlierF.map(row => ({ id: row.id, periodEnd: row.periodEnd, piconeros: row.incomePiconeros }))
  ].filter(row => row.piconeros != null))

  const tHistory = tRows.slice(0, curatorBudgetHistoryLimit(params))
  const fHistory = fRows.slice(0, Math.max(params.avgPeriods - 1, 0))
  const priorTs = tHistory.map(row => row.piconeros)
  const latest = tRows[0] ?? null
  const now = new Date()
  const openStart = latest?.periodEnd ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const { trustWeightFloor, trustStale } = await readTrustWeighting(tx, config)
  const previousT = priorTs[0] ?? null
  const staleTrustFallback = Boolean(trustStale && previousT != null)
  const openVolume = await computeEligibleTipVolume(tx, {
    periodStart: openStart,
    periodEnd: now,
    trustWeightFloor: staleTrustFallback ? 1.0 : trustWeightFloor,
    excludedCuratorIds,
    capShareBps
  })
  const openT = staleTrustFallback ? previousT : openVolume.cappedPiconeros
  const openBreaker = applySpikeBreaker({
    tPiconeros: openT,
    priorTs,
    params
  })
  // Independent F read, exactly like the live planner: donations are removed,
  // and F never comes from the T-filtered history.
  const openInflow = await readRewardsInflow(tx, { start: openStart, config })
  const openIncome = incomeFromInflow(openInflow)
  const pool = await readNextRewardsPool(tx, config)
  const budget = computeCuratorBudget({
    poolPiconeros: pool.poolPiconeros,
    tipVolumes: [openBreaker.tPiconeros, ...priorTs],
    incomeVolumes: [openIncome, ...fHistory.map(row => row.piconeros)],
    params
  })

  return {
    tHistory,
    fHistory,
    currentPool: pool,
    openPeriod: {
      periodStart: openStart,
      periodEnd: now,
      trustWeightFloor,
      trustStale,
      staleTrustFallback,
      rawPiconeros: openVolume.rawPiconeros,
      stages: openVolume.stages,
      finalTPiconeros: openBreaker.tPiconeros,
      breaker: {
        armed: openBreaker.armed,
        tripped: openBreaker.tripped,
        thresholdPiconeros: openBreaker.thresholdPiconeros,
        rawTPiconeros: openBreaker.rawTPiconeros
      },
      incomePiconeros: openIncome,
      budget
    }
  }
}

/**
 * Fill the dynamic budget history fields on the most recent distributions.
 *
 * MUST run inside one Serializable transaction supplied by the caller. Rows are
 * ordered oldest first so the breaker sees only the history a live run would
 * have seen. A filled newer row above a NULL older row is refused before any
 * write: filling the gap would change a series the live runs already recorded.
 *
 * @param {object} tx - Prisma transaction client (Serializable).
 * @param {{ periods?: number, dryRun?: boolean }} options
 */
export async function backfillCuratorBudgetHistory (tx, { periods, dryRun = true } = {}) {
  // A dry run must not write anything, including seeding the config
  // singleton: read it without creating and refuse when it is absent.
  const config = dryRun
    ? await tx.platformFeeConfig.findUnique({ where: { id: 1 } })
    : await tx.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  if (!config) {
    throw new Error('curator budget backfill: dry run found no PlatformFeeConfig singleton (a real run would create it)')
  }
  const resolved = resolveCuratorBudgetConfig(config)
  if (!resolved.ok) {
    throw new Error(`curator budget backfill: invalid config: ${resolved.errors.join(', ')}`)
  }
  const { params } = resolved
  const periodCount = periods ?? params.breakerFloorMedianPeriods
  if (!Number.isSafeInteger(periodCount) || periodCount <= 0) {
    throw new Error(`curator budget backfill: periods must be a positive integer, got ${periodCount}`)
  }
  const at = new Date().toISOString()
  const excludedCuratorIds = resolveExcludedCuratorIds(config.distributionExcludedCuratorIds)
  const capShareBps = params.capShareBps

  const selectedDesc = await tx.rewardDistribution.findMany({
    orderBy: HISTORY_ORDER,
    take: periodCount
  })
  const selected = [...selectedDesc].reverse()
  const selectedIds = selected.map(row => row.id)

  let nullId = null
  for (const row of selected) {
    if (row.trustedTipPiconeros == null) {
      nullId = row.id
    } else if (nullId != null) {
      return {
        periods: periodCount,
        dryRun,
        at,
        excludedCuratorIds,
        capShareBps,
        refused: 'gap',
        gap: { newerId: row.id, olderId: nullId },
        rows: [],
        tHistory: [],
        fHistory: [],
        currentPool: null,
        openPeriod: null
      }
    }
  }

  const earlierT = await tx.rewardDistribution.findMany({
    where: { trustedTipPiconeros: { not: null }, id: { notIn: selectedIds } },
    orderBy: HISTORY_ORDER,
    take: curatorBudgetHistoryLimit(params),
    select: { id: true, periodEnd: true, trustedTipPiconeros: true }
  })
  const earlierF = await tx.rewardDistribution.findMany({
    where: { incomePiconeros: { not: null }, id: { notIn: selectedIds } },
    orderBy: HISTORY_ORDER,
    take: Math.max(params.avgPeriods - 1, 0),
    select: { id: true, periodEnd: true, incomePiconeros: true }
  })

  const rows = []
  let priorTs = earlierT.map(row => BigInt(row.trustedTipPiconeros))
  for (const row of selected) {
    if (row.trustedTipPiconeros != null) {
      rows.push(skippedRowSummary(row, priorTs.length))
      priorTs = [BigInt(row.trustedTipPiconeros), ...priorTs]
      continue
    }
    const result = await backfillOneRow(tx, {
      row,
      priorTs,
      config,
      params,
      excludedCuratorIds,
      capShareBps,
      at,
      dryRun
    })
    rows.push(result.summary)
    priorTs = result.priorTs
  }

  const derived = await deriveFirstRunInputs(tx, {
    config,
    selected,
    summaries: rows,
    earlierT,
    earlierF,
    excludedCuratorIds,
    capShareBps,
    params
  })

  return {
    periods: periodCount,
    dryRun,
    at,
    excludedCuratorIds,
    capShareBps,
    rows,
    ...derived
  }
}
