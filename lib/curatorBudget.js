// Dynamic weekly curator budget — pure BigInt math (spec
// 2026-10-19-dynamic-curator-budget-design.md §3, §4 step 6, §5, §6).
//
// This module owns config validation, the capped eligible-tip volume level,
// the spike breaker, and the drawdown budget. It creates no Prisma client,
// reads no wallet and imports no logger side effects, so importing it is inert
// and the distributor can call it inside its serializable transaction.
//
// Every monetary value is BigInt piconeros; every division floors. Configuration
// stays Number because it maps to PostgreSQL int4 and is validated as a safe
// integer before use. Invalid configuration fails closed to LEGACY at the
// caller, which pays the fallback cap and raises a CRITICAL alert.

export const CURATOR_BUDGET_MODES = ['LEGACY', 'SHADOW', 'ACTIVE']

// The spending limit pays income plus the reserve's drawdown share, scaled by
// 10000/11000 so the pool also covers the 10% referral commission on the
// budget (decision D3).
const LIMIT_NUM = 10000n
const LIMIT_DEN = 11000n
const BPS_DEN = 10000n

// Drawdown weeks W (spec §6): below 4 the drawdown spends the reserve almost
// as abruptly as the cliff it replaces; above 104 the limit barely tracks the
// reserve at all. Exported so surfaces can tell a copy-safe configured W from
// an out-of-range one without repeating the bounds.
export const DRAWDOWN_WEEKS_MIN = 4
export const DRAWDOWN_WEEKS_MAX = 104

const CONFIG_TO_PARAM = {
  curatorBudgetMultBps: 'multBps',
  curatorBudgetDrawdownWeeks: 'drawdownWeeks',
  curatorBudgetAvgPeriods: 'avgPeriods',
  curatorTipCapShareBps: 'capShareBps',
  curatorBreakerRatioBps: 'breakerRatioBps',
  curatorBreakerFloorMedianPeriods: 'breakerFloorMedianPeriods',
  curatorBreakerArmPeriods: 'breakerArmPeriods'
}

// Validate one PlatformFeeConfig row (spec §6). Numeric values must be safe
// integers; every failed rule contributes a stable error code. `params` is
// returned even on failure so the run can snapshot what was configured, but
// callers must not use it when `ok` is false.
export function resolveCuratorBudgetConfig (config) {
  const row = config ?? {}
  const params = {}
  for (const [field, param] of Object.entries(CONFIG_TO_PARAM)) {
    params[param] = row[field]
  }

  const errors = []
  const mode = row.curatorBudgetMode
  if (!CURATOR_BUDGET_MODES.includes(mode)) errors.push('mode_invalid')

  for (const param of Object.values(CONFIG_TO_PARAM)) {
    if (!Number.isSafeInteger(params[param])) errors.push(`${param}_not_safe_integer`)
  }

  const valid = param => Number.isSafeInteger(params[param])
  if (valid('multBps') && params.multBps < 10000) errors.push('multBps_below_minimum')
  if (valid('drawdownWeeks') &&
      (params.drawdownWeeks < DRAWDOWN_WEEKS_MIN || params.drawdownWeeks > DRAWDOWN_WEEKS_MAX)) {
    errors.push('drawdownWeeks_out_of_range')
  }
  if (valid('capShareBps') && (params.capShareBps <= 0 || params.capShareBps > 10000)) {
    errors.push('capShareBps_out_of_range')
  }
  if (valid('breakerRatioBps') && params.breakerRatioBps <= 10000) {
    errors.push('breakerRatioBps_not_above_baseline')
  }
  if (valid('avgPeriods') && params.avgPeriods < 1) errors.push('avgPeriods_below_one')
  if (valid('breakerFloorMedianPeriods') && params.breakerFloorMedianPeriods < 1) {
    errors.push('breakerFloorMedianPeriods_below_one')
  }
  if (valid('breakerArmPeriods') && params.breakerArmPeriods < 1) {
    errors.push('breakerArmPeriods_below_one')
  }

  return {
    ok: errors.length === 0,
    mode: errors.length === 0 ? mode : 'LEGACY',
    params,
    errors
  }
}

// Floor of the arithmetic mean; an empty history averages to zero.
export function meanPiconeros (values = []) {
  if (values.length === 0) return 0n
  return values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length)
}

// Median of the recorded history: odd length takes the middle, even length
// floors the middle pair's average. Empty history is zero.
export function medianPiconeros (values = []) {
  if (values.length === 0) return 0n
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2n
}

// Find the largest level L with L <= capShare x sum(min(x_i, L)) and return
// T = sum(min(x_i, L)). The closed form accepts the first k with
// L = floor(R_k x share / (10000 - k x share)) >= x_{k+1} (x_{n+1} = 0).
// With k capped tippers the level satisfies L <= s(kL + R_k).
export function capTipperContributions (xs, capShareBps) {
  const share = BigInt(capShareBps)
  const values = xs.filter(value => value > 0n).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const total = values.reduce((sum, value) => sum + value, 0n)
  const count = BigInt(values.length)

  // Fewer than 1/s tippers cannot each stay at or below a share of the total.
  if (count * share < BPS_DEN) return { tPiconeros: 0n, levelPiconeros: 0n }
  // The largest contribution already fits: no trimming is needed.
  if (values[0] * BPS_DEN <= share * total) {
    return { tPiconeros: total, levelPiconeros: values[0] }
  }

  for (let k = 1; BigInt(k) * share < BPS_DEN; k++) {
    const remainder = values.slice(k).reduce((sum, value) => sum + value, 0n)
    const level = remainder * share / (BPS_DEN - BigInt(k) * share)
    const next = k < values.length ? values[k] : 0n
    if (level >= next) {
      return { tPiconeros: BigInt(k) * level + remainder, levelPiconeros: level }
    }
  }

  return { tPiconeros: 0n, levelPiconeros: 0n }
}

// Spike breaker (D8): cap a sudden volume spike at the larger of the prior
// four-period mean and the recorded-period median, scaled by the configured
// ratio. It only arms once enough prior periods exist; the threshold is still
// returned for the run record when it is not armed.
export function applySpikeBreaker ({ tPiconeros, priorTs = [], params }) {
  const recent = priorTs.slice(0, params.avgPeriods)
  const floorPeriods = priorTs.slice(0, params.breakerFloorMedianPeriods)
  const priorT4 = meanPiconeros(recent)
  const floor = medianPiconeros(floorPeriods)
  const base = priorT4 > floor ? priorT4 : floor
  const threshold = base * BigInt(params.breakerRatioBps) / BPS_DEN
  const armed = priorTs.length >= params.breakerArmPeriods
  const tripped = armed && tPiconeros > threshold

  return {
    tPiconeros: tripped ? threshold : tPiconeros,
    tripped,
    armed,
    rawTPiconeros: tPiconeros,
    thresholdPiconeros: threshold
  }
}

// Dynamic budget (spec §3.1): target = k x T4 + make-up, capped by the pool's
// drawdown limit and the pool itself. The limit pays the four-period income
// MEDIAN I4 plus a 1/W share of the reserve (pool - I4), scaled by 10000/11000
// to leave room for referrals. I4 is a median, not a mean, so a one-off income
// spike (e.g. a fee deliberately overpaid as a donation) cannot inflate the
// limit; T4 stays a mean. Once the limit binds, the reserve shrinks
// geometrically and the budget converges on I4 / 1.1. The outcome names the
// binding cap: FULL pays the target, DRAWDOWN the limit, POOL_SHORT the pool.
// The recorded multBps is the EFFECTIVE multiple, budget x 10000 / T4.
export function computeCuratorBudget ({
  poolPiconeros,
  tipVolumes = [],
  incomeVolumes = [],
  makeupPiconeros = 0n,
  params
}) {
  const pool = poolPiconeros < 0n ? 0n : poolPiconeros
  const t4Piconeros = meanPiconeros(tipVolumes.slice(0, params.avgPeriods))
  const f4Piconeros = medianPiconeros(incomeVolumes.slice(0, params.avgPeriods))

  const reservePiconeros = pool > f4Piconeros ? pool - f4Piconeros : 0n
  const limitPiconeros = (f4Piconeros + reservePiconeros / BigInt(params.drawdownWeeks)) *
    LIMIT_NUM / LIMIT_DEN
  const targetPiconeros = t4Piconeros * BigInt(params.multBps) / BPS_DEN + makeupPiconeros

  const cheapest = targetPiconeros < limitPiconeros ? targetPiconeros : limitPiconeros
  const budgetPiconeros = cheapest < pool ? cheapest : pool
  const outcome = pool < cheapest
    ? 'POOL_SHORT'
    : limitPiconeros < targetPiconeros ? 'DRAWDOWN' : 'FULL'
  const multBps = t4Piconeros > 0n
    ? Number(budgetPiconeros * BPS_DEN / t4Piconeros)
    : null

  return {
    budgetPiconeros,
    targetPiconeros,
    limitPiconeros,
    reservePiconeros,
    multBps,
    t4Piconeros,
    f4Piconeros,
    outcome
  }
}

// Approved breaker make-up (spec §5): a quarter of the trimmed volume at the
// configured k, floored. Never negative. The caller passes the configured k —
// never the run's effective multiple — and the make-up binds only through the
// target, never the limit.
export function makeupPiconeros ({ rawTPiconeros, capTPiconeros, multBps }) {
  if (rawTPiconeros <= capTPiconeros) return 0n
  return (rawTPiconeros - capTPiconeros) * BigInt(multBps) / 40000n
}
