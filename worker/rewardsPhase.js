import { logInfo } from '@/lib/logger'

// rewardsPhase (Finding 3 prerequisite) — start/finish timing for the six
// rewards money phases, so the 2026-10-12 class of incident (a run that
// outlives pg-boss's execution budget while still making progress) has
// per-phase durations instead of one opaque multi-minute wall time.
//
// Contract:
//   - the callback is ALWAYS invoked, exactly once;
//   - its result is returned and its exception is rethrown by identity, so
//     wrapping a call can never change money behavior;
//   - a start line is logged BEFORE the callback runs and a finish line in
//     `finally`, so even a hung phase leaves its start marker in the log;
//   - logging is best-effort: a throwing logger is swallowed and cannot
//     prevent the callback, mask its result, or replace its exception.
//
// The helper logs ONLY code-owned fields: `phase`, `outcome`, `durationMs`,
// and whatever numeric ids the caller passes as `context` (e.g. distribution
// id, account index). It never receives or logs wallets, job objects, payout
// payloads, or exception text/material.
function logPhase (fields, message) {
  try {
    logInfo(fields, message)
  } catch { /* diagnostics never change money effects */ }
}

// `phase` is one of the six fixed names instrumented by call sites:
// wallet-initial-sync, wallet-incremental-sync, payout-build, payout-relay,
// distribution-ledger, distribution-completion. `outcome` starts 'failed' and
// becomes 'completed' only when the callback resolves.
export async function withRewardsPhase (phase, run, context = {}) {
  const startedAt = Date.now()
  let outcome = 'failed'
  logPhase({ phase, ...context }, 'rewards phase started')
  try {
    const result = await run()
    outcome = 'completed'
    return result
  } finally {
    logPhase({ phase, ...context, outcome, durationMs: Date.now() - startedAt }, 'rewards phase finished')
  }
}
