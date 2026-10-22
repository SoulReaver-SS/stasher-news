// Retroactively exclude a CONFIRMED self-send missed at detection. Requires
// hash-anchored lws evidence and isSelfSend closure; ring candidates alone
// cannot trigger writes. Reverses ranking and author credit, and writes the
// exclusion signal atomically. Previously granted streaks remain (as on REORGED).
// Dry-run by default; --apply executes.
//
//   docker exec -w /app -u apprunner app npx tsx --tsconfig jsconfig.json \
//     scripts/exclude-confirmed-selfsend.js <tipId> [--apply]
import { Prisma, PrismaClient } from '@prisma/client'
import { pathToFileURL } from 'node:url'
import { lwsClient } from '../api/monero/lwsClient.js'
import { isSelfSend, resolveItemSubName } from '../api/monero/selfTip.js'
import { reverseTip } from '../api/monero/ranking.js'

// A same-PID tx cannot stand in for an anchored hash; PID fallback is legacy-only.
export function findTipTx (transactions, { paymentId, txHash }) {
  const anchoredHash = /^[0-9a-f]{64}$/i.test(String(txHash || ''))
    ? String(txHash).toLowerCase()
    : null
  for (const t of transactions || []) {
    if (anchoredHash && String(t.hash || '').toLowerCase() === anchoredHash) return t
  }
  if (anchoredHash) return null // a named hash missed: the same-pid row is not evidence
  for (const t of transactions || []) {
    if (String(t.payment_id || '').toLowerCase() === String(paymentId || '').toLowerCase()) return t
  }
  return null
}

// Diagnostic values for operators; `closes` is the write gate's verdict, not
// a parallel calculation that could disagree with it.
export function closureEvidence (tx, account) {
  let candidateSum = 0n
  let complete = true
  const own = new Set(['0,0'])
  for (const s of account?.subaddresses || []) own.add(`${s.majorIndex},${s.minorIndex}`)
  for (const so of tx?.spent_outputs || []) {
    const maj = so?.sender?.maj_i
    const min = so?.sender?.min_i
    if (maj == null || min == null || !own.has(`${maj},${min}`)) continue
    if (so?.amount == null || !/^\d+$/.test(String(so.amount))) {
      complete = false
      continue
    }
    candidateSum += BigInt(String(so.amount))
  }
  const fee = tx?.fee == null || !/^\d+$/.test(String(tx.fee)) ? null : BigInt(String(tx.fee))
  const received = tx?.piconeros == null ? null : BigInt(tx.piconeros)
  return { candidateSum: complete ? candidateSum : null, fee, received, closes: isSelfSend(account, tx) }
}

// Injected dependencies keep CLI tests off the live database.
export async function runCli (argv, deps = {}) {
  const [, , tipIdArg, ...rest] = ['', '', ...argv]
  const apply = rest.includes('--apply')
  const log = deps.log ?? (message => console.log(message))
  const logError = deps.logError ?? (message => console.error(message))
  const models = deps.models ?? new PrismaClient()
  const lws = deps.lws ?? lwsClient
  const ownsModels = deps.models == null
  try {
    const tipId = tipIdArg ? BigInt(tipIdArg) : null
    if (tipId == null) {
      logError('usage: exclude-confirmed-selfsend.js <tipId> [--apply]')
      return { status: 'refused', reason: 'usage' }
    }

    const tip = await models.observedTip.findUnique({
      where: { id: tipId },
      include: {
        post: { select: { userId: true } },
        recipientAccount: {
          select: { id: true, label: true, address: true, status: true, viewKey: true, lastTxId: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
        }
      }
    })
    if (!tip) {
      logError(`tip ${tipId}: not found`)
      return { status: 'refused', reason: 'not-found' }
    }
    if (tip.state !== 'CONFIRMED') {
      logError(`tip ${tipId}: state is ${tip.state}, expected CONFIRMED (the confirm-time re-check now handles DETECTED rows automatically)`)
      return { status: 'refused', reason: 'state' }
    }
    const account = tip.recipientAccount
    if (!account?.viewKey || account.status !== 'ACTIVE') {
      logError(`tip ${tipId}: recipient account ${account?.id} is unscannable (no view key / INACTIVE) — verify manually before remediating`)
      return { status: 'refused', reason: 'unscannable' }
    }

    // Full-history scan (no cursor games — this is a one-off): find the tip tx
    // hash-first, then re-verify via the closure-backed isSelfSend.
    const resp = await lws.getAddressTxs(account, 0, null)
    const tx = findTipTx(resp.transactions || [], tip)
    if (!isSelfSend(account, tx)) {
      const ev = closureEvidence(tx, account)
      logError(`tip ${tipId}: lws scan does NOT prove a self-send (tx found: ${!!tx}` +
        `${tx ? `, received=${ev.received ?? 'unavailable'}, ownCandidateSum=${ev.candidateSum ?? 'unavailable'}, fee=${ev.fee ?? 'unavailable'}, closes=${ev.closes}` : ''}) — refusing. ` +
        'Decoy ring references are not evidence; re-verify with scripts/probe-lws-spent-outputs.js shapes in mind.')
      return { status: 'refused', reason: 'no-proof' }
    }
    const ev = closureEvidence(tx, account)
    log(`tip ${tipId}: CONFIRMED self-send VERIFIED — piconeros=${tip.piconeros} rankPiconeros=${tip.rankPiconeros} ` +
      `received=${ev.received} ownCandidateSum=${ev.candidateSum} fee=${ev.fee} closes=${ev.closes}`)

    const authorId = tip.post?.userId
    const credited = account.label !== 'platform_rewards' && authorId != null
    if (!apply) {
      log('dry-run: would EXCLUDE the tip, reverse the ranking delta,' +
        `${credited ? ` decrement user ${authorId} stackedPiconeros by ${tip.piconeros},` : ''} and write the AbuseSignal`)
      log('re-run with --apply to execute')
      return { status: 'dry-run' }
    }

    let claimed = 0
    await models.$transaction(async (txh) => {
      claimed = await txh.$executeRaw`
        UPDATE "ObservedTip"
        SET state = 'EXCLUDED', "exclusionReason" = 'SELF_SEND'::"TipExclusionReason"
        WHERE id = ${tip.id} AND state = 'CONFIRMED'`
      if (claimed > 0) {
        await reverseTip(tip.postId, tip.tipperId, tip.piconeros, tip.rankPiconeros, txh)
        if (credited) {
          await txh.user.update({
            where: { id: authorId },
            data: { stackedPiconeros: { decrement: tip.piconeros } }
          })
        }
        const subName = await resolveItemSubName(tip.postId, txh)
        await txh.abuseSignal.create({
          data: {
            kind: 'SELF_SEND_EXCLUDED',
            subjectUserId: authorId,
            actorUserId: tip.tipperId ?? null,
            tipId: tip.id,
            postId: tip.postId,
            subName,
            piconeros: tip.piconeros,
            txHash: tip.txHash || 'unknown',
            paymentId: tip.paymentId,
            details: {
              note: 'amount recorded as lws reported it (change-output inflation possible)',
              remediation: 'CONFIRMED wash tip excluded retroactively (closure-proven self-send); ranking delta and author credit reversed'
            }
          }
        })
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    if (claimed === 0) {
      log(`tip ${tipId}: claim lost (state changed concurrently) — nothing written`)
      return { status: 'lost-claim' }
    }
    log(`tip ${tipId}: EXCLUDED, ranking delta reversed,${credited ? ` author ${authorId} credit reversed,` : ''} AbuseSignal written`)
    return { status: 'excluded' }
  } finally {
    if (ownsModels && typeof models.$disconnect === 'function') {
      try { await models.$disconnect() } catch { /* never mask the run's outcome */ }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2))
    .then(out => {
      if (out?.status === 'refused') process.exitCode = 1
    })
    .catch(err => {
      console.error(err)
      process.exitCode = 1
    })
}
