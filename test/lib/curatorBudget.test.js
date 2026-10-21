/* eslint-env jest */
import {
  resolveCuratorBudgetConfig,
  meanPiconeros,
  medianPiconeros,
  capTipperContributions,
  applySpikeBreaker,
  computeCuratorBudget,
  makeupPiconeros
} from '@/lib/curatorBudget'

// Money-path tests for the dynamic curator budget (spec
// 2026-10-19-dynamic-curator-budget-design.md §3, §4 step 6, §5, §6).
// Pure BigInt helpers: no DB, no wallet, import inert. Every expected value
// is hand-computed with flooring at each division.

const DEFAULT_CONFIG = {
  curatorBudgetMode: 'LEGACY',
  curatorBudgetMultBps: 15000,
  curatorBudgetDrawdownWeeks: 13,
  curatorBudgetAvgPeriods: 4,
  curatorTipCapShareBps: 2500,
  curatorBreakerRatioBps: 25000,
  curatorBreakerFloorMedianPeriods: 12,
  curatorBreakerArmPeriods: 4
}

const DEFAULT_PARAMS = {
  multBps: 15000,
  drawdownWeeks: 13,
  avgPeriods: 4,
  capShareBps: 2500,
  breakerRatioBps: 25000,
  breakerFloorMedianPeriods: 12,
  breakerArmPeriods: 4
}

const NUMERIC_CONFIG_FIELDS = [
  'curatorBudgetMultBps',
  'curatorBudgetDrawdownWeeks',
  'curatorBudgetAvgPeriods',
  'curatorTipCapShareBps',
  'curatorBreakerRatioBps',
  'curatorBreakerFloorMedianPeriods',
  'curatorBreakerArmPeriods'
]

const PARAM_BY_CONFIG_FIELD = {
  curatorBudgetMultBps: 'multBps',
  curatorBudgetDrawdownWeeks: 'drawdownWeeks',
  curatorBudgetAvgPeriods: 'avgPeriods',
  curatorTipCapShareBps: 'capShareBps',
  curatorBreakerRatioBps: 'breakerRatioBps',
  curatorBreakerFloorMedianPeriods: 'breakerFloorMedianPeriods',
  curatorBreakerArmPeriods: 'breakerArmPeriods'
}

// Deterministic LCG so a failing property case is reproducible.
function seededRandom (seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function floatCapT (values, capShareBps = 2500) {
  const xs = values.map(Number).filter(x => x > 0)
  const share = capShareBps / 10000
  if (xs.length * share < 1) return 0
  let level = xs.reduce((acc, x) => acc + x, 0) * share
  for (let i = 0; i < 10000; i++) {
    const next = xs.reduce((acc, x) => acc + Math.min(x, level), 0) * share
    const converged = Math.abs(next - level) <= 1e-12 * Math.max(1, next)
    level = next
    if (converged) break
  }
  return xs.reduce((acc, x) => acc + Math.min(x, level), 0)
}

function cappedSumAtLevel (xs, level) {
  return xs.reduce((sum, x) => sum + (x < level ? x : level), 0n)
}

// The minimal reserve at which the floored limit reaches the target, searched
// outward from the real-valued boundary W x (k x T4 x 1.1 - I4) with the same
// flooring the implementation uses. The integer boundary lies within one
// W-step of the formula, so both walks are short and provably bounded.
function crossoverReserve ({ t4, i4, multBps, weeks }) {
  const target = t4 * BigInt(multBps) / 10000n
  const w = BigInt(weeks)
  const limitAt = reserve => (i4 + reserve / w) * 10000n / 11000n
  const formula = w * (t4 * BigInt(multBps) * 11n / (10000n * 10n) - i4)
  let reserve = formula < 0n ? 0n : formula
  while (limitAt(reserve) < target) reserve += 1n
  while (reserve > 0n && limitAt(reserve - 1n) >= target) reserve -= 1n
  return { reserve, target, formula }
}

describe('resolveCuratorBudgetConfig', () => {
  test('accepts the shipped defaults', () => {
    expect(resolveCuratorBudgetConfig(DEFAULT_CONFIG)).toEqual({
      ok: true,
      mode: 'LEGACY',
      params: DEFAULT_PARAMS,
      errors: []
    })
  })

  test.each(['LEGACY', 'SHADOW', 'ACTIVE'])('accepts %s mode', mode => {
    const result = resolveCuratorBudgetConfig({ ...DEFAULT_CONFIG, curatorBudgetMode: mode })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe(mode)
    expect(result.errors).toEqual([])
  })

  test.each([4, 13, 104])('accepts drawdownWeeks %i', weeks => {
    const result = resolveCuratorBudgetConfig({ ...DEFAULT_CONFIG, curatorBudgetDrawdownWeeks: weeks })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  test.each([
    ['curatorBudgetMode', 'TURBO', 'mode_invalid'],
    ['curatorBudgetMultBps', 9999, 'multBps_below_minimum'],
    ['curatorBudgetDrawdownWeeks', 3, 'drawdownWeeks_out_of_range'],
    ['curatorBudgetDrawdownWeeks', 105, 'drawdownWeeks_out_of_range'],
    ['curatorTipCapShareBps', 0, 'capShareBps_out_of_range'],
    ['curatorTipCapShareBps', 10001, 'capShareBps_out_of_range'],
    ['curatorBreakerRatioBps', 10000, 'breakerRatioBps_not_above_baseline'],
    ['curatorBudgetAvgPeriods', 0, 'avgPeriods_below_one'],
    ['curatorBreakerFloorMedianPeriods', 0, 'breakerFloorMedianPeriods_below_one'],
    ['curatorBreakerArmPeriods', 0, 'breakerArmPeriods_below_one']
  ])('fails closed to LEGACY for %s = %p', (field, value, error) => {
    const result = resolveCuratorBudgetConfig({ ...DEFAULT_CONFIG, [field]: value })
    expect(result.ok).toBe(false)
    expect(result.mode).toBe('LEGACY')
    expect(result.errors).toContain(error)
    const expectedParams = field === 'curatorBudgetMode'
      ? DEFAULT_PARAMS
      : { ...DEFAULT_PARAMS, [PARAM_BY_CONFIG_FIELD[field]]: value }
    expect(result.params).toEqual(expectedParams)
  })

  test.each(NUMERIC_CONFIG_FIELDS)('rejects null, fractional and unsafe %s', field => {
    const param = PARAM_BY_CONFIG_FIELD[field]
    for (const value of [null, undefined, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '15000']) {
      const result = resolveCuratorBudgetConfig({ ...DEFAULT_CONFIG, [field]: value })
      expect(result.ok).toBe(false)
      expect(result.mode).toBe('LEGACY')
      expect(result.errors).toContain(`${param}_not_safe_integer`)
      expect(result.params).toEqual({ ...DEFAULT_PARAMS, [param]: value })
    }
  })

  test('the removed glide fields are ignored and no longer appear in params', () => {
    const result = resolveCuratorBudgetConfig({
      ...DEFAULT_CONFIG,
      curatorBudgetGlideFloorBps: 12499,
      curatorBudgetGlideStartWeeks: 2,
      curatorBudgetGlideEndWeeks: -1
    })
    expect(result.ok).toBe(true)
    expect(result.params).toEqual(DEFAULT_PARAMS)
    expect(result.params).not.toHaveProperty('glideFloorBps')
    expect(result.params).not.toHaveProperty('glideStartWeeks')
    expect(result.params).not.toHaveProperty('glideEndWeeks')
  })

  test('lists every failed rule at once', () => {
    const result = resolveCuratorBudgetConfig({
      ...DEFAULT_CONFIG,
      curatorBudgetMultBps: 9000,
      curatorTipCapShareBps: 0,
      curatorBudgetMode: 'TURBO'
    })
    expect(result.ok).toBe(false)
    expect(result.mode).toBe('LEGACY')
    expect(result.errors).toEqual(expect.arrayContaining([
      'mode_invalid',
      'multBps_below_minimum',
      'capShareBps_out_of_range'
    ]))
  })
})

describe('meanPiconeros and medianPiconeros', () => {
  test('mean floors the quotient and treats an empty history as zero', () => {
    expect(meanPiconeros([])).toBe(0n)
    expect(meanPiconeros([1n, 2n])).toBe(1n)
    expect(meanPiconeros([1n, 2n, 4n])).toBe(2n)
    expect(meanPiconeros([5n])).toBe(5n)
  })

  test('median sorts, floors the even middle pair and treats an empty history as zero', () => {
    expect(medianPiconeros([])).toBe(0n)
    expect(medianPiconeros([3n, 1n, 2n])).toBe(2n)
    expect(medianPiconeros([4n, 1n, 3n, 2n])).toBe(2n)
    expect(medianPiconeros([1n, 2n])).toBe(1n)
    expect(medianPiconeros([8n])).toBe(8n)
  })
})

describe('capTipperContributions', () => {
  test.each([
    ['no tippers', []],
    ['one tipper', [100n]],
    ['two tippers', [100n, 100n]],
    ['three large tippers', [1_000_000_000_000n, 1_000_000_000_000n, 1_000_000_000_000n]]
  ])('returns zero for %s (fewer than four cannot each hold a quarter)', (_name, xs) => {
    expect(capTipperContributions(xs, 2500)).toEqual({ tPiconeros: 0n, levelPiconeros: 0n })
  })

  test('ignores zero contributions when counting tippers', () => {
    expect(capTipperContributions([100n, 100n, 100n, 0n], 2500)).toEqual({ tPiconeros: 0n, levelPiconeros: 0n })
  })

  test('four equal tippers lose nothing', () => {
    expect(capTipperContributions([25n, 25n, 25n, 25n], 2500)).toEqual({ tPiconeros: 100n, levelPiconeros: 25n })
  })

  test('one dominant tipper is trimmed to the hand-computed level', () => {
    // S = 130, R_1 = 30, L = floor(30 * 2500 / 7500) = 10 >= 10.
    expect(capTipperContributions([100n, 10n, 10n, 10n], 2500)).toEqual({ tPiconeros: 40n, levelPiconeros: 10n })
  })

  test('a whale among thirty small tippers is trimmed to the level', () => {
    const small = 1_000_000_000n
    const whale = 50_000_000_000n
    const xs = [...Array(30).fill(small), whale]
    // R_1 = 30e9, L = 30e9 / 3 = 10e9 >= 1e9; T = 10e9 + 30e9.
    expect(capTipperContributions(xs, 2500)).toEqual({ tPiconeros: 40_000_000_000n, levelPiconeros: 10_000_000_000n })
  })

  test('a 100% share never caps and still needs four tippers', () => {
    expect(capTipperContributions([1n, 2n, 3n, 4n], 10000)).toEqual({ tPiconeros: 10n, levelPiconeros: 4n })
    expect(capTipperContributions([1n, 2n], 10000)).toEqual({ tPiconeros: 3n, levelPiconeros: 2n })
  })

  test('all-zero contributions are empty', () => {
    expect(capTipperContributions([0n, 0n, 0n, 0n], 2500)).toEqual({ tPiconeros: 0n, levelPiconeros: 0n })
  })

  test('600 seeded random arrays across three cap shares satisfy the cap and maximality invariants', () => {
    const random = seededRandom(0xdcb2026)
    const capShares = [2500, 3333, 7000]
    const capValue = 50_000_000_000 // 0.05 XMR in piconeros

    for (let trial = 0; trial < 600; trial++) {
      const capShareBps = capShares[trial % capShares.length]
      const length = 1 + Math.floor(random() * 40)
      const xs = Array.from({ length }, () => BigInt(Math.floor(random() * (capValue + 1))))
      const { tPiconeros, levelPiconeros: level } = capTipperContributions(xs, capShareBps)
      const nonzero = xs.filter(x => x > 0n)
      const max = nonzero.reduce((acc, x) => (x > acc ? x : acc), 0n)

      for (const x of xs) {
        const contribution = x < level ? x : level
        expect(contribution * 10000n).toBeLessThanOrEqual(BigInt(capShareBps) * tPiconeros)
      }

      // T(L) is the returned sum, and L is maximal: T(L+1) would exceed the
      // cap, so no larger level is feasible.
      expect(cappedSumAtLevel(xs, level)).toBe(tPiconeros)
      if (level < max) {
        expect(cappedSumAtLevel(xs, level + 1n) * 10000n)
          .toBeGreaterThan(BigInt(capShareBps) * tPiconeros)
      }

      const expected = floatCapT(xs, capShareBps)
      const actual = Number(tPiconeros)
      expect(Math.abs(actual - expected) / Math.max(1, expected)).toBeLessThanOrEqual(1e-6)
    }
  })
})

describe('applySpikeBreaker', () => {
  test('is not armed below the arm period count and records the threshold anyway', () => {
    const result = applySpikeBreaker({
      tPiconeros: 1_000_000n,
      priorTs: [100n, 100n, 100n],
      params: DEFAULT_PARAMS
    })
    expect(result).toEqual({
      tPiconeros: 1_000_000n,
      tripped: false,
      armed: false,
      rawTPiconeros: 1_000_000n,
      thresholdPiconeros: 250n
    })
  })

  test('arms at four prior periods and caps a trip exactly at the threshold', () => {
    const result = applySpikeBreaker({
      tPiconeros: 300n,
      priorTs: [100n, 100n, 100n, 100n],
      params: DEFAULT_PARAMS
    })
    expect(result.armed).toBe(true)
    expect(result.tripped).toBe(true)
    expect(result.tPiconeros).toBe(250n)
    expect(result.rawTPiconeros).toBe(300n)
    expect(result.thresholdPiconeros).toBe(250n)
  })

  test('does not trip at exactly the threshold', () => {
    const result = applySpikeBreaker({
      tPiconeros: 250n,
      priorTs: [100n, 100n, 100n, 100n],
      params: DEFAULT_PARAMS
    })
    expect(result.armed).toBe(true)
    expect(result.tripped).toBe(false)
    expect(result.tPiconeros).toBe(250n)
  })

  test('uses the larger of the prior four-period mean and the twelve-period median', () => {
    // mean([1, 1000, 1000, 1000]) = floor(3001 / 4) = 750; median = 1000.
    const medianDominant = applySpikeBreaker({
      tPiconeros: 2501n,
      priorTs: [1n, 1000n, 1000n, 1000n],
      params: DEFAULT_PARAMS
    })
    expect(medianDominant.thresholdPiconeros).toBe(2500n)
    expect(medianDominant.tPiconeros).toBe(2500n)

    // mean([1, 1, 1, 1000]) = floor(1003 / 4) = 250; median = 1.
    const meanDominant = applySpikeBreaker({
      tPiconeros: 626n,
      priorTs: [1n, 1n, 1n, 1000n],
      params: DEFAULT_PARAMS
    })
    expect(meanDominant.thresholdPiconeros).toBe(625n)
    expect(meanDominant.tPiconeros).toBe(625n)
  })

  test('uses the recorded history available when fewer than twelve periods exist', () => {
    // mean([10, 20, 30, 40]) = 25; median = 25.
    const result = applySpikeBreaker({
      tPiconeros: 63n,
      priorTs: [10n, 20n, 30n, 40n],
      params: DEFAULT_PARAMS
    })
    expect(result.armed).toBe(true)
    expect(result.thresholdPiconeros).toBe(62n)
    expect(result.tPiconeros).toBe(62n)
  })

  test('all-zero history arms with a zero threshold and caps any positive volume at zero', () => {
    const tripped = applySpikeBreaker({
      tPiconeros: 1n,
      priorTs: [0n, 0n, 0n, 0n],
      params: DEFAULT_PARAMS
    })
    expect(tripped.armed).toBe(true)
    expect(tripped.thresholdPiconeros).toBe(0n)
    expect(tripped.tripped).toBe(true)
    expect(tripped.tPiconeros).toBe(0n)

    const quiet = applySpikeBreaker({
      tPiconeros: 0n,
      priorTs: [0n, 0n, 0n, 0n],
      params: DEFAULT_PARAMS
    })
    expect(quiet.tripped).toBe(false)
    expect(quiet.tPiconeros).toBe(0n)
  })

  test('averages only the most recent avgPeriods and medians only the floor window', () => {
    const result = applySpikeBreaker({
      tPiconeros: 1000n,
      priorTs: [100n, 100n, 100n, 100n, 999_999n],
      params: DEFAULT_PARAMS
    })
    // The fifth oldest value is outside both windows: mean = 100, median = 100.
    expect(result.thresholdPiconeros).toBe(250n)
  })
})

describe('computeCuratorBudget', () => {
  const T4 = 1_000n
  const I4 = 1_650n // exactly k x T4 x 1.1, so the limit never binds below

  test('pays the target when the limit leaves room, recording reserve and limit', () => {
    // reserve = 2000 - 1650 = 350; floor(350 / 13) = 26;
    // limit = floor((1650 + 26) * 10000 / 11000) = floor(1523.63) = 1523;
    // target = 1000 * 15000 / 10000 = 1500 <= limit <= pool.
    const result = computeCuratorBudget({
      poolPiconeros: 2_000n,
      tipVolumes: [T4],
      incomeVolumes: [I4],
      params: DEFAULT_PARAMS
    })
    expect(result).toEqual({
      budgetPiconeros: 1_500n,
      targetPiconeros: 1_500n,
      limitPiconeros: 1_523n,
      reservePiconeros: 350n,
      multBps: 15000,
      t4Piconeros: T4,
      f4Piconeros: I4,
      outcome: 'FULL'
    })
  })

  test('I4 is the income MEDIAN: a one-off spike does not inflate the limit', () => {
    // Production 2026-10-26 shape: a 4.64 XMR fee overpaid as a donation sits
    // in the window. Sorted 26.79e9, 27.02e9, 126.07e9, 4640.88e9 ->
    // I4 = floor((27_020_000_000 + 126_070_000_000) / 2) = 76_545_000_000.
    // The mean would be 1_205_190_460_526 and lift the limit ~16x.
    const incomeVolumes = [126_070_000_000n, 4_640_880_000_000n, 27_020_000_000n, 26_791_842_104n]
    const result = computeCuratorBudget({
      poolPiconeros: 6_000_000_000_000n,
      tipVolumes: [185_517_283_687n],
      incomeVolumes,
      params: DEFAULT_PARAMS
    })
    expect(result.f4Piconeros).toBe(76_545_000_000n)
    expect(result.f4Piconeros).not.toBe(meanPiconeros(incomeVolumes))
    // reserve = 6e12 - 76_545_000_000 = 5_923_455_000_000; /13 floors to
    // 455_650_384_615; limit = floor((76_545_000_000 + 455_650_384_615) * 10000 / 11000).
    expect(result.reservePiconeros).toBe(5_923_455_000_000n)
    expect(result.limitPiconeros).toBe(483_813_986_013n)
    // The target (1.5 x T4) still pays in full.
    expect(result.budgetPiconeros).toBe(278_275_925_530n)
    expect(result.outcome).toBe('FULL')
  })

  test('I4 uses only the averaging window and an odd short history takes the middle', () => {
    const result = computeCuratorBudget({
      poolPiconeros: 10_000n,
      tipVolumes: [100n],
      incomeVolumes: [5n, 900n, 7n, 1n, 99_999n], // the 5th period is outside avgPeriods = 4
      params: DEFAULT_PARAMS
    })
    expect(result.f4Piconeros).toBe(6n) // sorted 1, 5, 7, 900 -> floor((5 + 7) / 2)
    const short = computeCuratorBudget({
      poolPiconeros: 10_000n,
      tipVolumes: [100n],
      incomeVolumes: [5n, 900n, 7n],
      params: DEFAULT_PARAMS
    })
    expect(short.f4Piconeros).toBe(7n)
  })

  test('T4 stays a mean while I4 is a median', () => {
    const result = computeCuratorBudget({
      poolPiconeros: 1_000_000n,
      tipVolumes: [1n, 1n, 1n, 1_001n],
      incomeVolumes: [1n, 1n, 1n, 1_001n],
      params: DEFAULT_PARAMS
    })
    expect(result.t4Piconeros).toBe(251n)
    expect(result.f4Piconeros).toBe(1n)
  })

  test('is FULL whenever the limit reaches the target, at any pool >= I4', () => {
    // I4 = k x T4 x 1.1: limit >= (I4 + 0) / 1.1 = target even at reserve 0.
    for (const pool of [1_650n, 2_000n, 5_000n, 100_000n]) {
      const result = computeCuratorBudget({
        poolPiconeros: pool,
        tipVolumes: [T4],
        incomeVolumes: [I4],
        params: DEFAULT_PARAMS
      })
      expect(result.outcome).toBe('FULL')
      expect(result.budgetPiconeros).toBe(1_500n)
      expect(result.limitPiconeros).toBeGreaterThanOrEqual(result.targetPiconeros)
    }
  })

  test('a larger I4 than k x T4 x 1.1 also never binds', () => {
    // limit = floor(2000 * 10000 / 11000) = 1818 > 1500.
    const result = computeCuratorBudget({
      poolPiconeros: 2_000n,
      tipVolumes: [T4],
      incomeVolumes: [2_000n],
      params: DEFAULT_PARAMS
    })
    expect(result.outcome).toBe('FULL')
    expect(result.budgetPiconeros).toBe(1_500n)
    expect(result.limitPiconeros).toBe(1_818n)
  })

  test('is DRAWDOWN when the limit binds below the target but the pool holds', () => {
    // reserve = 500; floor(500 / 13) = 38;
    // limit = floor(1038 * 10000 / 11000) = floor(943.63) = 943 < 1500 <= pool.
    const result = computeCuratorBudget({
      poolPiconeros: 1_500n,
      tipVolumes: [T4],
      incomeVolumes: [1_000n],
      params: DEFAULT_PARAMS
    })
    expect(result.outcome).toBe('DRAWDOWN')
    expect(result.limitPiconeros).toBe(943n)
    expect(result.reservePiconeros).toBe(500n)
    expect(result.budgetPiconeros).toBe(943n)
    expect(result.multBps).toBe(9430) // floor(943 * 10000 / 1000)
  })

  test('is POOL_SHORT when the pool itself is smaller than target and limit', () => {
    // pool 800 < I4: reserve 0, limit = floor(1000 * 10000 / 11000) = 909;
    // 800 < min(1500, 909).
    const result = computeCuratorBudget({
      poolPiconeros: 800n,
      tipVolumes: [T4],
      incomeVolumes: [1_000n],
      params: DEFAULT_PARAMS
    })
    expect(result.outcome).toBe('POOL_SHORT')
    expect(result.limitPiconeros).toBe(909n)
    expect(result.reservePiconeros).toBe(0n)
    expect(result.budgetPiconeros).toBe(800n)
    expect(result.multBps).toBe(8000)
  })

  test('the exact crossover: FULL one piconero above the boundary, DRAWDOWN one below', () => {
    // k x T4 = 3000, x 1.1 = 3300, - I4 = 2300, x W = 29900. Every division
    // here is exact, so the formula point IS the integer boundary.
    const t4 = 2_000n
    const i4 = 1_000n
    const crossover = crossoverReserve({ t4, i4, multBps: 15000, weeks: 13 })
    expect(crossover.formula).toBe(13n * (3_300n - 1_000n))
    expect(crossover.reserve).toBe(crossover.formula)

    const atBoundary = computeCuratorBudget({
      poolPiconeros: i4 + crossover.reserve,
      tipVolumes: [t4],
      incomeVolumes: [i4],
      params: DEFAULT_PARAMS
    })
    // limit = floor(3300 * 10000 / 11000) = 3000 = target.
    expect(atBoundary.outcome).toBe('FULL')
    expect(atBoundary.limitPiconeros).toBe(crossover.target)
    expect(atBoundary.budgetPiconeros).toBe(3_000n)
    expect(atBoundary.multBps).toBe(15000)

    const oneBelow = computeCuratorBudget({
      poolPiconeros: i4 + crossover.reserve - 1n,
      tipVolumes: [t4],
      incomeVolumes: [i4],
      params: DEFAULT_PARAMS
    })
    // floor(29899 / 13) = 2299; limit = floor(3299 * 10000 / 11000) = 2999.
    expect(oneBelow.outcome).toBe('DRAWDOWN')
    expect(oneBelow.budgetPiconeros).toBe(2_999n)
    expect(oneBelow.multBps).toBe(14995) // floor(2999 * 10000 / 2000)
  })

  test('the crossover lands within one W-step of the formula when flooring interferes', () => {
    // floor(61 * 15000 / 10000) = 91; formula reserve = 13 * (100 - 7) = 1209,
    // but floor(1209 / 13) = 93 gives limit 90 < 91, so the true boundary
    // needs floor(reserve / 13) = 94.
    const t4 = 61n
    const i4 = 7n
    const crossover = crossoverReserve({ t4, i4, multBps: 15000, weeks: 13 })
    expect(crossover.reserve - crossover.formula).toBeLessThanOrEqual(13n)

    const atBoundary = computeCuratorBudget({
      poolPiconeros: i4 + crossover.reserve,
      tipVolumes: [t4],
      incomeVolumes: [i4],
      params: DEFAULT_PARAMS
    })
    expect(atBoundary.outcome).toBe('FULL')
    expect(atBoundary.budgetPiconeros).toBe(91n) // floored target, paid exactly

    const oneBelow = computeCuratorBudget({
      poolPiconeros: i4 + crossover.reserve - 1n,
      tipVolumes: [t4],
      incomeVolumes: [i4],
      params: DEFAULT_PARAMS
    })
    expect(oneBelow.outcome).toBe('DRAWDOWN')
    expect(oneBelow.budgetPiconeros).toBeLessThan(91n)
  })

  test('decays geometrically for 60 steady weeks and converges on I4 / 1.1', () => {
    const F = 650_000_000_000n
    const steadyT4 = 1_000_000_000_000n
    let pool = 1_300_000_000_000n // 2F: reserve = F
    const budgets = []
    const reserves = []

    for (let week = 0; week < 60; week++) {
      const result = computeCuratorBudget({
        poolPiconeros: pool,
        tipVolumes: [steadyT4],
        incomeVolumes: [F],
        params: DEFAULT_PARAMS
      })
      expect(result.t4Piconeros).toBe(steadyT4)
      expect(result.f4Piconeros).toBe(F)
      expect(result.outcome).toBe('DRAWDOWN')
      expect(result.budgetPiconeros).toBe(result.limitPiconeros)
      budgets.push(result.budgetPiconeros)
      reserves.push(result.reservePiconeros)

      // pool += F, then pay the budget plus its 10% referrals.
      const paid = result.budgetPiconeros
      const referrals = paid / 10n < pool - paid ? paid / 10n : pool - paid
      pool = pool - paid - referrals + F
    }

    for (let week = 1; week < 60; week++) {
      const fall = budgets[week - 1] - budgets[week]
      // The budget never rises week over week.
      expect(fall).toBeGreaterThanOrEqual(0n)
      // Each fall is at most reserve / W / 1.1, plus 1 piconero of flooring.
      const bound = reserves[week - 1] * 10000n / (11000n * 13n)
      expect(fall).toBeLessThanOrEqual(bound + 1n)
      // The reserve never reaches 0 while income keeps flowing.
      expect(reserves[week]).toBeGreaterThan(0n)
    }

    const steady = F * 10000n / 11000n
    const gap = budgets[59] > steady ? budgets[59] - steady : steady - budgets[59]
    expect(gap * 100n).toBeLessThanOrEqual(steady)
  })

  test('an approved make-up raises the target but the paid budget stays inside the limit', () => {
    const binding = computeCuratorBudget({
      poolPiconeros: 1_500n,
      tipVolumes: [T4],
      incomeVolumes: [1_000n],
      makeupPiconeros: 100n,
      params: DEFAULT_PARAMS
    })
    // target = 1600 > limit 943: the make-up is inside the limit.
    expect(binding.targetPiconeros).toBe(1_600n)
    expect(binding.budgetPiconeros).toBe(binding.limitPiconeros)
    expect(binding.budgetPiconeros).toBe(943n)
    expect(binding.outcome).toBe('DRAWDOWN')

    const pushedOver = computeCuratorBudget({
      poolPiconeros: 2_000n,
      tipVolumes: [T4],
      incomeVolumes: [I4],
      makeupPiconeros: 100n,
      params: DEFAULT_PARAMS
    })
    // Without the make-up this run is FULL at 1500; with it the target 1600
    // passes the limit 1523, which then binds.
    expect(pushedOver.targetPiconeros).toBe(1_600n)
    expect(pushedOver.budgetPiconeros).toBe(pushedOver.limitPiconeros)
    expect(pushedOver.budgetPiconeros).toBe(1_523n)
    expect(pushedOver.outcome).toBe('DRAWDOWN')
  })

  test('zero T4 pays nothing and records a NULL multiple', () => {
    const result = computeCuratorBudget({
      poolPiconeros: 100_000n,
      tipVolumes: [],
      incomeVolumes: [],
      params: DEFAULT_PARAMS
    })
    expect(result.t4Piconeros).toBe(0n)
    expect(result.f4Piconeros).toBe(0n)
    // reserve = 100000; limit = floor(7692 * 10000 / 11000) = 6992.
    expect(result.limitPiconeros).toBe(6_992n)
    expect(result.targetPiconeros).toBe(0n)
    expect(result.budgetPiconeros).toBe(0n)
    expect(result.multBps).toBeNull()
    expect(result.outcome).toBe('FULL')
  })

  test('zero T4 with an approved make-up stays inside the limit', () => {
    const result = computeCuratorBudget({
      poolPiconeros: 65_000n,
      tipVolumes: [],
      incomeVolumes: [],
      makeupPiconeros: 5_000n,
      params: DEFAULT_PARAMS
    })
    expect(result.targetPiconeros).toBe(5_000n)
    // reserve = 65000; floor(65000 / 13) = 5000; limit = floor(5000 * 10 / 11) = 4545.
    expect(result.limitPiconeros).toBe(4_545n)
    expect(result.budgetPiconeros).toBe(4_545n)
    expect(result.multBps).toBeNull()
    expect(result.outcome).toBe('DRAWDOWN')
  })

  test('zero T4 with make-up and real income pays the make-up with a NULL multiple', () => {
    const result = computeCuratorBudget({
      poolPiconeros: 100_000n,
      tipVolumes: [],
      incomeVolumes: [60_000n],
      makeupPiconeros: 5_000n,
      params: DEFAULT_PARAMS
    })
    // reserve = 40000; floor(40000 / 13) = 3076;
    // limit = floor(63076 * 10000 / 11000) = 57341 >= target.
    expect(result.limitPiconeros).toBe(57_341n)
    expect(result.targetPiconeros).toBe(5_000n)
    expect(result.budgetPiconeros).toBe(5_000n)
    expect(result.multBps).toBeNull()
    expect(result.outcome).toBe('FULL')
  })

  test('uses only the recorded periods that exist and never more than avgPeriods', () => {
    const short = computeCuratorBudget({
      poolPiconeros: 10_000n,
      tipVolumes: [2n, 3n],
      incomeVolumes: [1n, 2n],
      params: DEFAULT_PARAMS
    })
    expect(short.t4Piconeros).toBe(2n)
    expect(short.f4Piconeros).toBe(1n)
    // reserve = 9999; floor(9999 / 13) = 769; limit = floor(770 * 10000 / 11000) = 700.
    expect(short.limitPiconeros).toBe(700n)
    expect(short.targetPiconeros).toBe(3n)
    expect(short.budgetPiconeros).toBe(3n)
    expect(short.outcome).toBe('FULL')

    const cappedHistory = computeCuratorBudget({
      poolPiconeros: 10_000n,
      tipVolumes: [1000n, 1000n, 1000n, 1000n, 999_999n],
      incomeVolumes: [10n, 10n, 10n, 10n, 999_999n],
      params: DEFAULT_PARAMS
    })
    expect(cappedHistory.t4Piconeros).toBe(1000n)
    expect(cappedHistory.f4Piconeros).toBe(10n)
    // floor(9990 / 13) = 768; limit = floor(778 * 10000 / 11000) = 707.
    expect(cappedHistory.limitPiconeros).toBe(707n)
    expect(cappedHistory.budgetPiconeros).toBe(707n)
    expect(cappedHistory.outcome).toBe('DRAWDOWN')
  })

  test('floors the reserve share and the limit division', () => {
    // reserve = 14; floor(14 / 13) = 1; limit = floor(8 * 10000 / 11000) = 7.
    const result = computeCuratorBudget({
      poolPiconeros: 21n,
      tipVolumes: [100n],
      incomeVolumes: [7n],
      params: DEFAULT_PARAMS
    })
    expect(result.reservePiconeros).toBe(14n)
    expect(result.limitPiconeros).toBe(7n)
    expect(result.budgetPiconeros).toBe(7n)
    expect(result.outcome).toBe('DRAWDOWN')
    expect(result.multBps).toBe(700) // floor(7 * 10000 / 100)
  })

  test('floors the reserve share to a whole limit step and the target division', () => {
    // reserve = 27; floor(27 / 13) = 2; limit = floor(2 * 10000 / 11000) = 1;
    // target = floor(15000 / 10000) = 1; FULL at the equality.
    const result = computeCuratorBudget({
      poolPiconeros: 27n,
      tipVolumes: [1n],
      incomeVolumes: [0n],
      params: DEFAULT_PARAMS
    })
    expect(result.reservePiconeros).toBe(27n)
    expect(result.limitPiconeros).toBe(1n)
    expect(result.targetPiconeros).toBe(1n)
    expect(result.budgetPiconeros).toBe(1n)
    expect(result.multBps).toBe(10000)
    expect(result.outcome).toBe('FULL')
  })

  test('treats a negative pool as zero without throwing', () => {
    const result = computeCuratorBudget({
      poolPiconeros: -5n,
      tipVolumes: [1n],
      incomeVolumes: [],
      params: DEFAULT_PARAMS
    })
    expect(result.reservePiconeros).toBe(0n)
    expect(result.limitPiconeros).toBe(0n)
    expect(result.targetPiconeros).toBe(1n)
    expect(result.budgetPiconeros).toBe(0n)
    expect(result.multBps).toBe(0) // floor(0 * 10000 / 1)
    expect(result.outcome).toBe('DRAWDOWN')
  })
})

describe('makeupPiconeros', () => {
  test('pays a quarter of the trimmed volume at the configured k', () => {
    expect(makeupPiconeros({
      rawTPiconeros: 1000n,
      capTPiconeros: 800n,
      multBps: 15000
    })).toBe(75n)
  })

  test('never pays when nothing was capped', () => {
    expect(makeupPiconeros({
      rawTPiconeros: 800n,
      capTPiconeros: 800n,
      multBps: 15000
    })).toBe(0n)
    expect(makeupPiconeros({
      rawTPiconeros: 700n,
      capTPiconeros: 800n,
      multBps: 15000
    })).toBe(0n)
  })

  test('floors the division', () => {
    expect(makeupPiconeros({
      rawTPiconeros: 101n,
      capTPiconeros: 100n,
      multBps: 12500
    })).toBe(0n)
  })
})
