import Link from 'next/link'
import styles from './item.module.css'
import UpVote from './upvote'
import VoteColumn from './vote-column'
import { useRef } from 'react'
import { UNKNOWN_LINK_REL } from '@/lib/constants'
import Pin from '@/svgs/pushpin-fill.svg'
import reactStringReplace from 'react-string-replace'
import PollIcon from '@/svgs/bar-chart-horizontal-fill.svg'
import BountyIcon from '@/svgs/bounty-bag.svg'
import ActionTooltip from './action-tooltip'
import ImageIcon from '@/svgs/image-fill.svg'
import VideoIcon from '@/svgs/video-on-fill.svg'
import { piconerosToMXmr } from '@/lib/format'
import ItemInfo from './item-info'
import { CardMedia, hasVideoUpload } from './card-media'
import { XPreviewCard } from './x-preview'
import { commentsViewedAt } from '@/lib/new-comments'
import { useRouter } from 'next/router'
import { timeLeft } from '@/lib/time'
import classNames from 'classnames'
import removeMd from 'remove-markdown'
import { decodeProxyUrl, IMGPROXY_URL_REGEXP, parseInternalLinks, parseEmbedUrl, removeYoutubeTracking } from '@/lib/url'
import { canonicalXStatus } from '@/lib/x-preview/status-url'
import Embed from './embed'
import { privacyUrls } from '@/lib/privacy'
import ItemPopover from './item-popover'
import Boost from './boost-button'
import MoneroWallRatingBadge from './monero-wall-rating-badge'
import { useMe } from './me'
import { SearchText } from './text'

export function onItemClick (e, router, item) {
  const viewedAt = commentsViewedAt(item.id)
  if (viewedAt) {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      window.open(
        `/items/${item.id}`,
        '_blank',
        'noopener,noreferrer'
      )
    } else {
      router.push(
        `/items/${item.id}?commentsViewedAt=${viewedAt}`,
        `/items/${item.id}`)
    }
  }
}

export function SearchTitle ({ title }) {
  return reactStringReplace(title, /\*\*\*([^*]+)\*\*\*/g, (match, i) => {
    return <mark key={`strong-${match}-${i}`}>{match}</mark>
  })
}

function mediaType ({ url, imgproxyUrls }) {
  const { me } = useMe()
  // `url &&` guard: with NEXT_PUBLIC_IMGPROXY_URL unset (e.g. CI) the regexp
  // degenerates to /^undefined.*$/, which matches the string "undefined" that
  // RegExp.test(undefined) coerces to — crashing decodeProxyUrl on non-string urls
  const src = url && IMGPROXY_URL_REGEXP.test(url) ? decodeProxyUrl(url) : url
  if (!imgproxyUrls?.[src] ||
    me?.privates?.showImagesAndVideos === false ||
    // we don't proxy videos even if we have thumbnails
    (me?.privates?.imgproxyOnly && imgproxyUrls?.[src]?.video)) return
  return imgproxyUrls?.[src]?.video ? 'video' : 'image'
}

function ItemLink ({ url, rel }) {
  try {
    url = removeYoutubeTracking(url)
    const { linkText } = parseInternalLinks(url)
    if (linkText) {
      return (
        <ItemPopover id={linkText.replace('#', '').split('/')[0]}>
          <Link href={url} className={styles.link}>{linkText}</Link>
        </ItemPopover>
      )
    }

    // the visible text stays the original url; only the destination is
    // rewritten to the configured privacy frontend (youtube/x)
    const privacy = privacyUrls(url)

    return (
      <span>
        {/* eslint-disable-next-line react/jsx-no-target-blank */}
        <a className={styles.link} target='_blank' href={privacy?.primary ?? url} rel={rel ?? UNKNOWN_LINK_REL}>
          {url.replace(/(^https?:|^)\/\//, '')}
        </a>
        {privacy && <a className='sn-private-original' href={url} target='_blank' rel='noopener noreferrer nofollow'> original ↗</a>}
      </span>
    )
  } catch {
    return null
  }
}

export default function Item ({
  item, rank, belowTitle, right, full, children, itemClassName,
  onQuoteReply, pinnable, excerpt, noMedia, ...props
}) {
  const titleRef = useRef()
  const router = useRouter()

  const media = mediaType({ url: item.url, imgproxyUrls: item.imgproxyUrls })
  const hasVideo = hasVideoUpload(item.imgproxyUrls)
  const { me } = useMe()
  const embed = parseEmbedUrl(item.url)
  // hide the bare URL line only when the card shows that exact status;
  // an unrelated main URL stays visible next to a body-derived preview
  const mainIsSelected = canonicalXStatus(item.url)?.statusUrl === item.xPreview?.statusUrl

  return (
    <>
      {rank
        ? (
          <div className={styles.rank}>
            {rank}
          </div>)
        : <div />}
      <div className={classNames(styles.item, itemClassName)}>
        {item.position && (pinnable || !item.subNames)
          ? <Pin width={24} height={24} className={styles.pin} />
          : item.mine
            ? item.bio ? null : <Boost item={item} className={styles.upvote} />
            : <VoteColumn item={item} className={styles.upvote} />}
        <div className={`${styles.hunk} item-hunk`}>
          <div className={`${styles.main} flex-wrap`}>
            <Link
              href={`/items/${item.id}`}
              onClick={(e) => onItemClick(e, router, item)}
              ref={titleRef}
              className={`${styles.title} text-reset me-2`}
            >
              {item.searchTitle ? <SearchTitle title={item.searchTitle} /> : item.title}
              {item.pollCost && <PollIndicator item={item} />}
              {item.bounty > 0 &&
                <span className={styles.icon}>
                  <ActionTooltip notForm overlayText={`${piconerosToMXmr(BigInt(item.bounty) * 1000n)} ${item.bountyPaidTo?.length ? ' paid' : ' bounty'}`}>
                    <BountyIcon className={`${styles.bountyIcon} ${item.bountyPaidTo?.length ? 'fill-success' : 'fill-grey'}`} height={16} width={16} />
                  </ActionTooltip>
                </span>}
              {hasVideo
                ? <span className={styles.icon}><VideoIcon className='fill-grey ms-2' height={16} width={16} /></span>
                : media === 'image' && <span className={styles.icon}><ImageIcon className='fill-grey ms-2' height={16} width={16} /></span>}
            </Link>
            <MoneroWallRatingBadge rating={item.moneroWallRating} />
            {item.url && !media && !mainIsSelected && <ItemLink url={item.url} rel={item.rel} />}
          </div>
          {excerpt && <p className='item-excerpt'>{excerpt}</p>}
          {!full && item.moneroWall?.locked && !props.noMoneroWallChip && (
            <span className={`badge ms-2 ${styles.moneroWallChip}`}>monerowalled</span>
          )}
          {!full && item.xPreview && <XPreviewCard xPreview={item.xPreview} url={item.url} showImage={!noMedia && me?.privates?.showImagesAndVideos !== false} feed />}
          <ItemInfo
            full={full} item={item}
            onQuoteReply={onQuoteReply}
            pinnable={pinnable}
            {...props}
          />
          {!full && embed?.provider === 'youtube' && <Embed src={item.url} {...embed} />}
          {!full && !noMedia && <CardMedia item={item} onClick={(e) => onItemClick(e, router, item)} />}
          {belowTitle}
          {item.searchText && (
            <div className={styles.searchSnippet}>
              <SearchText text={item.searchText} />
            </div>
          )}
        </div>
        {right}
      </div>
      {children && (
        <div className={styles.children}>
          {children}
        </div>
      )}
    </>
  )
}

export function ItemSummary ({ item }) {
  const router = useRouter()
  const link = (
    <Link
      href={`/items/${item.id}`}
      onClick={(e) => onItemClick(e, router, item)}
      className={`${item.title && styles.title} ${styles.summaryText} text-reset me-2`}
    >
      {item.title ?? removeMd(item.text)}
    </Link>
  )
  const info = (
    <ItemInfo
      item={item}
      showUser={false}
      showActionDropdown={false}
    />
  )

  return (
    <div className={classNames(styles.item, 'mb-0 pb-0')}>
      <div className={styles.hunk}>
        {item.title
          ? (
            <>
              {link}
              {info}
            </>
            )
          : (
            <>
              {info}
              {link}
            </>
            )}
      </div>
    </div>
  )
}

export function ItemSkeleton ({ rank, children, showUpvote = true }) {
  return (
    <>
      {rank
        ? (
          <div className={styles.rank}>
            {rank}
          </div>)
        : <div />}
      <div className={`${styles.item} ${styles.skeleton}`}>
        {showUpvote && <UpVote className={styles.upvote} />}
        <div className={styles.hunk}>
          <div className={`${styles.main} flex-wrap flex-md-nowrap`}>
            <span className={`${styles.title} clouds text-reset flex-md-fill flex-md-shrink-0 me-2`} />
            <span className={`${styles.link} clouds`} />
          </div>
          <div className={styles.other}>
            <span className={`${styles.otherItem} clouds`} />
            <span className={`${styles.otherItem} clouds`} />
            <span className={`${styles.otherItem} ${styles.otherItemLonger} clouds`} />
            <span className={`${styles.otherItem} ${styles.otherItemLonger} clouds`} />
          </div>
        </div>
      </div>
      {children && (
        <div className={styles.children}>
          {children}
        </div>
      )}
    </>
  )
}

function PollIndicator ({ item }) {
  const hasExpiration = !!item.pollExpiresAt
  const timeRemaining = timeLeft(new Date(item.pollExpiresAt))
  const isActive = !hasExpiration || !!timeRemaining

  return (
    <span className={styles.icon} title={isActive ? 'active' : 'results in'}>
      <PollIcon
        className={`${isActive
          ? 'fill-success'
          : 'fill-grey'
          } ms-1`} height={14} width={14}
      />
    </span>
  )
}
