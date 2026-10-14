import Item from './item'
import ItemJob from './item-job'
import ItemAddendum from './item-addendum'
import Reply from './reply'
import Comment from './comment'
import Text, { SearchText } from './text'
import { MediaOrLink } from '@/components/editor/nodes/media'
import Comments from './comments'
import styles from '@/styles/item.module.css'
import itemStyles from './item.module.css'
import { useMe } from './me'
import Button from 'react-bootstrap/Button'
import { useEffect } from 'react'
import Poll from './poll'
import Related from './related'
import PastBounties from './past-bounties'
import Check from '@/svgs/check-double-line.svg'
import Share from './share'
import Toc from './table-of-contents'
import { RootProvider } from './root'
import { decodeProxyUrl, IMGPROXY_URL_REGEXP, parseEmbedUrl } from '@/lib/url'
import { piconerosToMXmr } from '@/lib/format'
import { bountyPiconerosOf, bountyStatusWord } from '@/lib/bounty'
import BountyActions from './bounty-actions'
import { useQuoteReply } from './use-quote-reply'
import { UNKNOWN_LINK_REL, DEFAULT_POSTS_PICONEROS_FILTER } from '@/lib/constants'
import { moneroWallTeaserFadeClass } from '@/lib/monero-wall'
import classNames from 'classnames'
import { CarouselProvider } from './carousel'
import Embed from './embed'
import { XPreviewCard } from './x-preview'
import useCommentsView from './use-comments-view'
import useCallbackRef from './use-callback-ref'
import MoneroWallPanel from './monero-wall'
import MoneroWallRating from './monero-wall-rating'
import { LockedReply, LockedComments } from './locked-comments'

function BioItem ({ item, handleClick }) {
  const { me } = useMe()
  const { onRef: onReaderRef } = useCallbackRef()
  if (!item.text) {
    return null
  }

  return (
    <>
      <ItemText item={item} readerRef={onReaderRef} />
      {me?.name === item.user.name &&
        <div className='d-flex'>
          <Button
            className='ms-auto'
            onClick={handleClick}
            size='md' variant='link'
          >edit bio
          </Button>
        </div>}
      <Reply item={item} />
    </>
  )
}

function ItemEmbed ({ url, imgproxyUrls }) {
  const provider = parseEmbedUrl(url)
  // X previews render once at the item level next to the body — a card here
  // would duplicate a body-derived card or show an empty faux preview when
  // no metadata was fetched
  if (provider?.provider === 'twitter') return null
  if (provider) {
    return (
      <div className='mt-3'>
        <Embed src={url} {...provider} topLevel />
      </div>
    )
  }

  if (imgproxyUrls) {
    const src = IMGPROXY_URL_REGEXP.test(url) ? decodeProxyUrl(url) : url
    const srcSet = imgproxyUrls?.[url]
    return (
      <div className='mt-3'>
        <MediaOrLink src={src} srcSetIntital={srcSet} topLevel linkFallback={false} />
      </div>
    )
  }

  return null
}

function TopLevelItem ({ item, noReply, ...props }) {
  const { me } = useMe()
  const ItemComponent = item.isJob ? ItemJob : Item
  const { ref: readerRef, onRef: onReaderRef } = useCallbackRef()
  const { ref: addendumReaderRef, onRef: onAddendumReaderRef } = useCallbackRef()
  const { ref: textRef, quote, quoteReply, cancelQuote } = useQuoteReply({ text: item.text, readerRef, additionalReaderRefs: [addendumReaderRef] })
  const postsPiconerosFilter = me ? me.privates?.postsPiconerosFilter : DEFAULT_POSTS_PICONEROS_FILTER
  const isBelowFilter = !item.mine && postsPiconerosFilter != null && (item.netInvestment ?? 0) < postsPiconerosFilter

  return (
    <ItemComponent
      item={item}
      full
      onQuoteReply={quoteReply}
      right={
        !noReply &&
          <>
            <Toc text={item.text} readerRef={readerRef} />
            <Share title={item?.title} path={`/items/${item?.id}`} />
          </>
      }
      {...props}
    >
      <article className={classNames(styles.fullItemContainer, 'topLevel')} ref={textRef}>
        {item.text && <ItemText item={item} readerRef={onReaderRef} />}
        {!item.bio && !isBelowFilter && item.xPreview &&
          <div className='mt-3'>
            <XPreviewCard xPreview={item.xPreview} url={item.url} showImage={me?.privates?.showImagesAndVideos !== false} />
          </div>}
        {/* outside the item.text gate: a bodyless link/poll can carry an addendum */}
        {!item.bio && <ItemAddendum item={item} topLevel readerRef={onAddendumReaderRef} />}
        <MoneroWallPanel item={item} />
        <MoneroWallRating item={item} />
        {item.url && !isBelowFilter && <ItemEmbed url={item.url} imgproxyUrls={item.imgproxyUrls} />}
        {item.poll && <Poll item={item} />}
        {item.bounty &&
          <div className='fw-bold mt-2'>
            {item.bountyPaidTo?.length
              ? (
                <div className='px-3 py-1 d-inline-block bg-grey-medium rounded text-success'>
                  <Check className='fill-success' /> {piconerosToMXmr(BigInt(item.bounty) * 1000n)} paid
                  {item.bountyPaidTo.length > 1 && <small className='fw-light'> {new Set(item.bountyPaidTo).size} times</small>}
                </div>)
              : (
                <div className='px-3 py-1 d-inline-block bg-grey-darkmode rounded text-light'>
                  {piconerosToMXmr(BigInt(item.bounty) * 1000n)} bounty
                </div>)}
          </div>}
        {Number(item.bountyPiconeros) > 0 &&
          <div className='fw-bold mt-2'>
            <div className='px-3 py-1 d-inline-block bg-grey-darkmode rounded text-light'>
              {piconerosToMXmr(bountyPiconerosOf(item.bountyPiconeros))} bounty · {bountyStatusWord(item.bountyStatus)}
            </div>
          </div>}
      </article>
      {item.mine && item.bountyStatus === 'EXPIRED' && <BountyActions item={item} />}
      {/* The locked composer is decorative; the real submission form only
          mounts after unlocking. The server also enforces participation. */}
      {!noReply &&
        <>
          {item.moneroWall?.commentsLocked
            ? <LockedReply />
            : (
              <Reply
                item={item}
                replyOpen
                onCancelQuote={cancelQuote}
                onQuoteReply={quoteReply}
                quote={quote}
              />
              )}
          {
          // Don't show related items for Saloon items (position is set but no subName)
          (!item.position && item.subNames?.length > 0) &&
          // Don't show related items for jobs
          !item.isJob &&
          // Don't show related items for child items
          !item.parentId &&
          // Don't show related items for deleted items
          !item.deletedAt &&
          // Don't show related items for items with bounties, show past bounties instead
          !(item.bounty > 0) &&
            <Related title={item.title} itemId={item.id} show={item.ncomments === 0} />
          }
          {item.bounty > 0 && <PastBounties item={item} />}
        </>}
    </ItemComponent>
  )
}

function ItemText ({ item, readerRef }) {
  return item.searchText
    ? <SearchText text={item.searchText} />
    : <Text className={moneroWallTeaserFadeClass(item)} itemId={item.id} state={item.lexicalState} html={item.html} topLevel rel={item.rel ?? UNKNOWN_LINK_REL} imgproxyUrls={item.imgproxyUrls} readerRef={readerRef} />
}

export default function ItemFull ({ item, fetchMoreComments, bio, rank, ...props }) {
  // no cache update here because we need to preserve the initial value
  const { markItemViewed } = useCommentsView(item.id, { updateCache: false })

  useEffect(() => {
    markItemViewed(item)
  }, [item.id, markItemViewed])

  return (
    <>
      {rank
        ? (
          <div className={`${itemStyles.rank} pt-2 align-self-start`}>
            {rank}
          </div>)
        : <div />}
      <RootProvider root={item.root || item}>
        <CarouselProvider key={item.id}>
          {item.parentId
            ? <Comment topLevel item={item} replyOpen includeParent noComments {...props} />
            : (
              <div className='pt-2'>{bio
                ? <BioItem item={item} {...props} />
                : <TopLevelItem item={item} {...props} />}
              </div>)}
          {item.moneroWall?.commentsLocked
            ? <LockedComments count={item.ncomments} />
            : item.comments &&
              <div className={styles.comments}>
                <Comments
                  parentId={item.id} parentCreatedAt={item.createdAt}
                  pinned={item.position} bio={bio}
                  commentSats={item.commentPiconeros} commentCost={item.commentCost} commentBoost={item.commentBoost}
                  ncomments={item.ncomments}
                  comments={item.comments.comments}
                  commentsCursor={item.comments.cursor}
                  fetchMoreComments={fetchMoreComments}
                  lastCommentAt={item.lastCommentAt}
                  item={item}
                />
              </div>}
        </CarouselProvider>
      </RootProvider>
    </>
  )
}
