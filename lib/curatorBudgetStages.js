// Public view of eligibleTipStages (dynamic curator budget, spec §10).
//
// The stored JSON is already produced from stage TOTALS, but this whitelist is
// the boundary for the unauthenticated GraphQL surfaces: arbitrary keys (for
// example config exclusion IDs) must never be forwarded. `backfilled` is
// retained so future Stage 5 history rows can label their provenance.

const STAGE_FIELDS = [
  'raw',
  'eligible',
  'afterExclusions',
  'ranked',
  'handicapped',
  'trusted',
  'capped',
  'final',
  'breakerThreshold'
]

const STAGE_FLAGS = ['staleTrustFallback', 'breakerArmed', 'backfilled']

export function sanitizeEligibleTipStages (stages) {
  if (stages == null || typeof stages !== 'object' || Array.isArray(stages)) return null
  const sanitized = {}
  for (const field of STAGE_FIELDS) {
    if (stages[field] != null) sanitized[field] = String(stages[field])
  }
  for (const field of STAGE_FLAGS) {
    if (stages[field] != null) sanitized[field] = stages[field] === true
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null
}
