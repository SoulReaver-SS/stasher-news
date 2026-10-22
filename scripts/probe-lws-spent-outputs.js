// Read-only lws closure-input probe: aggregate sender shapes, candidate amounts,
// and mined-row fees. Empty samples do not establish support; UNSUPPORTED means
// unknown index shapes, PARTIAL means missing closure inputs.
//
//   docker exec -w /app -u apprunner app npx tsx --tsconfig jsconfig.json scripts/probe-lws-spent-outputs.js
//
import { PrismaClient } from '@prisma/client'
import { pathToFileURL } from 'node:url'
import { lwsClient } from '../api/monero/lwsClient.js'

const prisma = new PrismaClient()

const OWN_SENDER_SHAPE = 'nested{sender.maj_i,min_i}'

function shapeOf (so) {
  if (so?.maj_i != null && so?.min_i != null) return 'flat{maj_i,min_i}'
  if (so?.recipient?.maj_i != null && so?.recipient?.min_i != null) return 'nested{recipient.maj_i,min_i}'
  if (so?.sender?.maj_i != null && so?.sender?.min_i != null) return OWN_SENDER_SHAPE
  return `UNSUPPORTED keys=[${Object.keys(so || {}).sort().join(',')}]`
}

// Counts and shapes only; no payload contents.
export function summarizeTransactions (transactions, ownSet) {
  const out = {
    mined: 0,
    minedWithFee: 0,
    minedWithClosureInputs: 0,
    txsWithCandidates: 0,
    ownCandidates: 0,
    ownCandidatesWithAmount: 0,
    shapes: new Map()
  }
  for (const tx of transactions || []) {
    const mined = tx.height != null
    if (mined) out.mined += 1
    let ownWithAmount = 0
    let hasCandidate = false
    for (const so of tx.spent_outputs || []) {
      const shape = shapeOf(so)
      out.shapes.set(shape, (out.shapes.get(shape) || 0) + 1)
      const maj = so?.sender?.maj_i
      const min = so?.sender?.min_i
      if (maj == null || min == null || !ownSet.has(`${maj},${min}`)) continue
      hasCandidate = true
      out.ownCandidates += 1
      if (so.amount != null && /^\d+$/.test(String(so.amount))) {
        out.ownCandidatesWithAmount += 1
        ownWithAmount += 1
      }
    }
    if (hasCandidate) out.txsWithCandidates += 1
    if (mined && tx.fee != null) out.minedWithFee += 1
    // A fee and own-candidate amount in the SAME mined tx: the only sample
    // that can prove closure inputs are present end-to-end.
    if (mined && tx.fee != null && ownWithAmount > 0) out.minedWithClosureInputs += 1
  }
  return out
}

function ownSetOf (account) {
  const set = new Set(['0,0'])
  for (const s of account?.subaddresses || []) set.add(`${s.majorIndex},${s.minorIndex}`)
  return set
}

async function main () {
  try {
    const accounts = await prisma.moneroAccount.findMany({
      where: { status: 'ACTIVE' },
      include: { viewKey: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
    })
    const shapes = new Map()
    const totals = { mined: 0, minedWithFee: 0, minedWithClosureInputs: 0, txsWithCandidates: 0, ownCandidates: 0, ownCandidatesWithAmount: 0, accounts: 0, scanFailures: 0 }
    for (const account of accounts) {
      // Mirror reconcilePendingTips: skip unscannable accounts rather than abort.
      if (!account.viewKey) continue
      let resp
      try {
        resp = await lwsClient.getAddressTxs(account, 0, null)
      } catch (err) {
        // Preserve other samples without exposing key material in error text.
        totals.scanFailures += 1
        console.log(`  account ${account.id}: scan failed (${err?.name ?? 'error'}) — skipped`)
        continue
      }
      const s = summarizeTransactions(resp.transactions || [], ownSetOf(account))
      totals.accounts += 1
      totals.mined += s.mined
      totals.minedWithFee += s.minedWithFee
      totals.minedWithClosureInputs += s.minedWithClosureInputs
      totals.txsWithCandidates += s.txsWithCandidates
      totals.ownCandidates += s.ownCandidates
      totals.ownCandidatesWithAmount += s.ownCandidatesWithAmount
      for (const [shape, count] of s.shapes) shapes.set(shape, (shapes.get(shape) || 0) + count)
    }
    console.log(`scanned ${totals.accounts} ACTIVE account(s) (${totals.scanFailures} scan failure(s)); ${totals.mined} mined tx(s); ` +
      `${totals.minedWithFee} with fee; ${totals.minedWithClosureInputs} with fee + own candidate amount; ` +
      `${totals.txsWithCandidates} tx(s) carry own candidates ` +
      `(${totals.ownCandidates} candidate(s), ${totals.ownCandidatesWithAmount} with a parseable amount)`)
    for (const [shape, count] of [...shapes].sort()) console.log(`  ${shape}: ${count} output(s)`)

    if (shapes.size === 0) {
      if (totals.scanFailures > 0 && totals.mined === 0) {
        console.error('NO-SPENT-OUTPUTS + scan failures: every sampled account failed to scan — the sample is UNRELIABLE,')
        console.error('not merely empty (e.g. a VIEWKEY_MASTER_KEY / env mismatch). Fix the environment and re-run.')
      } else {
        console.log('NO-SPENT-OUTPUTS: no account history contains spends yet (empty sample — proves nothing either way).')
      }
      console.log('  cheapest generator on dev: send any tx OUT of a scanned wallet (e.g. a')
      console.log('  rewards-wallet distribution via ./sndev monero, or a wallet sending to')
      console.log('  its own integrated address — a literal self-send), then re-run.')
      return
    }
    if (!shapes.has(OWN_SENDER_SHAPE)) {
      console.error(`UNSUPPORTED: no ${OWN_SENDER_SHAPE} rows — isSelfSend only reads that shape and`)
      console.error('would silently never match. Adapt the parser to the dumped key sets (or upgrade lws).')
      process.exitCode = 1
      return
    }
    if (totals.mined === 0) {
      console.error('PENDING-ONLY: candidates exist only on mempool rows — no mined fee/amount sample')
      console.error('to validate closure inputs. Re-run after a confirmation.')
      process.exitCode = 1
      return
    }
    if (totals.minedWithClosureInputs === 0) {
      console.error('PARTIAL: no single mined tx carries both a fee and an own-candidate amount —')
      console.error('closure would never fire (every exclusion fails open). Investigate this lws build.')
      process.exitCode = 1
      return
    }
    console.log('SUPPORTED: isSelfSend has indices, amounts, and same-tx mined fees to close on')
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
