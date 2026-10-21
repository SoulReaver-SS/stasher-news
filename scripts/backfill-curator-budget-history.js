// Backfill the dynamic curator budget history (spec 2026-10-19 §9.1).
// Dry-run by default. Fills only the recorded-history fields on the most recent
// distributions (default: curatorBreakerFloorMedianPeriods) and never touches
// money columns, payouts or Earn rows. Rows are processed oldest first inside
// ONE Serializable transaction so the breaker sees exactly the history a live
// run would have seen. A filled newer row above a NULL older row is refused.
//
//   dev: sndev monero backfill-budget [--periods N] [--confirm]
//   direct: npx tsx --tsconfig jsconfig.json scripts/backfill-curator-budget-history.js \
//             [--periods N] [--confirm]
//   VPS: loader-wrapped (see AGENTS.md), same script/arguments.
//
// Arguments are parsed BEFORE any database connection.
import { Prisma, PrismaClient } from '@prisma/client'
import {
  backfillCuratorBudgetHistory,
  CURATOR_BUDGET_BACKFILL_TRANSACTION_TIMEOUT_MS
} from '@/worker/curatorBudget'
import { piconerosToXmrDecimal } from '@/api/monero/uri'

const USAGE = 'Usage: backfill-curator-budget-history [--periods N] [--confirm]'

export function parseArgs (argv) {
  let periods = null
  let confirm = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--confirm') {
      confirm = true
      continue
    }
    if (arg === '--periods') {
      const raw = argv[++i]
      periods = Number(raw)
      if (raw == null || !Number.isSafeInteger(periods) || periods <= 0) {
        console.error(USAGE)
        console.error('  --periods must be a positive integer')
        process.exit(1)
      }
      continue
    }
    console.error(USAGE)
    console.error(`  unknown argument: ${arg}`)
    process.exit(1)
  }
  return { periods, confirm }
}

function xmr (piconeros) {
  if (piconeros == null) return '—'
  return `${piconerosToXmrDecimal(BigInt(piconeros))} XMR`
}

function amount (piconeros) {
  if (piconeros == null) return '—'
  return `${BigInt(piconeros).toString()} pico (${xmr(piconeros)})`
}

function stageAmount (row, key) {
  const value = row.stages?.[key]
  return value == null ? '—' : amount(value)
}

function iso (date) {
  return date == null ? '—' : new Date(date).toISOString()
}

function printRows (rows) {
  for (const row of rows) {
    const skipped = row.skipped ? ' [already recorded — skipped]' : ''
    console.log(`#${row.id} ${iso(row.periodStart)} → ${iso(row.periodEnd)} ${row.status}${skipped}`)
    console.log(
      `  raw=${stageAmount(row, 'raw')} eligible=${stageAmount(row, 'eligible')} ` +
      `afterExclusions=${stageAmount(row, 'afterExclusions')} ranked=${stageAmount(row, 'ranked')} ` +
      `handicapped=${stageAmount(row, 'handicapped')} trusted=${stageAmount(row, 'trusted')} ` +
      `capped=${stageAmount(row, 'capped')} final=${amount(row.finalTPiconeros)} ` +
      `tippers=${row.tipperCount ?? '—'}`
    )
    console.log(
      `  breaker: threshold=${amount(row.breaker.thresholdPiconeros)} ` +
      `armed=${row.breaker.armed} tripped=${row.breaker.tripped} ` +
      `rawT=${amount(row.breaker.rawTPiconeros)}`
    )
    if (row.skipped) {
      console.log(`  F=${amount(row.incomePiconeros)} (recorded; not recomputed)`)
    } else {
      const reader = row.readerEarmarkMismatch
        ? `MISMATCH (information only; reader=${amount(row.readerRewardsPiconeros)})`
        : 'match'
      console.log(
        `  F=${amount(row.incomePiconeros)} earmark=${amount(row.earmarkPiconeros)} ` +
        `donations=${amount(row.donationsPiconeros)} earmark-vs-reader=${reader} ` +
        `previous=${row.previousDistributionId ?? 'first distribution'}`
      )
    }
  }
}

function printHistory (label, history) {
  console.log(`${label} (newest first, ${history.length}):`)
  if (history.length === 0) {
    console.log('  (empty)')
    return
  }
  for (const row of history) {
    console.log(`  #${row.id} ${iso(row.periodEnd)} ${amount(row.piconeros)}`)
  }
}

function printDerived (result) {
  console.log('--- derived first-run inputs ---')
  printHistory('T history', result.tHistory)
  printHistory('F history', result.fHistory)
  const pool = result.currentPool
  console.log(
    `current pool: ${amount(pool.poolPiconeros)} ` +
    `(rewards inflow ${amount(pool.rewardsInflowPiconeros)}, ` +
    `rolled over ${amount(pool.rolledOverPiconeros)})`
  )
  const open = result.openPeriod
  console.log(
    `open period ${iso(open.periodStart)} → ${iso(open.periodEnd)}: ` +
    `raw=${amount(open.rawPiconeros)} capped=${stageAmount(open, 'capped')} ` +
    `final T=${amount(open.finalTPiconeros)} ` +
    `breaker threshold=${amount(open.breaker.thresholdPiconeros)} ` +
    `armed=${open.breaker.armed} tripped=${open.breaker.tripped} ` +
    `F=${amount(open.incomePiconeros)} trustFloor=${open.trustWeightFloor}` +
    `${open.staleTrustFallback ? ' (stale trust: previous T reused)' : ''}`
  )
  const budget = open.budget
  console.log(
    `budget now: T4=${amount(budget.t4Piconeros)} I4=${amount(budget.f4Piconeros)} ` +
    `reserve=${amount(budget.reservePiconeros)} limit=${amount(budget.limitPiconeros)} ` +
    `m=${budget.multBps}bps dynamic=${amount(budget.budgetPiconeros)} ` +
    `target=${amount(budget.targetPiconeros)} outcome=${budget.outcome}`
  )
}

async function main () {
  const { periods, confirm } = parseArgs(process.argv.slice(2))
  const prisma = new PrismaClient()
  try {
    const result = await prisma.$transaction(
      tx => backfillCuratorBudgetHistory(tx, { periods, dryRun: !confirm }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: CURATOR_BUDGET_BACKFILL_TRANSACTION_TIMEOUT_MS
      }
    )
    if (result.refused) {
      console.error(
        `refused: ${result.refused} — distribution #${result.gap.newerId} is already ` +
        `recorded while older distribution #${result.gap.olderId} is NULL. ` +
        'Filling the gap would corrupt the sequential breaker; nothing was written.'
      )
      process.exitCode = 2
      return
    }
    console.log(
      `--- curator budget history: ${result.periods} most recent distribution(s), ` +
      `dryRun=${result.dryRun}, capShareBps=${result.capShareBps} ---`
    )
    printRows(result.rows)
    printDerived(result)
    const written = result.rows.filter(row => row.wrote).length
    const wouldWrite = result.rows.filter(row => !row.skipped).length
    const skipped = result.rows.filter(row => row.skipped).length
    if (!confirm) {
      console.log(`--- dry-run: nothing mutated. ${wouldWrite} row(s) would be filled, ${skipped} already recorded. ---`)
      console.log('--- re-run with --confirm to write. ---')
      return
    }
    console.log(`--- confirm: wrote ${written} row(s); ${skipped} already recorded. ---`)
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1]?.endsWith('backfill-curator-budget-history.js')) {
  main().catch(e => { console.error(e); process.exitCode = 1 })
}
