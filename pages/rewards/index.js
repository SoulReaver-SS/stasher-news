import { gql } from 'graphql-tag'
import Button from 'react-bootstrap/Button'
import { getGetServerSideProps } from '@/api/ssrApollo'
import Layout from '@/components/layout'
import { useQuery } from '@apollo/client/react'
import Link from 'next/link'
import { piconerosToXmr, piconerosToMXmr } from '@/lib/format'
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
import { WEEKLY_CURATOR_CAP_PICONEROS } from '@/lib/rewardsAccounting'

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
  const curatorBudget = BigInt(total) < WEEKLY_CURATOR_CAP_PICONEROS ? BigInt(total) : WEEKLY_CURATOR_CAP_PICONEROS

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
            <p className='text-center text-muted'>
              Up to {piconerosToXmr(curatorBudget)} for curators at the next weekly distribution.
              Remaining funds roll over to the following week.
            </p>
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
