import { gql } from 'graphql-tag'
import { Col, Row } from 'react-bootstrap'
import { getGetServerSideProps } from '@/api/ssrApollo'
import Layout from '@/components/layout'
import CopyChip from '@/components/copy-chip'
import PageLoading from '@/components/page-loading'
import { useQuery } from '@apollo/client/react'
import { useData } from '@/components/use-data'
import { SSR, FAST_POLL_INTERVAL_MS } from '@/lib/constants'
import { piconerosToXmr } from '@/lib/format'
import { copyDrawdownWeeks, formatMultiple } from '@/lib/curatorBudgetCopy'
import { CURATOR_FALLBACK_CAP_PICONEROS } from '@/lib/rewardsAccounting'

const REWARDS_WALLET = gql`
  query rewardsWalletInfo {
    rewardsWalletInfo {
      address
      viewKey
      network
      totalReceivedPiconeros
      totalSentPiconeros
      totalNetworkFeesPiconeros
      balancePiconeros
      balanceXmr
      balanceNeedsReconciliation
      accountingUncertain
      reconciliationCheckedAt
      reconciliationEvidenceCurrent
      outstandingRewardsPiconeros
      opsDeficitPiconeros
      nextPoolPiconeros
      pendingSweepPiconeros
      inflowBreakdown {
        downvotePiconeros
        postingFeePiconeros
        territoryFeePiconeros
        walletlessTipPiconeros
        totalPiconeros
        rewardsPiconeros
        opsPiconeros
        downvoteRewardsPct
        postingFeeRewardsPct
        territoryFeeRewardsPct
        walletlessTipRewardsPct
      }
    }
    curatorBudget {
      mode
      fallbackBudgetPiconeros
      targetMultBps
      drawdownWeeks
    }
    rewardDistributions(limit: 10) {
      id
      periodStart
      periodEnd
      poolPiconeros
      distributedPiconeros
      rolledOverPiconeros
      payoutCount
      status
      completedAt
      opsInflowPiconeros
      opsAvailablePiconeros
      opsSweptPiconeros
      opsNetworkFeesAccountedPiconeros
      correctedPendingOpsPiconeros
      opsSweepTxHash
      opsSweepState
      rawTipPiconeros
      trustedTipPiconeros
      tipperCount
      breakerTripped
      breakerRawTPiconeros
      makeupPiconeros
      incomePiconeros
      tipT4Piconeros
      incomeF4Piconeros
      reservePiconeros
      spendLimitPiconeros
      multBps
      dynamicBudgetPiconeros
      dynamicBudgetMode
      curatorBudgetMode
      appliedCuratorBudgetPiconeros
      eligibleTipStages
      payouts {
        id
        curatorId
        curatorNym
        piconeros
        amountXmr
        txHash
        state
      }
    }
  }
`

export const getServerSideProps = getGetServerSideProps({ query: REWARDS_WALLET })

function explorerFor (network) {
  return network === 'MAINNET' ? 'https://xmrchain.net/' : 'https://stagenet.xmrchain.net/'
}

function explorerTxUrl (network) {
  return network === 'MAINNET' ? 'https://xmrchain.net/tx/' : 'https://stagenet.xmrchain.net/tx/'
}

// GraphQL BigInt serializes safe integers as JS Numbers, so wire values may
// arrive as number, string, or bigint; normalize at the view boundary.
function toBigInt (v) {
  return typeof v === 'bigint' ? v : BigInt(v)
}

function xmrOrDash (value) {
  return value == null ? '—' : piconerosToXmr(toBigInt(value))
}

// The distribution table renders a missing multiple as a dash.
function formatMultipleOrDash (multBps) {
  return formatMultiple(multBps) ?? '—'
}

export { DEFAULT_DRAWDOWN_WEEKS } from '@/lib/curatorBudgetCopy'

// The per-run spending limit. Backfilled history (and pre-feature rows) never
// recorded budget fields — show that plainly instead of inventing a figure.
export function spendLimitLabel (spendLimitPiconeros, hasRecordedBudget) {
  if (!hasRecordedBudget) return 'not recorded'
  return xmrOrDash(spendLimitPiconeros)
}

function stageXmr (stages, key) {
  const value = stages?.[key]
  return value == null ? null : piconerosToXmr(toBigInt(value))
}

const DISTRIBUTION_STAGE_ROWS = [
  ['raw', 'Raw tips'],
  ['eligible', 'Eligible tips'],
  ['afterExclusions', 'After exclusions'],
  ['ranked', 'Ranked'],
  ['handicapped', 'Founder handicap'],
  ['trusted', 'Trust weighted'],
  ['capped', 'Per-tipper cap'],
  ['final', 'Final T']
]

function opsSweepLabel (state) {
  switch (state) {
    case 'SWEPT': return 'swept to ops wallet'
    case 'SKIPPED_LOCKED': return 'deferred (locked change)'
    case 'FAILED': return 'sweep failed (rolls over)'
    case 'NOT_SWEEPED': return 'not swept (rolls over)'
    default: return 'not swept'
  }
}

function WalletField ({ label, value }) {
  return (
    <div className='d-flex flex-column my-2'>
      <span className='text-muted fw-bold'>{label}</span>
      <span className='text-monospace text-break'>
        <CopyChip value={value}>{value}</CopyChip>
      </span>
    </div>
  )
}

function Stat ({ label, value, sub }) {
  return (
    <div className='d-flex flex-column my-2'>
      <span className='text-muted'>{label}</span>
      <span className='text-monospace'>{value}</span>
      {sub && <small className='text-muted'>{sub}</small>}
    </div>
  )
}

export default function Transparency ({ ssrData }) {
  const { data } = useQuery(
    REWARDS_WALLET,
    SSR ? {} : { pollInterval: FAST_POLL_INTERVAL_MS, nextFetchPolicy: 'cache-and-network' })
  const dat = useData(data, ssrData)

  if (!dat) return <PageLoading />
  const w = dat.rewardsWalletInfo
  const pi = w.inflowBreakdown
  const dists = dat.rewardDistributions || []
  const budget = dat.curatorBudget
  const isDynamicBudget = budget?.mode === 'ACTIVE'
  const targetMultiple = budget?.targetMultBps == null ? '1.5×' : formatMultipleOrDash(budget.targetMultBps)

  return (
    <Layout footerLinks>
      <Row className='justify-content-center py-5'>
        <Col lg={8} xs={12}>
          <h2 className='text-center text-muted'>Rewards Wallet Transparency</h2>
          <p className='text-center text-muted pb-4'>
            The platform rewards wallet is StasherNews's only custodial component.
            Downvotes, posting fees, and territory fees land here and fund weekly
            curator payouts. Audit it independently — the public view key is published by design.
          </p>

          <div className='mb-4'>
            <WalletField label='Address' value={w.address} />
            <WalletField label='Public view key' value={w.viewKey} />
            <Stat label='Network' value={w.network} />
          </div>

          <h4 className='text-muted'>Live balance</h4>
          <p className='text-muted'>
            <small>
              Received, external principal, network fees, and balance are
              ledger-derived from the platform's own records: confirmed eligible
              receipts in, recorded payout and ops-sweep principal out, and the
              actual hot-wallet transaction fees as their own cost line.
              Balance = received − external principal − network fees. The public
              view key is the wallet address's embedded key and is shown for
              reference; it cannot decode transaction amounts, so on-chain
              totals are reconciled against the address.
            </small>
          </p>
          <div className='d-flex flex-wrap justify-content-between border-bottom border-top py-3 my-2'>
            <Stat label='Balance' value={`${w.balanceXmr} XMR`} sub={`${w.balancePiconeros} piconeros — received minus principal minus network fees`} />
            <Stat label='Total received' value={piconerosToXmr(toBigInt(w.totalReceivedPiconeros))} sub='confirmed eligible receipts (ledger)' />
            <Stat label='Total sent' value={piconerosToXmr(toBigInt(w.totalSentPiconeros))} sub='external principal — payouts + ops sweeps' />
            <Stat label='Network fees' value={piconerosToXmr(toBigInt(w.totalNetworkFeesPiconeros))} sub='actual hot-wallet costs; paid by ops' />
            <Stat label='Rewards still owed' value={piconerosToXmr(toBigInt(w.outstandingRewardsPiconeros))} sub='allocated full rewards not yet delivered' />
          </div>
          {w.balanceNeedsReconciliation && (
            <div className='alert alert-warning mt-3 mb-0'>
              Wallet balance needs reconciliation
            </div>
          )}
          {toBigInt(w.opsDeficitPiconeros) > 0n && (
            <div className='alert alert-warning mt-3 mb-0'>
              Ops debt is unfunded by {piconerosToXmr(toBigInt(w.opsDeficitPiconeros))} — hot-wallet
              network fees and sweeps exceed the ops earmark
            </div>
          )}
          {w.accountingUncertain && (
            <div className='alert alert-warning mt-3 mb-0'>
              Rewards wallet accounting is uncertain: unresolved journal attempts or
              conflicting ledger facts. The figures above may be incomplete.
            </div>
          )}
          <small className='text-muted d-block mt-2'>
            {w.reconciliationEvidenceCurrent
              ? `Ledger facts match the latest published reconciliation check (${new Date(w.reconciliationCheckedAt).toLocaleString()}).`
              : w.reconciliationCheckedAt
                ? `The latest published reconciliation check (${new Date(w.reconciliationCheckedAt).toLocaleString()}) no longer matches the current ledger; it does not clear a known discrepancy.`
                : 'No full-wallet reconciliation check has been published yet.'}
          </small>

          <h4 className='text-muted mt-4'>Current allocation</h4>
          <p className='text-muted'>
            <small>
              The wallet holds one consolidated balance. The two figures below are
              what it is literally allocated to right now: the full rewards pool,
              including funds held for future weeks, and the platform's share — unswept from
              the last distribution (after proven sweeps and real network fees) plus
              this week's accrual — awaiting its sweep to the ops wallet. They are
              literal allocations, not a pro-rata slice of the balance; a negative
              ops figure is unfunded debt, not free cash.{' '}
              {isDynamicBudget
                ? (
                  <>
                    Weekly curator payouts follow the dynamic budget: about {targetMultiple} recent
                    eligible curator tips; when the reserve runs low, spending is limited to the
                    pool's income plus 1/{copyDrawdownWeeks(budget)} of its reserve each week, so
                    payouts slide gradually toward income instead of stopping; referral payouts
                    may be additional, limited by the remaining pool.
                    All unused rewards roll over.
                  </>
                  )
                : (
                  <>
                    Weekly curator payouts are capped at {piconerosToXmr(CURATOR_FALLBACK_CAP_PICONEROS)};
                    referral payouts may be additional, limited by the remaining pool.
                    All unused rewards roll over.
                  </>
                  )}
              {' '}The ops sweep has no weekly amount cap; network fees are paid by ops.
            </small>
          </p>
          <div className='d-flex flex-wrap justify-content-between border-bottom border-top py-3 my-2'>
            <Stat
              label='Rewards allocation'
              value={piconerosToXmr(toBigInt(w.nextPoolPiconeros))}
              sub={isDynamicBudget
                ? 'full pool — weekly dynamic curator budget applies; excess rolls over'
                : 'full pool — weekly curator cap applies; excess rolls over'}
            />
            <Stat label='Ops allocation' value={piconerosToXmr(toBigInt(w.pendingSweepPiconeros))} sub='unswept from the last distribution + accruing this week' />
          </div>

          <h4 className='text-muted mt-4'>Confirmed inflow by source (all-time)</h4>
          <p className='text-muted'>
            <small>
              Every confirmed inflow since the wallet opened, split by its
              allocation percentage. The rewards and ops shares below are cumulative
              splits of that all-time inflow — not the current allocations shown
              above.
            </small>
          </p>
          <div className='d-flex flex-wrap justify-content-between border-bottom border-top py-3 my-2'>
            <Stat label='Downvotes' value={piconerosToXmr(toBigInt(pi.downvotePiconeros))} sub={`${pi.downvoteRewardsPct}% to rewards`} />
            <Stat label='Posting fees' value={piconerosToXmr(toBigInt(pi.postingFeePiconeros))} sub={`${pi.postingFeeRewardsPct}% to rewards`} />
            <Stat label='Turf fees' value={piconerosToXmr(toBigInt(pi.territoryFeePiconeros))} sub={`${pi.territoryFeeRewardsPct}% to rewards`} />
            <Stat label='Wallet-less tips' value={piconerosToXmr(toBigInt(pi.walletlessTipPiconeros))} sub={`${pi.walletlessTipRewardsPct}% to rewards`} />
          </div>
          <div className='d-flex flex-wrap justify-content-between py-3 my-2'>
            <Stat label='Total inflow' value={piconerosToXmr(toBigInt(pi.totalPiconeros))} sub='all-time' />
            <Stat label='Rewards share' value={piconerosToXmr(toBigInt(pi.rewardsPiconeros))} sub='all-time cumulative split' />
            <Stat label='Ops share' value={piconerosToXmr(toBigInt(pi.opsPiconeros))} sub='all-time cumulative split' />
          </div>

          <h4 className='text-muted mt-4'>Distribution log</h4>
          <p className='text-muted'>
            <small>
              Recent weekly curator distributions. Each payout is a real on-chain
              Monero transaction from the rewards wallet — verify any tx hash on
              the explorer. Curator handles are shown as nyms; sub-threshold
              shares and {isDynamicBudget ? 'unused dynamic budget' : 'funds above the weekly curator cap'} roll over (less any
              additional referral payouts). The ops allocation is swept to
              the ops wallet when the hot wallet has enough unlocked change; when
              it doesn't (recent incoming outputs are still locked), the sweep is
              deferred and the unswept amount rolls into next week's opsAvailable
              — adjusted for proven sweeps and the real network fees paid in that
              period, bounded by the next period's fee checkpoint (only the active
              period uses the cumulative total). The adjusted carry is an updated
              snapshot of each period, while the "Ops allocation" figure above is
              the one current allocation.
            </small>
          </p>
          {dists.length === 0
            ? (
              <div className='border-bottom border-top py-3 my-2'>
                <Stat label='No distributions yet' value='—' sub='the first weekly run will appear here' />
              </div>
              )
            : (
              <div className='border-bottom border-top py-3 my-2'>
                {dists.map((d, di) => {
                  const stages = d.eligibleTipStages
                  const backfilled = stages?.backfilled === true
                  // Backfill never writes budget fields, so a recorded spending
                  // limit marks a live run. multBps alone cannot gate this: a
                  // T4 = 0 run legitimately records a NULL (0÷0) effective
                  // multiple next to a real limit.
                  const hasRecordedBudget = !backfilled && d.spendLimitPiconeros != null
                  const makeup = d.makeupPiconeros == null ? 0n : toBigInt(d.makeupPiconeros)
                  return (
                    <div key={d.id} className={di < dists.length - 1 ? 'mb-4 pb-3 border-bottom' : ''}>
                      <div className='d-flex flex-wrap justify-content-between'>
                        <Stat
                          label={`Distribution #${d.id} — ${d.status}`}
                          value={`${d.payoutCount} payout${d.payoutCount === 1 ? '' : 's'}`}
                          sub={`${new Date(d.periodStart).toLocaleDateString()} → ${new Date(d.periodEnd).toLocaleDateString()}`}
                        />
                        <Stat label='Pool' value={piconerosToXmr(toBigInt(d.poolPiconeros))} />
                        <Stat label='Distributed' value={piconerosToXmr(toBigInt(d.distributedPiconeros))} />
                        <Stat label='Rolled over' value={piconerosToXmr(toBigInt(d.rolledOverPiconeros))} />
                      </div>
                      {d.trustedTipPiconeros != null && (
                        <>
                          <div className='d-flex flex-wrap justify-content-between align-items-start ms-2 mt-1'>
                            <Stat label='Raw tips' value={xmrOrDash(d.rawTipPiconeros)} sub='before eligibility filters' />
                            <Stat
                              label='Eligible T (final)'
                              value={xmrOrDash(d.trustedTipPiconeros)}
                              sub={backfilled ? 'backfilled from recorded history' : 'after exclusions, caps and breaker'}
                            />
                            <Stat label='Tippers' value={d.tipperCount ?? '—'} />
                            <Stat label='T4' value={xmrOrDash(d.tipT4Piconeros)} sub='four-week average eligible tips' />
                            <Stat label='I4' value={xmrOrDash(d.incomeF4Piconeros)} sub='four-week median pool income' />
                            <Stat
                              label='Spend limit'
                              value={spendLimitLabel(d.spendLimitPiconeros, hasRecordedBudget)}
                              sub={hasRecordedBudget ? `reserve ${xmrOrDash(d.reservePiconeros)} at this run` : 'not recorded'}
                            />
                            <Stat label='m' value={formatMultipleOrDash(d.multBps)} sub='this run' />
                            <Stat label='Dynamic budget' value={xmrOrDash(d.dynamicBudgetPiconeros)} />
                            <Stat label='Applied budget' value={xmrOrDash(d.appliedCuratorBudgetPiconeros)} sub={d.curatorBudgetMode ?? '—'} />
                            <Stat label='Mode' value={d.curatorBudgetMode ?? '—'} sub={d.dynamicBudgetMode ?? undefined} />
                          </div>
                          {(d.breakerTripped || makeup > 0n) && (
                            <div className='ms-2 mt-1'>
                              {d.breakerTripped && (
                                <small className='text-warning d-block'>
                                  breaker tripped (raw {xmrOrDash(d.breakerRawTPiconeros)}, capped {xmrOrDash(d.trustedTipPiconeros)})
                                </small>
                              )}
                              {makeup > 0n && (
                                <small className='text-muted d-block'>
                                  {d.curatorBudgetMode === 'ACTIVE'
                                    ? `make-up included in this run's dynamic target: +${piconerosToXmr(makeup)} (the target is bounded by the pool and paid shares; not a record of delivery)`
                                    : `hypothetical make-up not applied in ${d.curatorBudgetMode ?? 'LEGACY'} mode: +${piconerosToXmr(makeup)}`}
                                </small>
                              )}
                            </div>
                          )}
                          {stages && (
                            <details className='ms-2 mt-1'>
                              <summary><small className='text-muted'>Eligible-T stage breakdown</small></summary>
                              <div className='d-flex flex-wrap justify-content-between align-items-start mt-1'>
                                {DISTRIBUTION_STAGE_ROWS.map(([key, label]) => {
                                  const value = stageXmr(stages, key)
                                  return value == null ? null : <Stat key={key} label={label} value={value} />
                                })}
                              </div>
                              <small className='text-muted d-block'>
                                Totals only; no individual tipper identities are published.
                                {backfilled ? ' Backfilled from recorded history at release.' : ''}
                              </small>
                              {stages.staleTrustFallback === true && (
                                <small className='text-muted d-block'>Stale trust: the previous recorded T was reused.</small>
                              )}
                              {stages.breakerArmed === true && stages.breakerThreshold != null && (
                                <small className='text-muted d-block'>Breaker threshold {stageXmr(stages, 'breakerThreshold')}.</small>
                              )}
                            </details>
                          )}
                        </>
                      )}
                      <div className='d-flex flex-wrap justify-content-between align-items-start ms-2 mt-1'>
                        <Stat label='Ops inflow' value={piconerosToXmr(toBigInt(d.opsInflowPiconeros))} sub="this period's ops share" />
                        <Stat label='Ops swept' value={piconerosToXmr(toBigInt(d.opsSweptPiconeros))} sub={`ops sweep: ${opsSweepLabel(d.opsSweepState)}`} />
                        <Stat label='Fees accounted' value={piconerosToXmr(toBigInt(d.opsNetworkFeesAccountedPiconeros))} sub='hot-wallet fees inside this snapshot' />
                        <Stat
                          label='Pending ops (adjusted)'
                          value={piconerosToXmr(toBigInt(d.correctedPendingOpsPiconeros))}
                          sub={toBigInt(d.correctedPendingOpsPiconeros) < 0n
                            ? "unfunded — fees and sweeps exceed this period's ops earmark"
                            : d.opsSweepState === 'SKIPPED_LOCKED'
                              ? 'deferred — locked change, lands next period'
                              : 'after proven sweeps and network fees'}
                        />
                      </div>
                      {d.opsSweepTxHash && (
                        <div className='ms-2 mt-1'>
                          {d.opsSweepTxHash.split(',').map((h, i) => (
                            <a key={h} href={`${explorerTxUrl(w.network)}${h}`} target='_blank' rel='noreferrer' className='d-block'>
                              <small className='text-monospace text-break text-decoration-none'>
                                {i === 0 ? 'ops sweep' : 'sweep'} tx: {h.slice(0, 24)}…
                              </small>
                            </a>
                          ))}
                        </div>
                      )}
                      {di === 0 && d.payouts.length > 0 && (
                        <div className='ms-2 mt-2'>
                          <small className='text-muted fw-bold d-block mb-1'>Payouts (latest distribution):</small>
                          {d.payouts.map(p => (
                            <div key={p.id} className='d-flex flex-column mb-1'>
                              <span className='text-monospace'>
                                {p.curatorNym || `user #${p.curatorId}`} — {p.amountXmr} XMR — {p.state}
                              </span>
                              {p.txHash && (
                                <a href={`${explorerTxUrl(w.network)}${p.txHash}`} target='_blank' rel='noreferrer'>
                                  <small className='text-monospace text-break text-decoration-none'>{p.txHash.slice(0, 24)}…</small>
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              )}

          <div className='alert alert-light mt-4'>
            <h6>Verify independently</h6>
            <p className='mb-1'>
              The wallet address is public and totals can be checked against the
              chain. The public view key above is embedded in that address and
              cannot decode incoming transaction amounts; independent
              transaction-level auditing would require the private view key,
              which the platform does not publish.
            </p>
            <p className='mb-0'>
              <a href={explorerFor(w.network)} target='_blank' rel='noreferrer'>
                Open the {w.network.toLowerCase()} explorer
              </a>
              <span className='text-muted'> · 1 XMR = 1,000,000,000,000 piconeros</span>
            </p>
          </div>
        </Col>
      </Row>
    </Layout>
  )
}
