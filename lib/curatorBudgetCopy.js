// Shared display helpers for the curator budget copy on /rewards and
// /transparency. One definition here so the two pages cannot drift.

// 15000 -> "1.5×", 13800 -> "1.38×", 9800 -> "0.98×". Null when the multiple
// does not exist (missing or non-finite bps); callers choose how to render it.
export function formatMultiple (multBps) {
  if (!Number.isFinite(multBps)) return null
  return `${(multBps / 10000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×`
}

// The drawdown weeks the copy quotes: the configured W while the projection is
// available (it can be anywhere in 4..104), else the documented ledger default.
export const DEFAULT_DRAWDOWN_WEEKS = 13

export function copyDrawdownWeeks (budget) {
  return Number.isSafeInteger(budget?.drawdownWeeks) ? budget.drawdownWeeks : DEFAULT_DRAWDOWN_WEEKS
}
