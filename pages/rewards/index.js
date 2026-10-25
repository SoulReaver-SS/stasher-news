import { gql } from 'graphql-tag'
import Button from 'react-bootstrap/Button'
import { getGetServerSideProps } from '@/api/ssrApollo'
import Layout from '@/components/layout'
import { useQuery } from '@apollo/client/react'
import Link from 'next/link'
import { piconerosToXmr, piconerosToMXmr } from '@/lib/format'
import { copyDrawdownWeeks, formatMultiple } from '@/lib/curatorBudgetCopy'
import PageLoading from '@/components/page-loading'
import { useShowModal } from '@/components/modal'
import dynamic from 'next/dynamic'
import { FAST_POLL_INTERVAL_MS, SSR } from '@/lib/constants'
import { Col, Row } from 'react-bootstrap'
import { useData } from '@/components/use-data'
import { GrowthPieChartSkeleton } from '@/components/charts-skeletons'
import { useMemo } from 'react'
import { CompactLongCountdown } from '@/components/countdown'
import { payTypeShortName } from '@/lib/pay-in'
import DonateModal from '@/components/donate-modal'

const GrowthPieChart = dynamic(() => import('@/components/charts').then(mod => mod.GrowthPieChart), {
  loading: () => <GrowthPieChartSkeleton />
})

const REWARDS_FULL = gql`
{
  rewards {
    total
    time
    sources {
      name
      value
    }
  }
  curatorBudget {
    mode
    fallbackBudgetPiconeros
    projectedPiconeros
    multBps
    targetMultBps
    t4Piconeros
    targetPiconeros
    reservePiconeros
    spendLimitPiconeros
    drawdownWeeks
    dynamicBudgetMode
    windingDown
    breakerTripped
  }
}
`

export const getServerSideProps = getGetServerSideProps({ query: REWARDS_FULL })

export function RewardLine ({ total, time, xmr }) {
  return (
    <>
      <span style={{ whiteSpace: 'nowrap' }}>
        {xmr ? piconerosToXmr(BigInt(total), 3) : piconerosToMXmr(BigInt(total))} in rewards pool
      </span>
      {time &&
        <small style={{ whiteSpace: 'nowrap' }}>
          <CompactLongCountdown
            className='text-monospace'
            date={time}
          />
        </small>}
    </>
  )
}

function toBigInt (value) {
  return typeof value === 'bigint' ? value : BigInt(value)
}

export { DEFAULT_DRAWDOWN_WEEKS } from '@/lib/curatorBudgetCopy'

// This week's spending-limit sentence (spec §10, amended 2026-10-21). The
// projection's outcome names the binding cap: FULL — the limit
// sits above the target; DRAWDOWN — the limit binds and sets the effective
// multiple; POOL_SHORT — the pool itself, not the drawdown, is the binding cap.
export function limitSentence (budget) {
  if (budget?.spendLimitPiconeros == null || budget?.projectedPiconeros == null) return null
  const limit = piconerosToXmr(toBigInt(budget.spendLimitPiconeros))
  if (budget.dynamicBudgetMode === 'POOL_SHORT') {
    return `the pool itself bounds this week's spending to ${piconerosToXmr(toBigInt(budget.projectedPiconeros))}`
  }
  if (budget.dynamicBudgetMode === 'DRAWDOWN') {
    return `the pool can spend up to ${limit} this week (income plus 1/${copyDrawdownWeeks(budget)} of its reserve), ` +
      `so the multiple is ${formatMultiple(budget.multBps) ?? '0×'}`
  }
  return `the pool can spend up to ${limit} this week, more than the budget needs`
}

export function CuratorBudgetCopy ({ budget }) {
  const mode = budget?.mode ?? 'LEGACY'
  const fallback = toBigInt(budget?.fallbackBudgetPiconeros ?? 0)
  const projected = budget?.projectedPiconeros
  // The EFFECTIVE multiple only. When T4 = 0 the budget is 0 and no effective
  // multiple exists (0/0) — render 0×, never the configured target k.
  const multiple = formatMultiple(budget?.multBps) ?? '0×'

  if (mode === 'ACTIVE' && projected != null) {
    const multipleText = budget.windingDown ? `${multiple}: pool winding down` : `${multiple} recent curator tips`
    return (
      <>
        <p className='text-center text-muted mb-0'>
          Projected curator budget this week: {piconerosToXmr(toBigInt(projected))}
          {multipleText && <span> ({multipleText})</span>}
        </p>
        <p className='text-center text-muted'>
          <small>
            {budget.t4Piconeros != null && <>T4 {piconerosToXmr(toBigInt(budget.t4Piconeros))} · </>}
            {limitSentence(budget)}
          </small>
          <br />
          <small><small>This is a projection; it is final at Monday 00:00 UTC.</small></small>
        </p>
      </>
    )
  }

  let shadowLine = null
  if (mode === 'SHADOW' && projected != null) {
    shadowLine = `Under the proposed dynamic budget this would be about ${piconerosToXmr(toBigInt(projected))}` +
      ` (${multiple} recent curator tips).`
  }

  return (
    <>
      <p className='text-center text-muted'>
        Up to {piconerosToXmr(fallback)} for curators at the next weekly distribution.
        Remaining funds roll over to the following week.
      </p>
      {shadowLine && (
        <p className='text-center text-muted fst-italic mb-0'>
          <small>{shadowLine}</small>
        </p>
      )}
      {mode === 'ACTIVE' && (
        <p className='text-center text-muted mb-0'>
          <small>The live projection is temporarily unavailable, please check back shortly. Payouts are unaffected: curators receive the dynamic budget calculated at Monday's distribution, or the fallback cap above only if that calculation cannot run.</small>
        </p>
      )}
    </>
  )
}

export default function Rewards ({ ssrData }) {
  // only poll for updates to rewards
  const { data } = useQuery(
    REWARDS_FULL,
    SSR ? {} : { pollInterval: FAST_POLL_INTERVAL_MS, nextFetchPolicy: 'cache-and-network' })
  const dat = useData(data, ssrData)

  const { rewards: [{ total, sources, time }] } = useMemo(() => {
    if (!dat || !dat.rewards[0]) return { rewards: [{ total: 0, sources: [], time: '0' }] }
    return {
      rewards: [{
        total: dat.rewards[0].total,
        sources: dat.rewards[0].sources.map(source => ({ name: payTypeShortName(source.name), value: Number(source.value) })),
        time: dat.rewards[0].time
      }]
    }
  }, [dat])

  if (!dat) return <PageLoading />

  return (
    <Layout footerLinks>
      <Row className='pb-3'>
        <Col>
          <div
            className='d-flex flex-column sticky-lg-top py-5'
          >
            <h3 className='text-center text-muted'>
              <div>
                <RewardLine total={total} time={time} />
              </div>
              <Link href='/faq#how-do-i-earn-xmr-on-stasher-news' className='text-info fw-normal'>
                <small><small><small>learn about rewards</small></small></small>
              </Link>
              <span className='text-muted mx-2'>·</span>
              <Link href='/transparency' className='text-info fw-normal'>
                <small><small><small>wallet transparency</small></small></small>
              </Link>
            </h3>
            <CuratorBudgetCopy budget={dat.curatorBudget} />
            {sources?.length > 0 &&
              <div className='my-3 w-100'>
                <GrowthPieChart data={sources} />
              </div>}
            <DonateButton />
          </div>
        </Col>
      </Row>
    </Layout>
  )
}

export function DonateButton () {
  const showModal = useShowModal()

  return (
    <Button
      className='align-self-center'
      onClick={() => showModal(onClose => <DonateModal onClose={onClose} />)}
    >DONATE TO REWARDS
    </Button>
  )
}
