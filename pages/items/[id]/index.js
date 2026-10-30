import Layout from '@/components/layout'
import { ITEM_FULL } from '@/fragments/items'
import ItemFull from '@/components/item-full'
import BountyFundingNotice from '@/components/bounty-funding-notice'
import { getGetServerSideProps } from '@/api/ssrApollo'
import { useQuery } from '@apollo/client/react'
import { useRouter } from 'next/router'
import PageLoading from '@/components/page-loading'
import { CommentsNavigatorProvider } from '@/components/use-comments-navigator'
import { useClearNotesOnView } from '@/components/use-has-new-notes'

export const getServerSideProps = getGetServerSideProps({
  query: ITEM_FULL,
  notFound: data => !data.item || (data.item.status === 'STOPPED' && !data.item.mine)
})

export default function Item ({ ssrData }) {
  const router = useRouter()

  const { data, fetchMore } = useQuery(ITEM_FULL, { variables: { ...router.query } })
  useClearNotesOnView((data || ssrData)?.item?.id)
  if (!data && !ssrData) return <PageLoading />

  const { item } = data || ssrData
  const sub = item.subName || item.root?.subName

  const fetchMoreComments = async () => {
    await fetchMore({ variables: { ...router.query, cursor: item.comments.cursor } })
  }

  return (
    <CommentsNavigatorProvider key={item.id}>
      <Layout sub={sub} item={item}>
        <BountyFundingNotice item={item} />
        <ItemFull item={item} fetchMoreComments={fetchMoreComments} />
      </Layout>
    </CommentsNavigatorProvider>
  )
}
