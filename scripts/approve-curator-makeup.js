// Approve a breaker make-up (spec 2026-10-19 §5). Dry-run by default; --confirm
// marks the tripped row so the IMMEDIATELY FOLLOWING distribution run pays
// (rawT − capT) × k ÷ 4 once, at the CONFIGURED multiple (not the run's
// effective multiple). Only ACTIVE mode actually pays it; LEGACY/SHADOW
// recompute and record the make-up but keep the fallback-cap payouts. The
// current config must validate — an invalid one is refused without writing —
// and the printed estimate follows the CURRENT configured k: the paying run
// re-reads its own config, the amount is bounded by the pool's spend limit and
// pool, and approval is never a promised payment.
//
//   dev: sndev monero makeup <distributionId> [--confirm]
//   direct: npx tsx --tsconfig jsconfig.json scripts/approve-curator-makeup.js <distributionId> [--confirm]
//   VPS: loader-wrapped (see AGENTS.md), same script/arguments.
//
// Arguments are parsed BEFORE any database connection. The existence /
// breaker / not-already-approved / latest-row checks and the guarded UPDATE run
// in ONE Serializable transaction, so a concurrent later row or duplicate
// approval cannot race the window open.
import { Prisma, PrismaClient } from '@prisma/client'
import { makeupPiconeros } from '@/lib/curatorBudget'
import { readCuratorBudgetConfig } from '@/worker/curatorBudget'

export function parseArgs (argv) {
  const rest = argv.filter(a => !a.startsWith('--'))
  const flags = argv.filter(a => a.startsWith('--'))
  const distributionId = Number(rest[0])
  const known = ['--confirm']
  if (!Number.isInteger(distributionId) || distributionId <= 0 || flags.some(f => !known.includes(f))) {
    console.error('Usage: approve-curator-makeup <distributionId> [--confirm]')
    console.error('  dry-run by default; --confirm approves the make-up for the immediately')
    console.error('  following weekly distribution run (pays only in ACTIVE mode)')
    process.exit(1)
  }
  return { distributionId, confirm: flags.includes('--confirm') }
}

function piconerosToXmr (piconeros) {
  return (Number(piconeros) / 1e12).toFixed(6)
}

/**
 * Inspect (and optionally approve) one distribution's breaker make-up.
 * Returns `{ refused }` for every refusal instead of mutating.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} distributionId
 * @param {{ confirm?: boolean }} [opts]
 */
export async function approveCuratorMakeup (prisma, distributionId, { confirm = false } = {}) {
  return await prisma.$transaction(async tx => {
    const row = await tx.rewardDistribution.findUnique({ where: { id: distributionId } })
    if (!row) return { distributionId, refused: 'not_found' }
    // Backfilled history never paid a dynamic budget, so no make-up may be
    // approved on it (spec §9.1 / Task 5.1).
    if (row.curatorBudgetParams?.backfilled === true) {
      return { distributionId, refused: 'backfilled' }
    }

    const latest = await tx.rewardDistribution.findFirst({
      orderBy: [{ periodEnd: 'desc' }, { id: 'desc' }],
      select: { id: true }
    })
    if (latest?.id !== row.id) return { distributionId, refused: 'not_latest' }
    if (!row.breakerTripped) return { distributionId, refused: 'not_tripped' }
    if (row.breakerMakeupApproved) return { distributionId, refused: 'already_approved' }
    // A malformed/legacy trip without its recorded raw/capped T must never be
    // interpreted as a full-volume make-up. The row's multBps is the EFFECTIVE
    // multiple and is NULL on a valid zero-history (T4 = 0) trip — it gates
    // neither the approval nor the estimate.
    if (row.breakerRawTPiconeros == null || row.trustedTipPiconeros == null) {
      return { distributionId, refused: 'missing_breaker_data' }
    }

    // The make-up is paid at the CONFIGURED k of the run that consumes it
    // (spec §5), so the current config must validate; an invalid config is
    // refused with its reasons and no write rather than estimated on a
    // fallback.
    const resolved = await readCuratorBudgetConfig(tx)
    if (!resolved.ok) {
      return {
        distributionId,
        refused: 'invalid_curator_budget_config',
        configErrors: resolved.errors
      }
    }
    const { params, mode } = resolved
    const rawTPiconeros = row.breakerRawTPiconeros
    const cappedTPiconeros = row.trustedTipPiconeros
    const estimatedMakeupPiconeros = makeupPiconeros({
      rawTPiconeros,
      capTPiconeros: cappedTPiconeros,
      multBps: params.multBps
    })
    const summary = {
      distributionId,
      rawTPiconeros,
      cappedTPiconeros,
      multBps: row.multBps,
      configuredMultBps: params.multBps,
      makeupPiconeros: estimatedMakeupPiconeros,
      mode,
      confirm,
      approved: false
    }
    if (!confirm) return summary

    const changed = await tx.$executeRaw`
      UPDATE "RewardDistribution" SET "breakerMakeupApproved" = true
      WHERE id = ${distributionId} AND "breakerTripped" AND NOT "breakerMakeupApproved"`
    if (changed !== 1) return { ...summary, refused: 'update_missed' }
    return { ...summary, approved: true }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

async function main () {
  // Parse before constructing a client / opening any connection.
  const { distributionId, confirm } = parseArgs(process.argv.slice(2))
  const prisma = new PrismaClient()
  try {
    const summary = await approveCuratorMakeup(prisma, distributionId, { confirm })
    if (summary.refused) {
      console.error(`refused: ${summary.refused}`)
      if (summary.configErrors?.length) {
        console.error(`  config errors: ${summary.configErrors.join(', ')}`)
      }
      process.exitCode = 2
      return
    }
    console.log(`--- distribution ${summary.distributionId} (mode ${summary.mode}) ---`)
    console.log(`  raw T:     ${summary.rawTPiconeros.toString()} pico (~${piconerosToXmr(summary.rawTPiconeros)} XMR)`)
    console.log(`  capped T:  ${summary.cappedTPiconeros.toString()} pico (~${piconerosToXmr(summary.cappedTPiconeros)} XMR)`)
    // multBps is NULL on a valid zero-history (T4 = 0) trip; say so instead of
    // printing a raw null that reads like a bug.
    const multLabel = summary.multBps != null
      ? `${summary.multBps} (this row's effective multiple)`
      : 'n/a (zero-history trip: T4 = 0, no effective multiple)'
    console.log(`  multBps:   ${multLabel}`)
    console.log(`  configured k: ${summary.configuredMultBps} bps (current config)`)
    console.log(`  estimated make-up at the configured k: ${summary.makeupPiconeros.toString()} pico (~${piconerosToXmr(summary.makeupPiconeros)} XMR)`)
    console.log('  the estimate follows the CURRENT config: the next run pays at its own')
    console.log('  configured k, bounded by the pool\'s spend limit and pool — approval is')
    console.log('  never a promised payment.')
    console.log(`  current config mode: ${summary.mode}`)
    if (summary.mode !== 'ACTIVE') {
      console.log('  WARNING: the make-up is recorded but only ACTIVE mode pays it.')
    }
    if (!confirm) {
      console.log('--- dry-run: nothing mutated. Re-run with --confirm to approve. ---')
      return
    }
    console.log('  approved: the immediately following distribution run will pay it once.')
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1]?.endsWith('approve-curator-makeup.js')) {
  main().catch(e => { console.error(e); process.exitCode = 1 })
}
