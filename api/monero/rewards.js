import { daemonClient } from '@/api/monero/daemonClient'
import { logInfo, logWarn, logError } from '@/lib/logger'
import { alert } from '@/lib/alert'
import { moneroRewardsWalletBalancePiconeros } from '@/lib/metrics'
import { opsCarry, standingReserve, sweepDebitLimit, walletScope } from '@/lib/rewardsAccounting'
import { readNextRewardsPool } from '@/lib/rewardsPool'
import { readRewardsInflow } from '@/api/monero/rewardsInflow'
import { readRewardsWalletLedger } from '@/api/monero/rewardsLedger'
import { planPartialAccountSends } from '@/api/monero/rewardsPlan'
import {
  assertWalletScope,
  errorLabel,
  prepareWalletTransaction,
  relayWalletTransaction,
  reconcileWalletTransactions
} from '@/api/monero/rewardsTransactions'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { withRewardsPhase } from '@/worker/rewardsPhase'

// Rewards hot-wallet signer (Phase 4 Task 9 / design spec §5.6, §6.2).
//
// The ONLY component in the running stack that holds the platform rewards
// wallet's SPEND key. It opens a full (spend-capable) MoneroWalletWasm from the
// view+spend keys in env (kept in memory for the worker process lifetime), then
// sends each QUEUED RewardPayout as a real on-chain Monero tx, records the tx
// hash, and flips the payout QUEUED -> SENT (confirmFinalizer later matures
// SENT -> CONFIRMED at N confirmations).
//
// Fund-safety rules (see task-9 brief + design spec):
//   - keys are read from env and NEVER logged / serialized;
//   - sending requires UNLOCKED funds — recently-received outputs are locked
//     ~10 blocks, so an insufficient unlocked balance is a SKIP (payout stays
//     QUEUED, retried next run), NOT a FAILED (FAILED is for hard errors only);
//   - a hard createTx error marks the batch FAILED, but the funds stay in the
//     wallet (no loss of principal); a CRITICAL alert + manual reconciliation
//     re-enters them into a future pool (FAILED payouts are counted in
//     distributedPiconeros, so they do not auto-roll into next week's pool);
//   - a pre-relay "tx not possible" build failure is a retryable SKIP: the whole
//     bucket stays QUEUED (nothing was broadcast — double-pay-safe) and the
//     next drive re-sends; recovery consolidation only fires when it can
//     actually help (see sendPayouts);
//   - every relayed bucket/consolidation is journaled BEFORE its relay (Task 6
//     boundary); an attempted-but-unproven relay is never blindly re-sent and
//     never marks a recipient FAILED — it is resolved only from exact-hash
//     wallet history. During genuine shortage the largest affordable whole
//     payouts are sent and the remainder stays an explicit QUEUED debt;
//
// Daemon = monerod (MONEROD_URL), NOT lws: signing needs real ringCT decoys
// which the light wallet scanner cannot serve.

const RESTORE_HEIGHT_MARGIN = 1000

// Accounts on the rewards wallet the signer can spend from: 0 = primary
// (downvote payment-ID inflow + consolidated funds), 1..5 = fee-pool majors
// (api/monero/feePool.js REWARDS_*_MAJOR: 1 posting, 2 territory, 3 donate,
// 4 tip-unwalleted, 5 boost). Local const, not an import from feePool.js —
// that module creates a Prisma client at import time and this module is
// unit-tested without one.
const SIGNER_ACCOUNTS = [0, 1, 2, 3, 4, 5]

// Dust floor for the weekly ops sweep to cold storage: sweep only leaves the
// hot wallet with at least this much unlocked, and only fires if the target
// clears it. 0.001 XMR default (spec §6.4 / task B3).
const REWARDS_OPS_SWEEP_MIN_PICONEROS = BigInt(process.env.REWARDS_OPS_SWEEP_MIN_PICONEROS || '1000000000')

// Consolidate only funded fee accounts above this dust floor — sweeping a
// near-empty account just burns a tx fee (or throws on dust), and the throw
// fired a spurious per-account CRITICAL. Fixed 0.0001 XMR (audit #4).
const CONSOLIDATION_MIN_PICONEROS = 100_000_000n

// Per-tx fee headroom for signer sends: the ops sweep retries a full-balance
// send at amount minus this step when the real fee pushes it over, and payout
// packing reserves this much per account so packed buckets leave fee room.
// 0.001 XMR default comfortably covers default-priority Monero fees.
const TX_FEE_HEADROOM_PICONEROS = BigInt(process.env.REWARDS_TX_FEE_HEADROOM_PICONEROS || '1000000000')

let walletPromise = null

// The separate TX-proof key registry, read lazily per send. Importing the
// module never needs a configured registry; a missing/misconfigured one fails
// pair sealing (and therefore preparation) CLOSED — there is deliberately no
// other key or view-key fallback.
const paymentProofKeys = () => createPaymentProofKeyProvider(process.env)

// Resolve a pair-preparation outcome. A THROWN preparation result is never
// "no journal exists": an unknown commit can contain a complete pair, so the
// dispatch stays withheld until ONE fresh DB/pair read (idempotent
// re-preparation) resolves it — a fresh authentic pair read re-authorizes the
// dispatch; a failing read never proves the pair absent and the caller keeps
// the same-dispatch send suppressed (nothing is relayed either way: the relay
// barrier only opens after an acknowledged preparation).
async function prepareDispatchResolved ({ context, prepare, message }) {
  try {
    return await prepare()
  } catch (err) {
    logError({ ...context, errorClass: errorLabel(err) }, `${message} — commit outcome unknown; resolving with one fresh pair read (no relay either way)`)
    return await prepare()
  }
}

// Singleton: opens + syncs the wallet once, memoizing the promise so every
// sendPayouts call reuses the same in-memory wallet. A cached rejection is
// cleared so a later call can retry instead of failing forever.
export async function getRewardsWallet (models) {
  if (!walletPromise) {
    walletPromise = openRewardsWallet(models).catch(err => {
      walletPromise = null
      throw err
    })
  }
  return walletPromise
}

// A wallet restored from keys only scans subaddresses it has explicitly
// derived, so before the first sync the signer mirrors the fee-pool shape:
// accounts 1..5 plus each major's subaddresses up to the pool's max minor
// (SubaddressIndex rows for platform_rewards). Derivation is deterministic
// (same keys), so this only makes the wallet SEE its own funds — it moves
// nothing. Exported for tests. No-ops with a warning when models is
// unavailable (send paths then behave account-0-only, like before this fix).
//
// `includeAvailable` is the read-only AUDIT variant (rewards accounting repair
// §8 / Task 12): the reconciliation must derive EVERY recorded SubaddressIndex
// minor, including AVAILABLE rows, before comparing derived addresses against
// the DB. The send path keeps the default (assigned minors only), so send-time
// scope/restore behavior is unchanged.
export async function ensureFeeAccounts (wallet, models, { includeAvailable = false } = {}) {
  if (!models?.$queryRaw) {
    logWarn('rewards signer: models unavailable at wallet open — skipping fee-account mirroring (account-0-only)')
    return
  }
  const maxMajor = Math.max(...SIGNER_ACCOUNTS)
  const accounts = await wallet.getAccounts()
  for (let i = accounts.length; i <= maxMajor; i++) {
    await wallet.createAccount()
  }
  const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  const rows = await models.$queryRaw`
    SELECT si."majorIndex" AS major, COALESCE(MAX(si."minorIndex"), 0)::int AS "maxMinor"
    FROM "SubaddressIndex" si
    JOIN "MoneroAccount" ma ON si."accountId" = ma.id
    WHERE ma.label = 'platform_rewards' AND ma.network::text = ${network}
      AND (${includeAvailable}::boolean OR si.state <> 'AVAILABLE')
    GROUP BY si."majorIndex"`
  for (const r of rows) {
    const major = Number(r.major)
    if (major < 1 || major > maxMajor) continue
    const subs = await wallet.getSubaddresses(major)
    for (let minor = subs.length; minor <= r.maxMinor; minor++) {
      await wallet.createSubaddress(major)
    }
  }
}

async function openRewardsWallet (models) {
  const primaryAddress = process.env.PLATFORM_REWARDS_ADDRESS
  const privateSpendKey = process.env.PLATFORM_REWARDS_SPEND_KEY
  const privateViewKey = process.env.PLATFORM_REWARDS_VIEW_KEY
  if (!primaryAddress || !privateSpendKey || !privateViewKey) {
    throw new Error('rewards signer: PLATFORM_REWARDS_ADDRESS, PLATFORM_REWARDS_SPEND_KEY, and PLATFORM_REWARDS_VIEW_KEY must be configured')
  }

  const moneroTs = await import('monero-ts')
  const api = moneroTs.default || moneroTs
  const networkType = resolveNetworkType(api, process.env.MONERO_NETWORK)
  const serverUri = process.env.MONEROD_URL || 'http://monerod:38081'

  // Restore height (mirrors resolveBountyEscrowRestoreHeight in
  // api/monero/bounties.js): REWARDS_SCAN_FROM_HEIGHT wins; otherwise derive
  // one that covers the earliest recorded inflow (FeeObservation covers the
  // fee-pool accounts, ObservedDownvote covers account 0 — the wallet must see
  // its inflow, or payout batches skip forever with a silent ~0 unlocked
  // balance). Any fallback is a loud CRITICAL so ops notices. When the env var
  // is set the env path is untouched: no DB/daemon calls, no alert.
  const envHeight = Number(process.env.REWARDS_SCAN_FROM_HEIGHT) || 0
  let earliestInflowHeight = null
  let daemonHeight = null
  if (!envHeight) {
    if (models?.feeObservation) {
      try {
        const [feeAgg, downvoteAgg] = await Promise.all([
          models.feeObservation.aggregate({ _min: { height: true } }),
          models.observedDownvote.aggregate({ _min: { height: true } })
        ])
        const heights = [feeAgg._min.height, downvoteAgg._min.height].filter(h => h != null)
        if (heights.length > 0) earliestInflowHeight = Math.min(...heights)
      } catch { /* DB down — fall through to the daemon-margin fallback */ }
    }
    try { daemonHeight = await daemonClient.getHeight() } catch { /* daemon down — genesis scan */ }
  }
  const { restoreHeight, source } = resolveRewardsRestoreHeight({ envHeight, earliestInflowHeight, daemonHeight })
  if (source !== 'env') {
    alert('critical', 'rewards signer scan-from-height fallback',
      `REWARDS_SCAN_FROM_HEIGHT is 0/unset; opening the rewards wallet from height ${restoreHeight} (${source}). Set REWARDS_SCAN_FROM_HEIGHT below the earliest inflow to avoid invisible-funds payout skips.`,
      { dedupeKey: 'rewards-scan-height-fallback' })
  }

  // In-memory wallet (no `path`): reopened from keys each worker boot, so there
  // is no on-disk wallet file to conflict on restart.
  // password is a required-but-meaningless placeholder for an in-memory wallet
  // (no `path`, so nothing is persisted/encrypted to decrypt) — NOT a secret.
  const wallet = await api.createWalletFull({
    password: 'platform-rewards-signer',
    networkType,
    primaryAddress,
    privateSpendKey,
    privateViewKey,
    restoreHeight,
    server: { uri: serverUri },
    proxyToWorker: false
  })
  await ensureFeeAccounts(wallet, models)
  // wallet-initial-sync: the dominant cost of a cold open (restore-height scan,
  // minutes to hours). Timed so a long weekly run can be attributed here rather
  // than read as a hang. Wrapping in place preserves the error identity.
  await withRewardsPhase('wallet-initial-sync', () => wallet.sync())
  return wallet
}

// Resolve the rewards signer wallet's restore height. REWARDS_SCAN_FROM_HEIGHT
// wins when set; otherwise derive a height covering the earliest recorded
// inflow (the signer must always see its fees, or payout batches skip forever
// with a silent ~0 unlocked balance), falling back to a daemon-height margin
// and finally genesis. Exported for tests; the wallet opener alerts loudly on
// any non-env source.
export function resolveRewardsRestoreHeight ({ envHeight, earliestInflowHeight, daemonHeight }) {
  if (envHeight > 0) return { restoreHeight: envHeight, source: 'env' }
  if (earliestInflowHeight != null) {
    return { restoreHeight: Math.max(0, earliestInflowHeight - RESTORE_HEIGHT_MARGIN), source: 'earliest-inflow' }
  }
  if (daemonHeight != null) {
    return { restoreHeight: Math.max(0, daemonHeight - RESTORE_HEIGHT_MARGIN), source: 'daemon-margin' }
  }
  return { restoreHeight: 0, source: 'genesis' }
}

function resolveNetworkType (api, env) {
  const n = String(env || 'stagenet').toLowerCase()
  if (n === 'mainnet') return api.MoneroNetworkType.MAINNET
  if (n === 'testnet') return api.MoneroNetworkType.TESTNET
  return api.MoneroNetworkType.STAGENET
}

// Send a batch of RewardPayout rows split across the wallet's signer accounts:
// unlocked balances are aggregated over accounts 0 + fee pools 1-5, whole
// payouts are packed largest-first onto the accounts that can host them, and
// each account's slice goes out as ONE multi-output on-chain tx. Planning
// prefers the existing fee-reserved complete plan, then the same complete plan
// unreserved (validated by the real createTx fee), then a deterministic
// largest-first partial plan: during genuine shortage the largest affordable
// whole rewards are sent NOW and the remainder stays an explicit QUEUED debt
// (Earn rows, distributedPiconeros and rolledOverPiconeros are never touched).
//
// Every bucketed relay follows the Task 6 journal boundary: build with
// relay:false -> durable immutable PREPARED row -> claim the attempt with a CAS
// -> relay the SAME object -> RELAYED. Journal reconciliation runs before live
// rows are selected; unresolved journal PAYOUT attempts are excluded this run
// (never falling through the older recipient-history fail-open branch for
// them), and an unreadable journal is fail-closed (no fresh sends). A proven
// relay always persists the recipient principal, even when the journal fee
// state could not be persisted; an uncertain attempt leaves recipients QUEUED
// until a fresh confirmed verification resolves it and it is never blindly re-relayed.
//
// Each account's batch is built create-then-relay: createTx({ relay: false })
// constructs + validates the tx (including its real fee) WITHOUT moving funds.
// When the fee pushes a bucket over the account's unlocked balance, the
// smallest payout is dropped and the bucket rebuilt — dropped payouts stay
// QUEUED (resumable). A retryable "tx not possible" is a whole-bucket skip with
// its diagnostic dump. After a reduced bucket builds, still-unassigned payouts
// get one true-fee fill attempt each (largest first) against the residual
// capacity after the built fee, without claiming global bin packing. A payout
// is never split across txs and never assigned to two buckets.
//
// Fund-safety (unchanged): a hard createTx error marks the batch FAILED, but
// the funds stay in the wallet (no loss of principal); a CRITICAL alert +
// manual reconciliation re-enters them into a future pool. Insufficient
// unlocked balance (likely locked ~10-block outputs) is a SKIP: rows stay
// QUEUED and are retried next run.
//
// `wallet` is injectable so the logic is unit-testable without the real
// keys/wallet; production leaves it unset and uses the getRewardsWallet()
// singleton.
//
// Returns { sent, failed, skipped, unpersisted, accountingUnpersisted }:
//   - sent: payouts proven relayed (fresh or reconciled from wallet history);
//   - failed: payouts a hard createTx error marked FAILED (funds stayed);
//   - skipped: everything not sent this run (shortage, fee fit, retryable
//     build, unresolved journal/history uncertainty) — remains QUEUED;
//   - unpersisted: RELAYED recipients whose payout-row persist failed twice
//     (relayed-but-unpersisted principal — never a silent COMPLETE);
//   - accountingUnpersisted: unresolved rewards-wallet fee/journal accounting
//     items (proven-but-unpersisted journal state, attempted-but-unproven
//     relays, unsettled consolidation/sweep attempts) — additive to the
//     existing resumability guards.
export async function sendPayouts (payouts, { models, wallet } = {}) {
  const queued = (payouts || []).filter(p => p.state === 'QUEUED')
  if (queued.length === 0) return { sent: 0, failed: 0, skipped: 0, unpersisted: 0, accountingUnpersisted: 0 }

  const w = wallet || await getRewardsWallet(models)
  // Incremental sync: the singleton rewards wallet syncs once at open; without a
  // refresh here the unlocked-balance read below sees the stale cached view, and
  // a stale LOW balance skips the ENTIRE weekly batch (same root cause as the
  // bounties fee-retry stall, 2026-08-19/20). sync() is incremental from the
  // wallet's last processed height, and this only runs in the weekly
  // rewardsDistributor cron — never a web hot path. A sync error propagates to
  // finalizeDistribution (FAILED + CRITICAL, resumable next run) exactly like
  // the balance read. Timed as wallet-incremental-sync (Finding 3).
  await withRewardsPhase('wallet-incremental-sync', () => w.sync())

  // Journal recovery runs BEFORE live-row selection: the wallet must prove it
  // is the configured rewards wallet (accounting authority), and every
  // attempted-but-unproven payout relay must be excluded from fresh sends. A
  // journal or scope read failure is fail-CLOSED: no fresh build, no relay.
  const scope = walletScope()
  await assertWalletScope(w, scope)
  let journalSafety
  try {
    journalSafety = await reconcileWalletTransactions({ models, wallet: w, scope })
  } catch (err) {
    logError({ errorClass: errorLabel(err) }, 'sendPayouts: CRITICAL — journal safety unavailable; refusing fresh sends (fail-closed)')
    return { sent: 0, failed: 0, skipped: queued.length, unpersisted: 0, accountingUnpersisted: 1 }
  }

  // Recipient-history reconciliation (existing guard): a row whose tx already
  // left the wallet is flipped SENT, never re-sent; a row whose safety cannot
  // be proven (DB read failed) is skipped this run. Journal-uncertain IDs are
  // withheld from this pass entirely — its address/amount match must never
  // resolve them; only the journal's exact-hash rule can. Members RECOVERED
  // from a durable RELAYED journal proof are already SENT (or become SENT in
  // the same call): they are counted as sent and excluded from fresh sends
  // even when wallet history is unreadable.
  const journalUncertain = new Set(journalSafety.uncertainPayoutIds)
  const journalRecovered = new Set((journalSafety.recoveredPayoutIds || []).map(recovered => recovered.id))
  const recoveredRows = queued.filter(p => journalRecovered.has(p.id))
  const journalExcluded = queued.filter(p => journalUncertain.has(p.id))
  const recon = await reconcileUnpersistedPayouts(
    w, models,
    queued.filter(p => !journalUncertain.has(p.id) && !journalRecovered.has(p.id))
  )
  const live = queued.filter(p => !journalUncertain.has(p.id) && !journalRecovered.has(p.id) && !recon.excluded.includes(p))
  let accountingUnpersisted = (journalSafety.accountingUnpersisted || 0) +
    (journalSafety.uncertainSweep ? 1 : 0) + journalExcluded.length
  if (recoveredRows.length > 0) {
    logInfo({
      reason: 'durable-relayed-recovery',
      payoutIds: recoveredRows.map(p => p.id),
      piconeros: recoveredRows.reduce((acc, p) => acc + p.piconeros, 0n).toString()
    }, 'sendPayouts: recovered relayed-but-unpersisted recipients from the durable journal (no re-send)')
  }
  if (journalExcluded.length > 0) {
    logWarn({
      reason: 'unresolved-journal-attempt',
      payoutIds: journalExcluded.map(p => p.id),
      piconeros: journalExcluded.reduce((acc, p) => acc + p.piconeros, 0n).toString()
    }, 'sendPayouts: accounting exclusions — attempted-but-unproven journal relays stay QUEUED (no fresh build)')
  }
  // Accounting exclusions carry explicit IDs/amounts/reasons (spec §6 audit):
  // rows whose recorded-hash safety lookup failed stay QUEUED too. The
  // reconciled rows are money that already moved, not exclusions.
  const unprovableHistory = recon.excluded.filter(p => !recon.reconciled.includes(p))
  if (unprovableHistory.length > 0) {
    logInfo({
      reason: 'unprovable-history',
      payoutIds: unprovableHistory.map(p => p.id),
      piconeros: unprovableHistory.reduce((acc, p) => acc + p.piconeros, 0n).toString()
    }, 'sendPayouts: accounting exclusions — payout history could not prove safety; rows stay QUEUED')
  }
  if (live.length === 0) {
    return {
      sent: recon.reconciled.length + recoveredRows.length,
      failed: 0,
      skipped: recon.skipped + journalExcluded.length,
      unpersisted: recon.unpersisted,
      accountingUnpersisted
    }
  }

  // Aggregate unlocked balance across ALL signer accounts (0 + fee pools 1-5):
  // the weekly pool physically sits in the fee-pool accounts, so an
  // account-0-only read can never cover the batch (the 2026-08-24 never-sends
  // bug). No whole-wallet sum pre-filter: genuine shortage is handled by the
  // partial plan below, which still sends every whole payout a single account
  // can host.
  const unlockedByAccount = {}
  let totalUnlocked = 0n
  for (const idx of SIGNER_ACCOUNTS) {
    const bal = BigInt(await w.getUnlockedBalance(idx))
    unlockedByAccount[idx] = bal
    totalUnlocked += bal
  }

  // Plan preference: fee-reserved complete plan -> complete plan with real
  // createTx validation -> deterministic largest-first partial plan. The
  // partial plan deliberately uses UNRESERVED capacity so an affordable
  // largest whole payout is never blocked by conservative headroom; the real
  // fee is then validated by createTx (drop-smallest rebuild + true-fee fills).
  let buckets = planAccountSends(live, unlockedByAccount, TX_FEE_HEADROOM_PICONEROS)
  let plannerSkipped = []
  if (!buckets) {
    buckets = planAccountSends(live, unlockedByAccount, 0n)
  }
  if (!buckets) {
    const partial = planPartialAccountSends(live, unlockedByAccount, 0n)
    buckets = partial.buckets
    plannerSkipped = partial.skipped
  }

  let sent = 0
  let failed = 0
  let skipped = 0
  let unpersisted = 0
  let sentPiconeros = 0n
  let retryableBuildFailure = false
  const buildOmitted = []
  const retryableOmitted = []
  const filledIds = new Set()
  const attemptedFillIds = new Set()
  // Unassigned whole payouts eligible for ONE true-fee fill attempt each,
  // shared across buckets so no payout is ever assigned to two of them.
  const fillPool = [...plannerSkipped]

  for (const bucket of buckets) {
    const r = await relayBucketTx(w, models, bucket.accountIndex, bucket.payouts, {
      unlockedAtPlan: unlockedByAccount[bucket.accountIndex],
      fillPool,
      attemptedFillIds,
      scope
    })
    sent += r.sent.length
    failed += r.failed
    skipped += r.skipped.length
    unpersisted += r.unpersisted
    accountingUnpersisted += r.accountingUnpersisted
    sentPiconeros += r.sent.reduce((acc, p) => acc + p.piconeros, 0n)
    if (r.retryableBuildFailure) retryableBuildFailure = true
    buildOmitted.push(...(r.dropped || []))
    retryableOmitted.push(...(r.retryableSkipped || []))
    for (const p of r.filled || []) filledIds.add(p.id)
  }

  // A planner-skipped row is omitted only if no bucket ever attempted to fill
  // it: attempted-and-accepted rows are already counted sent, attempted-and-
  // rejected rows are counted in their bucket's skipped/dropped (never twice).
  const plannerOmitted = plannerSkipped.filter(p => !filledIds.has(p.id) && !attemptedFillIds.has(p.id))
  skipped += plannerOmitted.length
  skipped += recon.skipped + journalExcluded.length
  unpersisted += recon.unpersisted
  sent += recon.reconciled.length + recoveredRows.length
  sentPiconeros += recon.reconciled.reduce((acc, p) => acc + p.piconeros, 0n)
  sentPiconeros += recoveredRows.reduce((acc, p) => acc + p.piconeros, 0n)

  // Audit the unpaid remainder with explicit IDs, amounts and reasons,
  // separately per class (spec §6): planner omissions (no account capacity),
  // build omissions (real fee fit), retryable build omissions (pre-relay "tx
  // not possible"), and accounting exclusions (journal/history uncertainty,
  // logged above). Exact decimal strings only — pino cannot serialize BigInt.
  if (plannerOmitted.length > 0) {
    logInfo({
      reason: 'insufficient-funds',
      payoutIds: plannerOmitted.map(p => p.id),
      piconeros: plannerOmitted.reduce((acc, p) => acc + p.piconeros, 0n).toString(),
      capacities: Object.fromEntries(Object.entries(unlockedByAccount).map(([idx, bal]) => [idx, bal.toString()])),
      feeReserve: TX_FEE_HEADROOM_PICONEROS.toString()
    }, 'sendPayouts: planner omissions — no single account can host these whole payouts this run (stay QUEUED)')
  }
  if (buildOmitted.length > 0) {
    logInfo({
      reason: 'fee-fit',
      payoutIds: buildOmitted.map(p => p.id),
      piconeros: buildOmitted.reduce((acc, p) => acc + p.piconeros, 0n).toString()
    }, 'sendPayouts: build omissions — the real fee dropped these whole payouts this run (stay QUEUED)')
  }
  if (retryableOmitted.length > 0) {
    logInfo({
      reason: 'retryable-build',
      payoutIds: retryableOmitted.map(p => p.id),
      piconeros: retryableOmitted.reduce((acc, p) => acc + p.piconeros, 0n).toString()
    }, 'sendPayouts: retryable build omissions — the account build failed pre-relay; these whole payouts stay QUEUED')
  }

  // Consolidation is useful-recovery only: a retryable pre-relay build failure,
  // or an unassigned payout no single account can cover but the aggregate can
  // after conservative consolidation/payout fees. Use the FRESH post-payout
  // balances — the same balances the sweep itself will read — because the
  // plan-time snapshot predates this drive's spends and would authorize sweeps
  // that cannot cure the remainder. A true aggregate shortage never
  // consolidates: repeated shortage runs must not burn repeated needless sweep
  // fees (spec §6). No recovery candidates means no extra balance reads.
  const unassigned = [...plannerOmitted, ...buildOmitted, ...retryableOmitted]
  let consolidationNeeded = retryableBuildFailure
  if (!consolidationNeeded && unassigned.length > 0) {
    const freshUnlocked = {}
    for (const idx of SIGNER_ACCOUNTS) freshUnlocked[idx] = BigInt(await w.getUnlockedBalance(idx))
    consolidationNeeded = consolidationCanHelp(unassigned, freshUnlocked)
  }
  if (consolidationNeeded) {
    const consolidation = await consolidateFeeAccounts(w, models, scope, {
      reason: retryableBuildFailure ? 'retryable-build-failure' : 'oversized-payout'
    })
    accountingUnpersisted += consolidation.accountingFailures
  }

  setBalanceGauge(models, totalUnlocked - sentPiconeros)
  return { sent, failed, skipped, unpersisted, accountingUnpersisted }
}

// Can consolidation actually help an unassigned payout? Only when a payout no
// single account can cover (with its conservative fee allowance) is still
// coverable from the aggregate after paying a conservative fee per swept fee
// account plus the payout's own allowance. Unsweepable dust cannot be
// recovered, so only the primary account and fee accounts at/above the dust
// floor count toward recoverable funds. Gates the recovery sweep so a plain
// aggregate shortage never burns fees it cannot cure.
function consolidationCanHelp (unassigned, unlockedByAccount) {
  if (unassigned.length === 0) return false
  const balances = Object.entries(unlockedByAccount)
    .map(([idx, value]) => ({ accountIndex: Number(idx), unlocked: BigInt(value) }))
  const maxAccount = balances.reduce((max, b) => (b.unlocked > max ? b.unlocked : max), 0n)
  const oversized = unassigned.filter(p => p.piconeros + TX_FEE_HEADROOM_PICONEROS > maxAccount)
  if (oversized.length === 0) return false
  const recoverable = balances
    .filter(b => b.accountIndex === 0 || b.unlocked >= CONSOLIDATION_MIN_PICONEROS)
    .reduce((acc, b) => acc + b.unlocked, 0n)
  const sweepable = balances.filter(b => b.accountIndex !== 0 && b.unlocked >= CONSOLIDATION_MIN_PICONEROS).length
  const conservativeCosts = BigInt(sweepable + 1) * TX_FEE_HEADROOM_PICONEROS
  return oversized.some(p => p.piconeros <= recoverable - conservativeCosts)
}

// A payout can be relayed on-chain yet fail BOTH DB persists: the row stays
// QUEUED while the money moved, so a blind re-drive would DOUBLE PAY. Before
// sending, reconcile each QUEUED payout against the wallet's own outgoing
// history: an outgoing tx with a destination matching (recipientAddress,
// exact piconeros) whose hash is NOT recorded on any SENT/CONFIRMED payout
// row must be this payout's lost relay — flip it SENT with that hash instead
// of re-sending. The recorded-hash exclusion keeps prior weeks' payouts to
// the same curator (same address, coincidentally equal amount) from
// false-matching.
//
// Three mutually exclusive outcomes per row:
//   - reconciled: an outgoing match WAS found — money already moved in a
//     prior run — so the row counts as sent and is never re-sent. When the
//     persist STILL fails, `persistSentPayouts` returns 1 and the row is
//     additionally counted in `unpersisted` so the distribution goes
//     FAILED-resumable, never COMPLETE with an unrecorded relay.
//   - skipped: the recorded-hash lookup itself threw (DB unreadable, safety
//     unprovable) — fail CLOSED: excluded from this run's sends (a re-send of
//     an already-relayed tx is a real double pay); the next run with a
//     healthy DB reconciles it.
//   - otherwise: no match and a healthy lookup — the row stays live and sends
//     normally.
//
// Returns { reconciled, excluded, unpersisted, skipped }: `reconciled` is the
// array of matched rows (counted as sent by the caller), `excluded` carries
// every row that must NOT be sent this run (matched + unprovable, filtered by
// identity), and `unpersisted`/`skipped` are counts threaded into the send
// summary's resumability guard.
async function reconcileUnpersistedPayouts (w, models, queued) {
  const empty = { reconciled: [], excluded: [], unpersisted: 0, skipped: 0 }
  if (typeof w.getOutgoingTransfers !== 'function' ||
    typeof models.rewardPayout?.findMany !== 'function') return empty
  let outgoing = []
  try {
    outgoing = (await w.getOutgoingTransfers()) || []
  } catch (err) {
    logWarn({ errorClass: errorLabel(err) }, 'sendPayouts: outgoing-history query failed — skipping reconciliation')
    return empty
  }
  if (outgoing.length === 0) return empty
  const reconciled = []
  const excluded = []
  let unpersisted = 0
  let skipped = 0
  for (const payout of queued) {
    let recorded
    try {
      recorded = await models.rewardPayout.findMany({
        where: {
          recipientAddress: payout.recipientAddress,
          piconeros: payout.piconeros,
          state: { in: ['SENT', 'CONFIRMED'] }
        },
        select: { txHash: true }
      })
    } catch {
      // Cannot prove safety — fail CLOSED: never re-send this run; the next
      // run (healthy DB) reconciles it. Counted `skipped` so the distribution
      // goes FAILED-resumable.
      skipped += 1
      excluded.push(payout)
      continue
    }
    const recordedHashes = new Set((recorded || []).map(r => r.txHash).filter(Boolean))
    const match = outgoing.find(t => {
      const tx = t.getTx?.()
      const hash = toTxHash(tx?.getHash?.())
      if (!hash || recordedHashes.has(hash)) return false
      // A built-but-unrelayed cached tx (or one whose relay outcome is
      // unresolved) is NOT evidence that money moved; without this guard a
      // fresh journal preparation failure would reconcile its unrelayed tx as
      // SENT. Legacy entries exposing neither flag keep pre-journal behavior.
      if (!isRelayEvidence(tx)) return false
      return (t.getDestinations() || []).some(
        d => d.getAddress() === payout.recipientAddress && BigInt(d.getAmount()) === payout.piconeros)
    })
    if (match) {
      const txHash = toTxHash(match.getTx().getHash())
      logInfo({ payoutId: payout.id, txHash }, 'sendPayouts: reconciled relayed-but-unpersisted payout from wallet history (no re-send)')
      unpersisted += await persistSentPayouts([payout], txHash, models)
      reconciled.push(payout)
      excluded.push(payout)
    }
  }
  return { reconciled, excluded, unpersisted, skipped }
}

// Incident diagnostics (2026-09-28 handoff, tiers 1+2): when a pre-relay build
// fails with the "tx not possible" class, capture the wallet's view AT THE
// FAILURE INSTANT plus the plan-time unlocked snapshot, so the next occurrence
// can discriminate the four hypotheses: fee-estimate spike (needed = sum +
// est_fee > unlocked), plan->build state change, wallet/daemon height
// divergence, balance-vs-spendable output disagreement. Every read is
// individually guarded — a diagnostic must NEVER break the payout flow — and
// every BigInt is stringified (pino cannot serialize BigInt). Absent getOutputs
// reads as null; a throwing or absent method otherwise reports 'read-failed: <msg>'.
async function dumpBuildFailureState (w, accountIndex, unlockedAtPlan) {
  const guard = async (fn) => {
    try {
      const v = await fn()
      return v === undefined || v === null ? null : v
    } catch {
      // Fixed diagnostic only: a wallet/daemon exception's message/name/props
      // are NOT copied into the dump (the shared logger has no redaction).
      return 'read-failed'
    }
  }
  const unlockedNow = await guard(async () => String(BigInt(await w.getUnlockedBalance(accountIndex))))
  const totalBalance = await guard(async () => String(BigInt(await w.getBalance(accountIndex))))
  const walletHeight = await guard(() => w.getHeight())
  const daemonHeight = await guard(() => daemonClient.getHeight())
  const unspentOutputs = await guard(async () => {
    if (typeof w.getOutputs !== 'function') return null
    const rows = (await w.getOutputs({ accountIndex, isSpent: false })) || []
    return { count: rows.length, sumPiconeros: String(rows.reduce((acc, o) => acc + BigInt(o.getAmount()), 0n)) }
  })
  return {
    unlockedNow,
    totalBalance,
    walletHeight,
    daemonHeight,
    unspentOutputs,
    unlockedAtPlan: unlockedAtPlan === undefined ? null : String(BigInt(unlockedAtPlan))
  }
}

// Drop priority: the smallest amount first, and among equal smallest amounts
// the HIGHEST payout ID (planner ties otherwise order by lowest ID), so two
// equal rewards that cannot jointly cover the fee keep the earliest payout.
function dropSmallestIndex (rows) {
  return rows.reduce((mi, p, i, arr) => {
    if (p.piconeros < arr[mi].piconeros) return i
    if (p.piconeros === arr[mi].piconeros && p.id > arr[mi].id) return i
    return mi
  }, 0)
}

const byLargestPayout = (a, b) => (a.piconeros > b.piconeros ? -1 : a.piconeros < b.piconeros ? 1 : a.id - b.id)

// Build ONE account's batch (create-then-relay base): createTx({relay:false})
// constructs + validates the tx including its real fee WITHOUT moving funds.
// Three bounded phases (no unbounded loops, no revisits of rejected rows):
//   1. planned members with drop-smallest rebuilds when the real fee overflows
//      the account — dropped members stay QUEUED;
//   2. if the bucket drained without a transaction, still-unassigned whole
//      payouts are validated largest-first (one attempt each) so an affordable
//      smaller reward is never lost behind a larger row that overdrew its fee;
//   3. once a tx exists, ONE true-fee fill attempt per remaining unassigned row
//      against the residual capacity after the built fee (iterating a snapshot,
//      so splicing an accepted row never skips the next candidate).
// A retryable "tx not possible" always skips the whole bucket (no tx exists)
// with the incident diagnostic dump. Hard errors on planned members mark them
// FAILED; a hard error on a fill candidate marks ONLY that candidate FAILED
// (funds stayed) while the valid base transaction is kept.
// Returns { tx, batch, dropped, failed, filled, retryableSkipped,
// retryableBuildFailure }: `batch` is the row list of the built tx, `dropped`
// are fee-fit rows that stay QUEUED, `failed` are rows to persist FAILED,
// `retryableSkipped` are QUEUED rows skipped by the retryable build failure,
// and `filled` are the accepted fill candidates.
async function buildBucketBatch (w, accountIndex, payouts, { unlockedAtPlan, fillPool = [], attemptedFillIds = new Set() } = {}) {
  const batch = [...payouts]
  const dropped = []
  const failed = []
  const filled = []
  let retryableSkipped = []
  let retryableBuildFailure = false
  let tx = null

  while (batch.length > 0) {
    try {
      tx = await w.createTx({
        accountIndex,
        destinations: batch.map(p => ({ address: p.recipientAddress, amount: p.piconeros })),
        relay: false
      })
      break // fits including the real fee
    } catch (err) {
      if (isRetryableTxBuildError(err)) {
        // Pre-relay build failure: createTx threw, so no tx exists and
        // provably nothing was broadcast (2026-09-28 incident). Retryable
        // skip — rows stay QUEUED, the summary makes the run FAILED-resumable,
        // and a useful-only consolidation may sweep the account for a fresh
        // output set. NO drop-smallest loop here: each failed attempt cost
        // ~6.5 min in the incident and this is not a marginal fee-fit condition.
        const dump = await dumpBuildFailureState(w, accountIndex, unlockedAtPlan)
        logWarn({ accountIndex, payoutCount: batch.length, dump, errorClass: errorLabel(err) },
          'sendPayouts: account batch build failed pre-relay (retryable) — payouts stay QUEUED, resumable')
        retryableSkipped = [...batch]
        retryableBuildFailure = true
        return { tx: null, batch: [], dropped, failed, filled, retryableSkipped, retryableBuildFailure }
      }
      if (!isBalanceError(err)) {
        // Hard error: funds stayed in the wallet.
        logError({ accountIndex, payoutCount: batch.length, errorClass: errorLabel(err) }, 'sendPayouts: account batch FAILED (funds stayed in wallet)')
        failed.push(...batch)
        return { tx: null, batch: [], dropped, failed, filled, retryableSkipped, retryableBuildFailure: false }
      }
      if (batch.length === 1) {
        // The only member cannot cover its fee: it stays QUEUED, but smaller
        // unassigned rows may still be affordable (phase 2 validates them).
        dropped.push(batch.pop())
        break
      }
      dropped.push(batch.splice(dropSmallestIndex(batch), 1)[0])
    }
  }

  const removeFromPool = candidate => {
    const poolIndex = fillPool.indexOf(candidate)
    if (poolIndex >= 0) fillPool.splice(poolIndex, 1)
  }

  // Phase 2: the bucket drained without a transaction (every planned member
  // overflows its fee). Continue largest-first validation of still-unassigned
  // whole payouts on this account — at most one attempt per row.
  if (!tx && fillPool.length > 0) {
    for (const candidate of [...fillPool].sort(byLargestPayout)) {
      if (attemptedFillIds.has(candidate.id)) continue
      attemptedFillIds.add(candidate.id)
      try {
        tx = await w.createTx({
          accountIndex,
          destinations: [{ address: candidate.recipientAddress, amount: candidate.piconeros }],
          relay: false
        })
        batch.push(candidate)
        filled.push(candidate)
        removeFromPool(candidate)
        break // the largest affordable candidate becomes the base; phase 3 fills
      } catch (err) {
        if (isRetryableTxBuildError(err)) {
          const dump = await dumpBuildFailureState(w, accountIndex, unlockedAtPlan)
          logWarn({ accountIndex, payoutId: candidate.id, dump, errorClass: errorLabel(err) },
            'sendPayouts: unassigned payout build failed pre-relay (retryable) — bucket stays QUEUED, resumable')
          // Counted once via retryableSkipped (never also in dropped).
          retryableSkipped = [candidate]
          retryableBuildFailure = true
          return { tx: null, batch: [], dropped, failed, filled, retryableSkipped, retryableBuildFailure }
        }
        if (isBalanceError(err)) {
          // Cannot cover its own fee: stays QUEUED; never revisited.
          dropped.push(candidate)
          continue
        }
        // Hard error: funds stayed in the wallet.
        logError({ accountIndex, payoutId: candidate.id, errorClass: errorLabel(err) },
          'sendPayouts: unassigned payout build FAILED (hard error, funds stayed) — marked FAILED')
        failed.push(candidate)
        continue
      }
    }
  }

  // Phase 3: true-fee filling. Snapshot the pool: splicing an accepted candidate
  // out of the live array must never shift the next candidate behind the
  // iterator. ONE attempt per previously unassigned row; rejected rows are
  // never revisited; accepted fills are consumed so no bucket can reuse them.
  if (tx) {
    for (const candidate of [...fillPool]) {
      if (candidate == null || attemptedFillIds.has(candidate.id)) continue
      const fee = typeof tx.getFee === 'function' ? BigInt(await tx.getFee()) : 0n
      const spend = batch.reduce((acc, p) => acc + p.piconeros, 0n) + fee
      const residual = unlockedAtPlan == null ? null : BigInt(unlockedAtPlan) - spend
      if (residual == null || residual < candidate.piconeros) continue // may fit another bucket later
      attemptedFillIds.add(candidate.id)
      let nextTx
      try {
        nextTx = await w.createTx({
          accountIndex,
          destinations: [...batch, candidate].map(p => ({ address: p.recipientAddress, amount: p.piconeros })),
          relay: false
        })
      } catch (err) {
        if (isRetryableTxBuildError(err)) {
          const dump = await dumpBuildFailureState(w, accountIndex, unlockedAtPlan)
          logWarn({ accountIndex, payoutCount: batch.length + 1, dump, errorClass: errorLabel(err) },
            'sendPayouts: account batch fill failed pre-relay (retryable) — whole bucket stays QUEUED, resumable')
          retryableSkipped = [...batch, candidate]
          retryableBuildFailure = true
          return { tx: null, batch: [], dropped, failed, filled, retryableSkipped, retryableBuildFailure }
        }
        if (isBalanceError(err)) {
          logWarn({ accountIndex, payoutId: candidate.id, piconeros: candidate.piconeros.toString() },
            'sendPayouts: true-fee fill rejected (fee fit) — payout stays QUEUED')
          dropped.push(candidate)
          continue
        }
        // Hard error on a fill candidate: the base tx is valid and is kept, but
        // the candidate itself cannot be written — FAILED (funds stayed).
        logError({ accountIndex, payoutId: candidate.id, errorClass: errorLabel(err) },
          'sendPayouts: true-fee fill FAILED (hard error) — candidate marked FAILED, base bucket kept')
        failed.push(candidate)
        continue
      }
      tx = nextTx
      batch.push(candidate)
      filled.push(candidate)
      removeFromPool(candidate)
    }
  }

  return { tx, batch, dropped, failed, filled, retryableSkipped, retryableBuildFailure }
}

// Build + journal + relay a batch tx from ONE account. The built tx is
// journaled (Task 6 boundary) BEFORE any relay; a journal failure means nothing
// is relayed and the bucket stays QUEUED. Returns the split so sendPayouts can
// tally: a payout is never split across txs — it is sent whole or skipped whole.
async function relayBucketTx (w, models, accountIndex, payouts, planInfo = {}) {
  if (payouts.length === 0) {
    return { txHash: null, sent: [], skipped: [], failed: 0, unpersisted: 0, accountingUnpersisted: 0, dropped: [], retryableSkipped: [], filled: [], retryableBuildFailure: false }
  }
  const scope = planInfo.scope || walletScope()
  // payout-build: create-then-relay batch construction (incl. true-fee fill
  // retries). Timed per account so a slow build is distinguishable from a slow
  // relay. Context is code-owned numerics only.
  const build = await withRewardsPhase(
    'payout-build',
    () => buildBucketBatch(w, accountIndex, payouts, planInfo),
    { accountIndex, payoutCount: payouts.length }
  )

  if (build.failed.length > 0) {
    for (const payout of build.failed) {
      await models.rewardPayout.update({ where: { id: payout.id }, data: { state: 'FAILED' } })
    }
  }
  if (build.retryableBuildFailure || !build.tx) {
    return {
      txHash: null,
      sent: [],
      skipped: build.dropped.concat(build.retryableSkipped),
      failed: build.failed.length,
      unpersisted: 0,
      accountingUnpersisted: 0,
      dropped: build.dropped,
      retryableSkipped: build.retryableSkipped,
      filled: build.filled,
      retryableBuildFailure: build.retryableBuildFailure
    }
  }

  const tx = build.tx
  const batch = build.batch
  const txHash = toTxHash(tx.getHash())
  logInfo({ accountIndex, payoutCount: batch.length, txHash }, 'sendPayouts: batch created (pre-relay)')

  let journal
  try {
    journal = await prepareDispatchResolved({
      context: { accountIndex, payoutCount: batch.length },
      message: 'sendPayouts: CRITICAL — payout pair preparation failed',
      prepare: () => prepareWalletTransaction({
        models,
        wallet: w,
        scope,
        tx,
        kind: 'PAYOUT',
        accountIndex,
        distributionId: batch[0].distributionId,
        principalPiconeros: batch.reduce((acc, p) => acc + p.piconeros, 0n),
        metadata: {
          payouts: batch.map(p => ({ payoutId: p.id, recipientAddress: p.recipientAddress, piconeros: p.piconeros.toString() }))
        },
        keyProvider: paymentProofKeys()
      })
    })
  } catch (err) {
    // The pair outcome is unresolved after a fresh read: this dispatch stays
    // withheld — the bucket stays QUEUED, nothing was broadcast (the relay
    // barrier never opened) and a later drive re-resolves from the DB.
    logError({ accountIndex, payoutCount: batch.length, errorClass: errorLabel(err) },
      'sendPayouts: CRITICAL — payout pair read failed; dispatch withheld, bucket stays QUEUED (nothing relayed)')
    return { txHash: null, sent: [], skipped: build.dropped.concat(batch), failed: build.failed.length, unpersisted: 0, accountingUnpersisted: 0, dropped: build.dropped, retryableSkipped: build.retryableSkipped, filled: build.filled, retryableBuildFailure: false }
  }

  let relay
  try {
    // payout-relay: the claim + broadcast step. Timed per account so a slow
    // broadcast/claim is distinguishable from a slow build. Context is
    // code-owned numerics only; the thrown error keeps its identity.
    relay = await withRewardsPhase(
      'payout-relay',
      () => relayWalletTransaction({ models, wallet: w, journal, tx, keyProvider: paymentProofKeys() }),
      { accountIndex, payoutCount: batch.length }
    )
  } catch (err) {
    // Pair/claim failure (including an unknown claim acknowledgement): this
    // built tx was NOT broadcast, but the journal row may already be attempted
    // (concurrent drive) — retain accounting uncertainty and never mark the
    // recipients FAILED.
    logError({ accountIndex, payoutCount: batch.length, errorClass: errorLabel(err) },
      'sendPayouts: CRITICAL — payout pair/attempt claim failed; dispatch withheld, bucket stays QUEUED')
    return { txHash: null, sent: [], skipped: build.dropped.concat(batch), failed: build.failed.length, unpersisted: 0, accountingUnpersisted: 1, dropped: build.dropped, retryableSkipped: build.retryableSkipped, filled: build.filled, retryableBuildFailure: false }
  }
  if (!relay.relayed) {
    // Possibly broadcast: recipients stay QUEUED and journal reconciliation
    // excludes them until a fresh confirmed verification settles the attempt (never FAILED,
    // never blindly re-relayed).
    logError({ accountIndex, txHash }, 'sendPayouts: relay outcome uncertain — bucket stays QUEUED until a fresh confirmed verification resolves the journal')
    return { txHash: null, sent: [], skipped: build.dropped.concat(batch), failed: build.failed.length, unpersisted: 0, accountingUnpersisted: 1, dropped: build.dropped, retryableSkipped: build.retryableSkipped, filled: build.filled, retryableBuildFailure: false }
  }

  // Proven relay: ALWAYS persist the recipient principal, even when the
  // journal fee state could not be persisted (accountingUnpersisted below keeps
  // the run resumable; the money moved either way).
  const unpersisted = await persistSentPayouts(batch, relay.txHash, models)
  return {
    txHash: relay.txHash,
    sent: batch,
    skipped: build.dropped,
    failed: build.failed.length,
    unpersisted,
    accountingUnpersisted: relay.accountingUnpersisted || 0,
    dropped: build.dropped,
    retryableSkipped: build.retryableSkipped,
    filled: build.filled,
    retryableBuildFailure: false
  }
}

// Persist the shared tx hash on every payout row of a relayed batch (SENT)
// with one retry, then a CRITICAL alert for manual reconciliation — a persist
// blip never flips a payout FAILED (the funds already left the wallet).
// Returns how many payouts remain UNPERSISTED after the retry: the caller
// counts them in the summary's `unpersisted` so the distribution can never
// COMPLETE with an unrecorded relay.
async function persistSentPayouts (payouts, txHash, models) {
  let unpersisted = 0
  for (const payout of payouts) {
    try {
      await models.rewardPayout.update({
        where: { id: payout.id },
        data: { state: 'SENT', txHash }
      })
    } catch (err) {
      logError({ payoutId: payout.id, txHash, errorClass: errorLabel(err) }, 'sendPayouts: CRITICAL — tx relayed but DB update failed; manual reconciliation required')
      try {
        await models.rewardPayout.update({
          where: { id: payout.id },
          data: { state: 'SENT', txHash }
        })
      } catch (err2) {
        logError({ payoutId: payout.id, txHash, errorClass: errorLabel(err2) }, 'sendPayouts: CRITICAL — DB-update retry also failed')
        alert('critical', 'relayed-but-unpersisted payout',
          `payout ${payout.id} tx ${txHash} relayed but DB persist failed (retry also failed); the next run reconciles it from wallet history — do NOT manually re-send`,
          { dedupeKey: `relay-unpersisted-${txHash}` })
        unpersisted += 1
      }
    }
  }
  return unpersisted
}

// Compatibility wrapper for the all-fit packing: returns the complete
// first-fit-decreasing buckets or null when even the partial plan has skips
// (callers then choose the largest-first partial plan explicitly). Exported for
// tests.
export function planAccountSends (payouts, unlockedByAccount, feeReserve = 0n) {
  const { buckets, skipped } = planPartialAccountSends(payouts, unlockedByAccount, feeReserve)
  return skipped.length === 0 ? buckets : null
}

// Sweep every funded fee-pool account (1-5) into the primary address through
// the SAME journaled boundary as payouts: build each sweep with relay:false,
// prepare/journal it as a zero-principal CONSOLIDATION self transfer, then
// relay the same object. The DB ledger is unaffected (the transparency
// resolver derives balances from the DB, never on-chain sent-side data).
// Every returned hash must be unique — a duplicate set means the wallet cannot
// be trusted to journal each sweep once, so that account is refused (nothing
// relayed). Returns the number of unresolved accounting items (an uncertain
// relay or a proven relay whose journal state could not be persisted) so the
// caller's summary can never silently COMPLETE over a possible unrecorded
// spend. Errors are alerted CRITICAL but never thrown — the caller ends the run
// FAILED-resumable either way.
async function consolidateFeeAccounts (w, models, scope, { reason } = {}) {
  let accountingFailures = 0
  const seenHashes = new Set()
  for (const idx of SIGNER_ACCOUNTS) {
    if (idx === 0) continue
    try {
      // Always the FRESH post-payout unlocked balance.
      const bal = BigInt(await w.getUnlockedBalance(idx))
      if (bal < CONSOLIDATION_MIN_PICONEROS) continue
      const txs = await w.sweepUnlocked({ accountIndex: idx, address: scope.walletAddress, relay: false })
      const list = txs || []
      if (list.length === 0) continue
      const hashes = list.map(tx => toTxHash(tx.getHash()))
      if (hashes.some(h => !h) || new Set(hashes).size !== hashes.length || hashes.some(h => seenHashes.has(h))) {
        logError({ accountIndex: idx, reason }, 'sendPayouts: CRITICAL — consolidation returned duplicate/invalid transaction hashes; refusing to relay')
        alert('critical', 'rewards fee-account consolidation failed',
          `consolidation sweep of rewards wallet account ${idx} returned non-unique transaction hashes; refusing to relay`,
          { dedupeKey: `rewards-consolidate-${idx}` })
        continue
      }
      for (const hash of hashes) seenHashes.add(hash)
      for (const tx of list) {
        const txHash = toTxHash(tx.getHash())
        let journal
        try {
          journal = await prepareDispatchResolved({
            context: { accountIndex: idx, txHash, reason },
            message: 'sendPayouts: CRITICAL — consolidation pair preparation failed',
            prepare: () => prepareWalletTransaction({
              models,
              wallet: w,
              scope,
              tx,
              kind: 'CONSOLIDATION',
              accountIndex: idx,
              principalPiconeros: 0n,
              metadata: { selfTransfer: true, destination: scope.walletAddress },
              keyProvider: paymentProofKeys()
            })
          })
        } catch (err) {
          // The pair outcome is unresolved after a fresh read: this dispatch
          // stays withheld — nothing was broadcast (the relay barrier never
          // opened) and the next drive re-resolves from the DB.
          logError({ accountIndex: idx, txHash, reason, errorClass: errorLabel(err) }, 'sendPayouts: CRITICAL — consolidation pair read failed; dispatch withheld, nothing relayed')
          alert('critical', 'rewards fee-account consolidation failed',
            `consolidation sweep of rewards wallet account ${idx} could not be journaled; refusing to relay`,
            { dedupeKey: `rewards-consolidate-${idx}` })
          continue
        }
        let relay
        try {
          relay = await relayWalletTransaction({ models, wallet: w, journal, tx, keyProvider: paymentProofKeys() })
        } catch (err) {
          accountingFailures += 1
          logError({ accountIndex: idx, txHash, reason, errorClass: errorLabel(err) }, 'sendPayouts: CRITICAL — consolidation pair/attempt claim failed; accounting remains unresolved')
          continue
        }
        if (relay.relayed) {
          logInfo({ accountIndex: idx, txHash: relay.txHash, reason }, 'sendPayouts: consolidated fee account to primary')
        } else {
          accountingFailures += 1
          logError({ accountIndex: idx, txHash, reason }, 'sendPayouts: CRITICAL — consolidation relay outcome uncertain; accounting remains unresolved')
        }
        accountingFailures += relay.accountingUnpersisted || 0
      }
    } catch (err) {
      logError({ accountIndex: idx, reason, errorClass: errorLabel(err) }, 'sendPayouts: CRITICAL — fee-account consolidation sweep failed')
      alert('critical', 'rewards fee-account consolidation failed',
        `consolidation sweep of rewards wallet account ${idx} failed (diagnostic withheld; see the worker log errorClass); distribution stays resumable-FAILED`,
        { dedupeKey: `rewards-consolidate-${idx}` })
    }
  }
  return { accountingFailures }
}

function setBalanceGauge (models, unlocked) {
  try { moneroRewardsWalletBalancePiconeros.set(Number(unlocked)) } catch { /* NaN/overflow — skip */ }
  // HealthSnapshot bridge leg: fire-and-forget the balance into row id=1 so the
  // app process can serve monero_rewards_wallet_balance_piconeros from
  // /api/metrics (the prom-client gauge is process-local to this worker). The
  // call sites are un-awaited and a persist failure must never throw into the
  // payout/sweep flow — catch + logWarn, best-effort by contract.
  try {
    models?.healthSnapshot?.upsert({
      where: { id: 1 },
      create: { id: 1, balancePiconeros: unlocked, balanceUpdatedAt: new Date() },
      update: { balancePiconeros: unlocked, balanceUpdatedAt: new Date() }
    }).catch(err => logWarn('rewards signer: HealthSnapshot balance persist failed', err))
  } catch (err) {
    logWarn('rewards signer: HealthSnapshot balance persist failed', err)
  }
}

// Sweep the weekly ops earmark from the hot rewards wallet to offline cold
// storage (spec §6.4 / task B3; protected-funds bound per Task 9). Runs as ONE
// more sequential createTx on the SAME singleton wallet, strictly AFTER
// sendPayouts returns — never concurrent, never a second wallet, so no
// same-output double-spend (monero-ts marks an input spent in-memory the
// instant a tx relays).
//
// Ops may only sweep what is genuinely theirs. Before any wallet relay the
// sweep reconciles the journal from fresh confirmed payment verifications and refuses when
// accounting is unresolved, then reads ONE consistent DB snapshot (ledger +
// next pool + all-time inflow) and bounds the whole run by:
//   B = min( corrected ops carry, unlocked - outstanding reward principal -
//            next pool - standing fee reserve )
// where `corrected ops` is the completed distribution's opsAvailable less the
// ledger-proven swept principal less network costs past its checkpoint, and B
// covers principal PLUS real fees. The snapshot is re-read before every account
// build and the effective budget is the smaller of the remaining original cap
// and the fresh cap. Each account's tx is built with createTx({relay: false})
// so its REAL fee is known before anything moves; a fee that would overflow the
// budget shrinks the principal by exactly the excess and is revalidated, and a
// balance error keeps the bounded headroom decrement. Exhaustion defers — it is
// never permission to exceed the budget.
//
// Every relay is journaled FIRST (kind OPS_SWEEP, metadata { destination }, the
// exact principal and fee) and only the original validated object is relayed;
// opsSweptPiconeros records PRINCIPAL ONLY (the fee is a journal expense). An
// uncertain relay stops all further account sweeps and leaves the journal
// attempt unresolved, blocking the next sweep until a fresh confirmed verification proves the
// outcome — an unknown send is never treated as safely unbroadcast. Relay-
// before-persist: a relayed tx hash is captured the instant the relay succeeds
// and logged before any DB write, so it is never silently lost; a persist
// failure retries once then logs CRITICAL (manual reconciliation) rather than
// flipping FAILED — FAILED means funds STAYED in the wallet, which a post-relay
// persist blip does not satisfy.
//
// `wallet` is injectable for unit tests; production leaves it unset and reuses
// the getRewardsWallet() singleton.

// Bounded build loop for ONE account sweep: balance-error headroom decrements
// and real-fee budget adjustments share this cap, so exhaustion is a safe
// deferral — never permission to exceed the budget.
const SWEEP_BUILD_ATTEMPTS = 3

// ONE Serializable DB snapshot of every fact the sweep bound reads: the
// journal/ledger union (proven principal, fees, uncertainty), the next pool and
// the all-time confirmed inflow the ledger balance check compares against. The
// wallet is never touched here — sync, scope proof and journal reconciliation
// run outside this DB work.
async function readSweepSafetySnapshot (models) {
  const scope = walletScope()
  return await models.$transaction(async (tx) => {
    const config = await tx.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
    const ledger = await readRewardsWalletLedger(tx, { scope })
    const pool = await readNextRewardsPool(tx, config)
    const allTimeInflow = await readRewardsInflow(tx, { start: new Date(0), config })
    return {
      ledger,
      poolPiconeros: pool.poolPiconeros,
      allTimeInflowPiconeros: allTimeInflow.totalPiconeros
    }
  }, { isolationLevel: 'Serializable', timeout: 10000 })
}

// The sweep refuses to spend a single piconero while any journal attempt is
// unresolved, the ledger reports a contradiction, a stored positive drift has
// not been cleared by a current audit, or the ledger's proven outflows exceed
// every piconero that ever arrived. Returns a specific reason string or null.
function sweepAccountingRefusal (snapshot) {
  const { ledger, allTimeInflowPiconeros } = snapshot
  if (ledger.accountingUncertain) {
    return 'the rewards wallet ledger has unresolved journal attempts or conflicting facts'
  }
  if (ledger.positiveDriftPiconeros > 0n) {
    return `a stored reconciliation audit reports positive ledger drift of ${ledger.positiveDriftPiconeros.toString()} piconeros`
  }
  const balance = allTimeInflowPiconeros - ledger.totalSentPiconeros - ledger.totalNetworkFeesPiconeros
  if (balance < 0n) {
    return `the ledger balance is negative (${balance.toString()} piconeros): proven outflows exceed all-time confirmed inflow`
  }
  return null
}

// Push the wallet's ACTUAL refreshed unlocked balance into the gauge (the
// last-known-balance meaning is unchanged — Task 11). Runs on EVERY path that
// spent or whose relay outcome is uncertain; a wallet/metric failure is logged
// and ISOLATED, so it can never alter the sweep result.
async function refreshBalanceGauge ({ distributionId, models, wallet }) {
  try {
    let refreshedUnlocked = 0n
    for (const idx of SIGNER_ACCOUNTS) refreshedUnlocked += BigInt(await wallet.getUnlockedBalance(idx))
    setBalanceGauge(models, refreshedUnlocked)
  } catch (err) {
    logWarn({ distributionId, errorClass: errorLabel(err) }, 'sweepOpsEarmark: balance gauge refresh failed (isolated)')
  }
}

// Persist a stopped sweep's proven relayed facts (never SWEPT: nothing more may
// be swept this period), refresh the balance gauge for the money that actually
// left, and alert operators, so a post-mortem never has to guess what already
// happened.
async function persistPartialSweepFailure ({ distribution, models, wallet, hashes, swept, alertTitle, alertBody }) {
  // Spending already happened: the gauge reflects the wallet's ACTUAL balance
  // now (isolated), never an arithmetic remainder.
  await refreshBalanceGauge({ distributionId: distribution.id, models, wallet })
  const txHash = hashes.join(',')
  try {
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { opsSweepState: 'FAILED', opsSweptPiconeros: swept, opsSweepTxHash: txHash }
    })
  } catch (err) {
    logError({ distributionId: distribution.id, txHash, errorClass: errorLabel(err) },
      'sweepOpsEarmark: CRITICAL — relayed partial sweep could not be persisted; manual reconciliation required')
  }
  alert('critical', alertTitle, alertBody, { dedupeKey: `dist-${distribution.id}-partial-sweep-failed` })
  return { state: 'FAILED' }
}

// Refuse BEFORE any wallet relay: FAILED with a specific CRITICAL accounting
// alert. With no relayed tx the distribution row is left untouched; a partial
// sweep persists its proven facts (and refreshes the gauge) exactly like the
// other partial paths.
async function refuseSweepAccounting ({ distribution, models, wallet, hashes, swept, reason }) {
  logError({
    distributionId: distribution.id,
    reason,
    relayedCount: hashes.length
  }, 'sweepOpsEarmark: CRITICAL — rewards accounting is not safe to sweep; refusing without any further wallet relay')
  if (hashes.length > 0) {
    return await persistPartialSweepFailure({
      distribution,
      models,
      wallet,
      hashes,
      swept,
      alertTitle: 'partial ops sweep relayed before an accounting refusal',
      alertBody: `distribution ${distribution.id}: ${hashes.length} sweep tx(s) already relayed (${hashes.join(',')}); accounting is no longer safe to continue (${reason}). Partial sweep persisted; no further relay. Manual reconciliation required.`
    })
  }
  alert('critical', 'rewards ops sweep refused: accounting not safe',
    `distribution ${distribution.id}: ops sweep refused — ${reason}. No wallet relay was attempted and the distribution state is unchanged. Resolve the rewards wallet accounting before the sweep retries.`,
    { dedupeKey: `dist-${distribution.id}-sweep-accounting-unsafe` })
  return { state: 'FAILED' }
}

// The sweep's spend bound: corrected ops (the completed distribution's
// opsAvailable less proven swept principal less network costs past its
// checkpoint) capped by the unlocked balance that is genuinely free after ALL
// outstanding reward principal, the next rewards pool and the standing fee
// reserve. New open-cycle ops are deliberately NOT part of correctedOps.
function sweepDebitCap ({ distribution, ledger, poolPiconeros, balances }) {
  const totalUnlocked = Object.values(balances).reduce((acc, bal) => acc + BigInt(bal), 0n)
  const correctedOps = opsCarry({
    distribution,
    totalNetworkFeesPiconeros: ledger.totalNetworkFeesPiconeros,
    provenSweptPiconeros: ledger.sweptByDistribution.get(distribution.id) ?? 0n
  })
  const reserve = standingReserve(balances, {
    feeHeadroom: TX_FEE_HEADROOM_PICONEROS,
    dustFloor: REWARDS_OPS_SWEEP_MIN_PICONEROS
  })
  return sweepDebitLimit({
    opsPiconeros: correctedOps,
    unlockedPiconeros: totalUnlocked,
    commitmentsPiconeros: ledger.outstandingRewardsPiconeros,
    nextPoolPiconeros: poolPiconeros,
    reservePiconeros: reserve
  })
}

// Build ONE account's sweep tx bounded by BOTH the account's unlocked balance
// and the remaining debit budget as principal + the tx's ACTUAL fee.
// createTx({relay:false}) constructs + validates the real fee without moving
// funds. A balance/retryable build error decrements by the fee headroom and a
// budget overflow by the exact excess; both share ONE small attempt cap.
// Returns { tx, principal, fee } or null for a safe deferral.
async function buildSweepTx (w, accountIndex, address, desired, budget) {
  let principal = desired
  for (let attempt = 0; attempt < SWEEP_BUILD_ATTEMPTS; attempt++) {
    if (principal <= 0n) return null
    let tx
    try {
      tx = await w.createTx({ accountIndex, address, amount: principal, relay: false })
    } catch (err) {
      if (isBalanceError(err) || isRetryableTxBuildError(err)) {
        principal -= TX_FEE_HEADROOM_PICONEROS
        continue
      }
      throw err
    }
    const fee = typeof tx.getFee === 'function' ? BigInt(await tx.getFee()) : 0n
    if (principal + fee <= budget) return { tx, principal, fee }
    // The real fee overflowed the remaining budget: rebuild lower by exactly
    // the excess so principal + ACTUAL fee fits (a changed fee is revalidated
    // on the next attempt like any other build).
    principal -= (principal + fee) - budget
  }
  return null
}

export async function sweepOpsEarmark ({ distribution, models, wallet } = {}) {
  if (distribution?.opsSweepState === 'SWEPT') {
    return { state: 'SWEPT', txHash: distribution.opsSweepTxHash, swept: distribution.opsSweptPiconeros }
  }

  const coldAddress = process.env.REWARDS_COLD_STORAGE_ADDRESS
  const sweepEnabled = String(process.env.REWARDS_OPS_SWEEP_ENABLED ?? 'true') !== 'false'
  if (!sweepEnabled || !coldAddress) {
    return { state: 'DISABLED' }
  }

  // Partial-sweep re-drive guard (2026-09-14 review): a prior run on this row
  // already relayed part of the earmark. Re-targeting opsAvailablePiconeros
  // would over-sweep and overwrite opsSweptPiconeros with only this run's
  // total — refuse; the remainder rolls into the next period via
  // opsRolledOverPiconeros.
  const alreadySwept = BigInt(distribution?.opsSweptPiconeros ?? 0)
  if (alreadySwept > 0n) {
    logError({
      distributionId: distribution.id,
      alreadySwept: alreadySwept.toString()
    }, 'sweepOpsEarmark: partial sweep already relayed; refusing re-drive (remainder rolls over)')
    return { state: 'FAILED' }
  }

  const scope = walletScope()
  const w = wallet || await getRewardsWallet(models)
  // Same stale-cached-view fix as sendPayouts: refresh before reading balances.
  await w.sync()
  // The wallet must prove it IS the configured rewards wallet before any read
  // or send is trusted (Task 6 identity boundary).
  try {
    await assertWalletScope(w, scope)
  } catch (err) {
    logError({ distributionId: distribution.id, errorClass: errorLabel(err) },
      'sweepOpsEarmark: CRITICAL — sweep wallet cannot prove it is the configured rewards wallet; refusing (no relay)')
    alert('critical', 'rewards ops sweep refused: wrong wallet',
      `distribution ${distribution.id}: the sweep wallet could not prove it is the configured rewards wallet; no wallet relay was attempted and the distribution state is unchanged.`,
      { dedupeKey: `dist-${distribution.id}-sweep-wallet-scope` })
    return { state: 'FAILED' }
  }

  // Resolve every attempted-but-unproven journal relay from a fresh confirmed
  // whole-payment verification. A provable relay is journaled here; an
  // unprovable one BLOCKS the sweep — an unknown send is never treated as
  // safely unbroadcast (Task 6/9 boundary).
  const reconciliation = await reconcileWalletTransactions({ models, wallet: w, scope })
  if (reconciliation.uncertainSweep || reconciliation.accountingUnpersisted > 0) {
    return await refuseSweepAccounting({
      distribution,
      models,
      wallet: w,
      hashes: [],
      swept: 0n,
      reason: reconciliation.uncertainSweep
        ? 'an attempted ops-sweep relay is not resolved by a fresh confirmed verification'
        : 'a proven relay could not be persisted in the journal'
    })
  }

  // Aggregate unlocked across all signer accounts, then sweep greedily
  // per-account (createTx spends from ONE account per tx).
  const unlockedByAccount = {}
  let totalUnlocked = 0n
  for (const idx of SIGNER_ACCOUNTS) {
    const bal = BigInt(await w.getUnlockedBalance(idx))
    unlockedByAccount[idx] = bal
    totalUnlocked += bal
  }

  // The initial safety snapshot is guarded exactly like the per-account one:
  // an unreadable/identity-mismatched accounting read returns FAILED with a
  // specific CRITICAL alert, never a throw that bypasses the refusal contract.
  let snapshot
  try {
    snapshot = await readSweepSafetySnapshot(models)
  } catch (err) {
    logError({ distributionId: distribution.id, errorClass: errorLabel(err) },
      'sweepOpsEarmark: CRITICAL — accounting snapshot unreadable; refusing (no relay)')
    return await refuseSweepAccounting({
      distribution,
      models,
      wallet: w,
      hashes: [],
      swept: 0n,
      reason: 'the rewards accounting snapshot could not be read'
    })
  }
  let refusal = sweepAccountingRefusal(snapshot)
  if (refusal) {
    return await refuseSweepAccounting({ distribution, models, wallet: w, hashes: [], swept: 0n, reason: refusal })
  }

  // The whole sweep may spend principal + real fees only up to this bound.
  let remaining = sweepDebitCap({
    distribution,
    ledger: snapshot.ledger,
    poolPiconeros: snapshot.poolPiconeros,
    balances: unlockedByAccount
  })
  const sweepTarget = remaining
  if (remaining <= REWARDS_OPS_SWEEP_MIN_PICONEROS) {
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { opsSweepState: 'SKIPPED_LOCKED' }
    })
    return { state: 'SKIPPED_LOCKED' }
  }

  let swept = 0n
  const hashes = []
  // Tracked per-account ACTUAL unlocked balance, re-read from the wallet before
  // every account build: after each relay the account's change output is
  // locked, so a synthetic "initial minus spend" balance overstates what is
  // genuinely spendable now.
  const balances = { ...unlockedByAccount }
  const accounts = Object.entries(unlockedByAccount)
    .map(([idx, bal]) => ({ accountIndex: Number(idx), unlocked: BigInt(bal) }))
    .sort((a, b) => (a.unlocked < b.unlocked ? 1 : a.unlocked > b.unlocked ? -1 : a.accountIndex - b.accountIndex))
  for (const acc of accounts) {
    if (remaining <= 0n) break

    // REAL liquidity, outside the DB snapshot: refresh every signer account's
    // unlocked balance from the wallet first, so the fresh cap prices only
    // spendable outputs (locked change is excluded). This read happens AFTER
    // earlier relays, so a failure must NEVER reject the run: with proven facts
    // it goes through the same partial finalization as every other partial
    // exit, and before any relay it defers safely.
    let balanceReadError = null
    try {
      for (const idx of SIGNER_ACCOUNTS) {
        balances[idx] = BigInt(await w.getUnlockedBalance(idx))
      }
    } catch (err) {
      balanceReadError = err
    }
    if (balanceReadError) {
      if (hashes.length > 0) {
        logError({ distributionId: distribution.id, accountIndex: acc.accountIndex, err: balanceReadError },
          'sweepOpsEarmark: CRITICAL — wallet balance read failed after a relayed sweep; finalizing the known partial facts')
        return await persistPartialSweepFailure({
          distribution,
          models,
          wallet: w,
          hashes,
          swept,
          alertTitle: 'partial ops sweep relayed then wallet read failed',
          alertBody: `distribution ${distribution.id}: ${hashes.length} sweep tx(s) already relayed (${hashes.join(',')}); the wallet balance read for account ${acc.accountIndex} failed before any further relay. Partial sweep persisted; the remainder rolls into the next period. Manual reconciliation required.`
        })
      }
      logWarn({ distributionId: distribution.id, err: balanceReadError },
        'sweepOpsEarmark: wallet balance read failed before any relay; deferring (rolls into next period)')
      await models.rewardDistribution.update({
        where: { id: distribution.id },
        data: { opsSweepState: 'SKIPPED_LOCKED' }
      })
      return { state: 'SKIPPED_LOCKED' }
    }
    if (balances[acc.accountIndex] <= 0n) continue

    // Re-read the safety snapshot BEFORE every account build: the effective
    // budget is the smaller of the remaining original cap and the freshly-read
    // cap, so newly observed commitments, fees or drift can only shrink the
    // spend. Wallet reads stayed outside this DB work.
    try {
      snapshot = await readSweepSafetySnapshot(models)
    } catch (err) {
      logError({ distributionId: distribution.id, errorClass: errorLabel(err) },
        'sweepOpsEarmark: CRITICAL — accounting snapshot unreadable mid-sweep; stopping')
      return await refuseSweepAccounting({
        distribution,
        models,
        wallet: w,
        hashes,
        swept,
        reason: 'the rewards accounting snapshot could not be read'
      })
    }
    refusal = sweepAccountingRefusal(snapshot)
    if (refusal) {
      return await refuseSweepAccounting({ distribution, models, wallet: w, hashes, swept, reason: refusal })
    }
    const currentCap = sweepDebitCap({
      distribution,
      ledger: snapshot.ledger,
      poolPiconeros: snapshot.poolPiconeros,
      balances
    })
    const budget = remaining < currentCap ? remaining : currentCap
    if (budget <= 0n) break

    const desired = balances[acc.accountIndex] < budget ? balances[acc.accountIndex] : budget
    logInfo({
      distributionId: distribution.id,
      accountIndex: acc.accountIndex,
      amount: desired.toString(),
      unlocked: acc.unlocked.toString()
    }, 'sweepOpsEarmark: attempting account sweep')

    let built
    try {
      built = await buildSweepTx(w, acc.accountIndex, coldAddress, desired, budget)
    } catch (err) {
      // Hard createTx error: the funds stayed in the wallet. Preserve the
      // existing partial-sweep persistence/alerts.
      logError({ distributionId: distribution.id, accountIndex: acc.accountIndex, errorClass: errorLabel(err) }, 'sweepOpsEarmark: sweep FAILED')
      if (hashes.length > 0) {
        return await persistPartialSweepFailure({
          distribution,
          models,
          wallet: w,
          hashes,
          swept,
          alertTitle: 'partial ops sweep relayed then failed',
          alertBody: `distribution ${distribution.id}: ${hashes.length} sweep tx(s) already relayed (${hashes.join(',')}); account ${acc.accountIndex} sweep FAILED. Partial sweep persisted; manual reconciliation required.`
        })
      }
      await models.rewardDistribution.update({ where: { id: distribution.id }, data: { opsSweepState: 'FAILED' } })
      return { state: 'FAILED' }
    }
    if (!built) {
      // Bounded-loop exhaustion or no positive principal: a safe deferral for
      // this account (a smaller one may still fit).
      continue
    }

    let journal
    try {
      journal = await prepareDispatchResolved({
        context: { distributionId: distribution.id, accountIndex: acc.accountIndex },
        message: 'sweepOpsEarmark: CRITICAL — sweep pair preparation failed',
        prepare: () => prepareWalletTransaction({
          models,
          wallet: w,
          scope,
          tx: built.tx,
          kind: 'OPS_SWEEP',
          accountIndex: acc.accountIndex,
          distributionId: distribution.id,
          principalPiconeros: built.principal,
          metadata: { destination: coldAddress },
          keyProvider: paymentProofKeys()
        })
      })
    } catch (err) {
      // The pair outcome is unresolved after a fresh read: no relay happened
      // for this account (the barrier never opened). Stop — an unresolved
      // dispatch must surface, not be papered over.
      logError({ distributionId: distribution.id, accountIndex: acc.accountIndex, errorClass: errorLabel(err) },
        'sweepOpsEarmark: CRITICAL — sweep pair read failed; dispatch withheld, no relay')
      if (hashes.length > 0) {
        return await persistPartialSweepFailure({
          distribution,
          models,
          wallet: w,
          hashes,
          swept,
          alertTitle: 'partial ops sweep relayed then journaling failed',
          alertBody: `distribution ${distribution.id}: ${hashes.length} sweep tx(s) already relayed (${hashes.join(',')}); the next account could not be journaled. Partial sweep persisted; manual reconciliation required.`
        })
      }
      alert('critical', 'rewards ops sweep journaling failed',
        `distribution ${distribution.id}: the ops sweep could not be journaled; nothing was relayed and the distribution state is unchanged.`,
        { dedupeKey: `dist-${distribution.id}-sweep-journal-failed` })
      return { state: 'FAILED' }
    }

    let relay
    try {
      relay = await relayWalletTransaction({ models, wallet: w, journal, tx: built.tx, keyProvider: paymentProofKeys() })
    } catch (err) {
      // Pair/claim failure (including an unknown claim acknowledgement): this
      // built tx was NOT broadcast, but the journal row may already be
      // attempted (concurrent drive) — retain uncertainty and never treat it
      // as safely unbroadcast.
      logError({ distributionId: distribution.id, accountIndex: acc.accountIndex, errorClass: errorLabel(err) },
        'sweepOpsEarmark: CRITICAL — journal relay claim failed; blocking further sweeps until fresh verification')
      if (hashes.length > 0) {
        return await persistPartialSweepFailure({
          distribution,
          models,
          wallet: w,
          hashes,
          swept,
          alertTitle: 'partial ops sweep relayed then relay claim failed',
          alertBody: `distribution ${distribution.id}: ${hashes.length} sweep tx(s) already relayed (${hashes.join(',')}); the next sweep's journal relay claim failed and may be attempted. Partial sweep persisted; no further relay until reconciliation.`
        })
      }
      // The attempt may be outstanding: refresh the gauge from the actual
      // wallet before returning (isolated from the result).
      await refreshBalanceGauge({ distributionId: distribution.id, models, wallet: w })
      alert('critical', 'rewards ops sweep relay uncertain',
        `distribution ${distribution.id}: a journaled sweep attempt could not be claimed/relayed (${journal.txHash}); it is NOT proven unbroadcast and blocks further sweeps until fresh verification.`,
        { dedupeKey: `dist-${distribution.id}-sweep-uncertain-${journal.txHash}` })
      return { state: 'FAILED' }
    }
    if (!relay.relayed) {
      // Possibly broadcast: stop ALL further account sweeps. The journal row
      // stays PREPARED+attempted and blocks the next run until exact-hash
      // fresh verification resolves it; known partial facts are recorded and alerted.
      logError({ distributionId: distribution.id, accountIndex: acc.accountIndex, txHash: relay.txHash },
        'sweepOpsEarmark: CRITICAL — relay outcome uncertain; stopping further sweeps until fresh verification')
      if (hashes.length > 0) {
        return await persistPartialSweepFailure({
          distribution,
          models,
          wallet: w,
          hashes,
          swept,
          alertTitle: 'partial ops sweep relayed then relay outcome uncertain',
          alertBody: `distribution ${distribution.id}: ${hashes.length} sweep tx(s) already relayed (${hashes.join(',')}); sweep tx ${relay.txHash} (account ${acc.accountIndex}) may or may not have been broadcast. Partial sweep persisted; the unresolved journal attempt blocks the next sweep until a fresh confirmed verification proves the outcome.`
        })
      }
      // The send may have reached the network: refresh the gauge from the
      // actual wallet before returning (isolated from the result).
      await refreshBalanceGauge({ distributionId: distribution.id, models, wallet: w })
      alert('critical', 'rewards ops sweep relay uncertain',
        `distribution ${distribution.id}: sweep tx ${relay.txHash} (account ${acc.accountIndex}) may or may not have been broadcast and its journal attempt is unresolved. No further account sweeps were attempted; the next sweep is blocked until a fresh confirmed verification proves the outcome.`,
        { dedupeKey: `dist-${distribution.id}-sweep-uncertain-${relay.txHash}` })
      return { state: 'FAILED' }
    }

    hashes.push(relay.txHash)
    swept += built.principal
    // The journal's persisted fee IS the expense the ledger counts; decrement
    // the remaining original cap by exactly principal + that fee. opsSwept
    // records PRINCIPAL ONLY (the fee lives in the journal expense). Actual
    // per-account liquidity is re-read from the wallet at the top of the next
    // iteration (locked change is excluded there).
    const spend = built.principal + BigInt(journal.networkFeePiconeros)
    remaining -= spend
    logInfo({ distributionId: distribution.id, accountIndex: acc.accountIndex, txHash: relay.txHash, swept: built.principal.toString() }, 'sweepOpsEarmark: account sweep relayed')
  }

  if (hashes.length === 0) {
    logWarn({
      distributionId: distribution.id,
      target: sweepTarget.toString(),
      totalUnlocked: totalUnlocked.toString()
    }, 'sweepOpsEarmark: deferred — no spendable outputs (rolls into next period)')
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { opsSweepState: 'SKIPPED_LOCKED' }
    })
    return { state: 'SKIPPED_LOCKED' }
  }

  const txHash = hashes.join(',')
  logInfo({ distributionId: distribution.id, txHash, swept: swept.toString() }, 'sweepOpsEarmark: ops sweep relayed')
  // The gauge is the wallet's ACTUAL refreshed unlocked balance after the
  // sends — fees and locked per-account change make an arithmetic remainder
  // wrong. Isolated so a metric/wallet failure never changes the result.
  await refreshBalanceGauge({ distributionId: distribution.id, models, wallet: w })
  try {
    await models.rewardDistribution.update({
      where: { id: distribution.id },
      data: { opsSweepState: 'SWEPT', opsSweptPiconeros: swept, opsSweepTxHash: txHash }
    })
  } catch (err) {
    logError({ distributionId: distribution.id, txHash, errorClass: errorLabel(err) }, 'sweepOpsEarmark: CRITICAL — tx relayed but DB update failed; manual reconciliation required')
    try {
      await models.rewardDistribution.update({
        where: { id: distribution.id },
        data: { opsSweepState: 'SWEPT', opsSweptPiconeros: swept, opsSweepTxHash: txHash }
      })
    } catch (err2) {
      logError({ distributionId: distribution.id, txHash, errorClass: errorLabel(err2) }, 'sweepOpsEarmark: CRITICAL — DB-update retry also failed')
      alert('critical', 'relayed-but-unpersisted ops sweep',
        `distribution ${distribution.id} sweep tx ${txHash} relayed but DB persist failed (retry also failed); manual reconciliation required`,
        { dedupeKey: `relay-unpersisted-${txHash}` })
    }
  }

  return { state: 'SWEPT', txHash, swept }
}

// monero-ts getHash() returns a hex string (verified on stagenet), but defend
// against a Uint8Array / Buffer / byte-array shape so the stored txHash is
// always a lowercase hex string.
function toTxHash (hash) {
  if (hash == null) return null
  if (typeof hash === 'string') return hash.toLowerCase()
  if (typeof hash === 'object') {
    const arr = Array.isArray(hash) ? hash : (hash.data || Array.from(hash))
    if (arr && arr.length) return Array.from(arr).map(b => (b >>> 0).toString(16).padStart(2, '0')).join('')
  }
  return String(hash)
}

// Wallet history can contain BUILT-but-unrelayed transactions (a cached tx
// whose relay was never attempted or whose outcome is unresolved) — the Task 6
// journal boundary treats an explicit relayed/confirmed flag as the only relay
// evidence. A history entry that exposes either flag must prove it; an entry
// exposing neither is a legacy shape and keeps the pre-journal behavior.
function isRelayEvidence (tx) {
  const hasRelayed = typeof tx?.getIsRelayed === 'function'
  const hasConfirmed = typeof tx?.getIsConfirmed === 'function'
  if (!hasRelayed && !hasConfirmed) return true
  try {
    return (hasRelayed && tx.getIsRelayed() === true) || (hasConfirmed && tx.getIsConfirmed() === true)
  } catch {
    return false
  }
}

// Distinguish "not enough (unlocked) money" — a retryable balance/lock state —
// from a true hard error (bad address, daemon rejection). monero-wallet's
// messages include "not enough money" / "not enough unlocked money" /
// "failed to get unlocked balance".
function isBalanceError (err) {
  const msg = String((err && err.message) || err).toLowerCase()
  return /not enough.*(money|unlocked)|failed to get unlocked balance|insufficient.*(balance|fund)/.test(msg)
}

// Retryable pre-relay build check: wallet2's create_transactions_2 throws
// "tx not possible" when it cannot gather usable (unlocked) outputs for the
// amount + estimated fee — a spendable-funds/transient condition, not a hard
// config error (observed 2026-09-14 ops sweep and 2026-09-28 payout batch,
// both during network block-time droughts). Used by BOTH the ops-sweep build
// path and the payout bucket path: a pre-relay createTx throw means no tx
// exists, so nothing was broadcast and a retry is double-pay-safe.
function isRetryableTxBuildError (err) {
  const msg = String((err && err.message) || err).toLowerCase()
  return /tx not possible|transaction not possible/.test(msg)
}
