import itemStyles from './item.module.css'
import styles from './comment.module.css'
import Text, { SearchText } from './text'
import Link from 'next/link'
import Reply from './reply'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import UpVote from './upvote'
import VoteColumn from './vote-column'
import Eye from '@/svgs/eye-fill.svg'
import EyeClose from '@/svgs/eye-close-line.svg'
import { useRouter } from 'next/router'
import CommentEdit from './comment-edit'
import ItemAddendumForm, { ExpiredFullEditNotice } from './item-addendum-form'
import ItemAddendum from './item-addendum'
import useCanEdit from './use-can-edit'
import { USER_ID, COMMENT_DEPTH_LIMIT, UNKNOWN_LINK_REL, DEFAULT_COMMENTS_PICONEROS_FILTER } from '@/lib/constants'
import AwardBounty from './award-bounty'

import Share from './share'
import ItemInfo from './item-info'
import { XPreviewCard } from './x-preview'
import Badge from 'react-bootstrap/Badge'
import { RootProvider, useRoot } from './root'
import { useMe } from './me'
import { useQuoteReply } from './use-quote-reply'
import { commentSubTreeRootId } from '@/lib/item'
import Pin from '@/svgs/pushpin-fill.svg'
import LinkToContext from './link-to-context'
import Boost from './boost-button'
import { gql } from '@apollo/client'
import { useApolloClient } from '@apollo/client/react'
import classNames from 'classnames'
import useCallbackRef from './use-callback-ref'

function Parent ({ item, rootText }) {
  const root = useRoot()

  const ParentFrag = () => (
    <>
      <span> \ </span>
      <Link href={`/items/${item.parentId}`} className='text-reset'>
        parent
      </Link>
    </>
  )

  return (
    <>
      {Number(root.id) !== Number(item.parentId) && <ParentFrag />}
      <span> \ </span>
      <Link href={`/items/${root.id}`} className='text-reset'>
        {rootText || 'on:'} {root?.title}
      </Link>
      {root.subNames?.map(subName => (
        <Link key={subName} href={`/~${subName}`}>
          {' '}<Badge className={itemStyles.newComment} bg={null}>{subName}</Badge>
        </Link>
      ))}
    </>
  )
}

const truncateString = (string = '', maxLength = 140) =>
  string.length > maxLength
    ? `${string.substring(0, maxLength)} […]`
    : string

export function CommentFlat ({ item, rank, siblingComments, search, ...props }) {
  const router = useRouter()
  const [href, as] = useMemo(() => {
    const rootId = commentSubTreeRootId(item)
    return [{
      pathname: '/items/[id]',
      query: { id: rootId, commentId: item.id }
    }, `/items/${rootId}`]
  }, [item?.id])

  return (
    <>
      {rank
        ? (
          <div className={`${itemStyles.rank} pt-2 align-self-start`}>
            {rank}
          </div>)
        : <div />}
      <LinkToContext
        className={`py-2 clickToContext ${search ? styles.searchComment : ''}`}
        onClick={e => {
          e.preventDefault()
          router.push(href, as)
        }}
        href={href}
        pad
      >
        <RootProvider root={item.root || item}>
          <Comment item={item} {...props} />
        </RootProvider>
      </LinkToContext>
    </>
  )
}

export default function Comment ({
  item, children, replyOpen, includeParent, topLevel,
  rootText, noComments, noReply, truncate, depth, pin,
  navigator, ...props
}) {
  const [edit, setEdit] = useState()
  // the editor mode captured when the author opened the editor: a FULL window
  // that expires mid-edit must not silently reinterpret the body as an addendum
  const [editModeAtOpen, setEditModeAtOpen] = useState()
  const { me } = useMe()
  // Collapse comments that don't meet the viewer's commentsPiconerosFilter threshold
  const commentsPiconerosFilter = me ? me.privates?.commentsPiconerosFilter : DEFAULT_COMMENTS_PICONEROS_FILTER
  const isBelowFilter = !item.mine && commentsPiconerosFilter != null && item.netInvestment < commentsPiconerosFilter
  const isDeletedChildless = item?.ncomments === 0 && item?.deletedAt
  const [collapse, setCollapse] = useState(
    (isBelowFilter || isDeletedChildless || item?.user?.meMute) && !includeParent
      ? 'yep'
      : 'nope')
  const ref = useRef(null)
  // if comment is registered with the new comments navigator
  const didTrackRef = useRef(false)
  const { ref: readerRef, onRef: onReaderRef } = useCallbackRef()
  const { ref: addendumReaderRef, onRef: onAddendumReaderRef } = useCallbackRef()
  const router = useRouter()
  const root = useRoot()
  const [, , , editMode] = useCanEdit(item)
  // finding #3: the mode when the editor opened. A FULL window expiring
  // mid-edit keeps the mounted editor (with its typed values) visible and
  // refuses submission instead of swapping to the addendum editor.
  const fullEditExpired = editModeAtOpen === 'FULL' && editMode === 'ADDENDUM'
  const { ref: textRef, quote, quoteReply, cancelQuote } = useQuoteReply({ text: item.text, readerRef, additionalReaderRefs: [addendumReaderRef] })

  const closeEdit = useCallback(() => {
    setEdit(false)
    setEditModeAtOpen(undefined)
  }, [])
  const toggleEdit = useCallback(() => {
    setEdit(open => {
      if (!open) setEditModeAtOpen(editMode)
      return !open
    })
  }, [editMode])

  const { cache } = useApolloClient()

  const unsetOutline = () => {
    if (!ref.current) return

    const classes = ref.current.classList
    const hasOutline = classes.contains('outline-new-comment')
    const hasLiveOutline = classes.contains('outline-new-live-comment')
    const hasOutlineUnset = classes.contains('outline-new-comment-unset')

    // don't try to untrack and unset the outline if the comment is not outlined or we already unset the outline
    if (!(hasLiveOutline || hasOutline) || hasOutlineUnset) return

    classes.add('outline-new-comment-unset')
    // untrack new comment and its descendants if it's not a live comment
    navigator?.untrackNewComment(ref, { includeDescendants: hasOutline })
  }

  useEffect(() => {
    const comment = cache.readFragment({
      id: `Item:${router.query.commentId}`,
      fragment: gql`
        fragment CommentPath on Item {
          path
        }`
    })
    if (comment?.path.split('.').includes(item.id)) {
      window.localStorage.setItem(`commentCollapse:${item.id}`, 'nope')
    }
    setCollapse(window.localStorage.getItem(`commentCollapse:${item.id}`) || collapse)
    if (Number(router.query.commentId) === Number(item.id)) {
      // HACK wait for other comments to uncollapse if they're collapsed
      setTimeout(() => {
        ref.current.scrollIntoView({ behavior: 'instant', block: 'start' })
        // make sure we can outline a comment again if it was already outlined before
        ref.current.addEventListener('animationend', () => {
          ref.current.classList.remove('outline-it')
        }, { once: true })
        ref.current.classList.add('outline-it')
      }, 100)
    }
  }, [item.id, cache, router.query.commentId])

  useEffect(() => {
    // checking navigator because outlining should happen only on item pages
    if (!navigator || me?.id === item.user?.id) return
    // bail if we already registered this comment
    if (didTrackRef.current) return

    const itemCreatedAt = new Date(item.createdAt).getTime()

    const meViewedAt = new Date(root.meCommentsViewedAt).getTime()
    const viewedAt = me?.id ? meViewedAt : router.query.commentsViewedAt

    const isNewComment = viewedAt && itemCreatedAt > viewedAt
    // live comments are new regardless of me or anon view time
    const rootLast = new Date(root.lastCommentAt || root.createdAt).getTime()
    const isNewLiveComment = item.live && itemCreatedAt > (meViewedAt || rootLast)

    if (!isNewComment && !isNewLiveComment) return

    if (item.live) {
      // live comments (item.live) have to use a different class to outline every new comment
      ref.current.classList.add('outline-new-live-comment')

      // wait for the injection animation to end before removing its class
      ref.current.addEventListener('animationend', () => {
        ref.current.classList.remove(styles.liveComment)
      }, { once: true })
      // animate the live comment injection
      ref.current.classList.add(styles.liveComment)
    } else {
      ref.current.classList.add('outline-new-comment')
    }

    // track the new comment instantly so that a subsequent unsetOutline can remove it immediately
    didTrackRef.current = navigator.trackNewComment(ref, itemCreatedAt)
  }, [item.id, root.lastCommentAt, root.meCommentsViewedAt])

  // untrack comment from the new comments navigator on unmount
  useEffect(() => {
    return () => {
      if (!didTrackRef.current) return
      navigator?.untrackNewComment(ref, { includeDescendants: true })
      didTrackRef.current = false
    }
  }, [])

  const bottomedOut = depth === COMMENT_DEPTH_LIMIT || (item.comments?.comments.length === 0 && item.nDirectComments > 0)
  // Don't show OP badge when anon user comments on anon user posts
  const op = root.user.name === item.user.name && Number(item.user.id) !== USER_ID.anon
    ? 'OP'
    : null

  return (
    <div
      ref={ref} className={includeParent ? '' : `${styles.comment} ${collapse === 'yep' ? styles.collapsed : ''}`}
      onMouseEnter={unsetOutline}
      onTouchStart={unsetOutline}
    >
      <div className={`${itemStyles.item} ${styles.item}`}>
        {pin
          ? <Pin width={22} height={22} className={styles.pin} />
          : item.mine
            ? <Boost item={item} className={styles.upvote} />
            : <VoteColumn item={item} className={styles.upvote} collapsed={collapse === 'yep'} />}
        <div className={`${itemStyles.hunk} ${styles.hunk}`}>
          <div className='d-flex align-items-center'>
            {item.user?.meMute && !includeParent && collapse === 'yep'
              ? (
                <span
                  className={`${itemStyles.other} ${styles.other} pointer`} onClick={() => {
                    setCollapse('nope')
                    window.localStorage.setItem(`commentCollapse:${item.id}`, 'nope')
                  }}
                >reply from someone you muted
                </span>)
              : <ItemInfo
                  full={topLevel}
                  item={item}
                  commentsText='replies'
                  commentTextSingular='reply'
                  className={`${itemStyles.other} ${styles.other}`}
                  embellishUser={op && <><span> </span><Badge bg='boost' className={`${styles.op} bg-opacity-75`}>{op}</Badge></>}
                  onQuoteReply={quoteReply}
                  nested={!includeParent}
                  {...props}
                  extraInfo={
                    <>
                      {includeParent && <Parent item={item} rootText={rootText} />}
                    </>
                  }
                  edit={edit}
                  toggleEdit={toggleEdit}
                  editText={edit ? 'cancel' : 'edit'}
                />}

            {!includeParent && (collapse === 'yep'
              ? <Eye
                  className={styles.collapser} height={10} width={10} onClick={() => {
                    setCollapse('nope')
                    window.localStorage.setItem(`commentCollapse:${item.id}`, 'nope')
                  }}
                />
              : <EyeClose
                  className={styles.collapser} height={10} width={10} onClick={() => {
                    setCollapse('yep')
                    window.localStorage.setItem(`commentCollapse:${item.id}`, 'yep')
                  }}
                />)}
            {topLevel && (
              <span className='d-flex ms-auto align-items-center'>
                <Share title={item?.title} path={`/items/${item?.id}`} />
              </span>
            )}
          </div>
          {edit
            ? (
                editMode === 'ADDENDUM' && !fullEditExpired
                  ? <ItemAddendumForm item={item} onSuccess={closeEdit} onCancel={closeEdit} />
                  : (
                    <>
                      {fullEditExpired && <ExpiredFullEditNotice onCancel={closeEdit} />}
                      {/* the window ended with this editor open: keep it
                          mounted so nothing typed is lost, and let its
                          `expired` form refusal stop every submission path */}
                      <CommentEdit
                        comment={item}
                        onSuccess={closeEdit}
                        expired={fullEditExpired}
                      />
                    </>
                    )
              )
            : (
              <>
                <div className={styles.text} ref={textRef}>
                  {item.searchText
                    ? <SearchText text={item.searchText} />
                    : (
                      <Text itemId={item.id} state={item.lexicalState} html={item.html} topLevel={topLevel} rel={item.rel ?? UNKNOWN_LINK_REL} imgproxyUrls={item.imgproxyUrls} readerRef={onReaderRef}>
                        {truncate ? truncateString(item.text) : undefined}
                      </Text>)}
                </div>
                {/* search snippets must not present a partial original as the whole comment */}
                {!item.searchText && <ItemAddendum item={item} readerRef={onAddendumReaderRef} />}
                {!item.searchText && !truncate && collapse !== 'yep' && item.xPreview &&
                  <XPreviewCard xPreview={item.xPreview} url={item.url} showImage={me?.privates?.showImagesAndVideos !== false} />}
              </>
              )}
        </div>
      </div>
      {collapse !== 'yep' && (
        bottomedOut
          ? (
            <div className={styles.children}>
              {!noReply && <AwardBounty item={item} />}
              <div className={classNames(styles.comment, 'mt-3 pb-2')}><ViewMoreReplies item={item} threadContext /></div>
            </div>
            )
          : (
            <div className={styles.children}>
              {/* rendered here, not inside Reply: Reply hides its action row
                  when replyOpen (a comment's own page), and bottomedOut
                  comments never render Reply at all */}
              {!noReply &&
                <>
                  <AwardBounty item={item} />
                  <Reply depth={depth + 1} item={item} replyOpen={replyOpen} onCancelQuote={cancelQuote} onQuoteReply={quoteReply} quote={quote} />
                </>}
              {children}
              <div className={styles.comments}>
                {!noComments && item.comments?.comments
                  ? (
                    <>
                      {item.comments.comments.map((item) => (
                        <Comment depth={depth + 1} key={item.id} item={item} navigator={navigator} />
                      ))}
                      {item.comments.comments.length < item.nDirectComments && (
                        <div className={`d-block ${styles.comment} pb-2 ps-3`}>
                          <ViewMoreReplies item={item} />
                        </div>
                      )}
                    </>
                    )
                  : null}
                {/* TODO: add link to more comments if they're limited */}
              </div>
            </div>
            )
      )}
    </div>
  )
}

export function ViewMoreReplies ({ item, threadContext = false }) {
  const root = useRoot()
  const id = threadContext ? commentSubTreeRootId(item, root) : item.id

  // if threadContext is true, we travel to some comments before the current comment, focusing on the comment itself
  // otherwise, we directly navigate to the comment
  const href = `/items/${id}` + (threadContext ? `?commentId=${item.id}` : '')

  const text = threadContext && item.ncomments === 0
    ? 'reply on another page'
    : `view all ${item.ncomments} replies`

  return (
    <Link
      href={href}
      as={`/items/${id}`}
      className='fw-bold d-flex align-items-center gap-2 text-muted'
    >
      {text}
    </Link>
  )
}

export function CommentSkeleton ({ skeletonChildren }) {
  return (
    <div className={styles.comment}>
      <div className={`${itemStyles.item} ${itemStyles.skeleton} ${styles.item} ${styles.skeleton}`}>
        <UpVote className={styles.upvote} />
        <div className={`${itemStyles.hunk} ${styles.hunk}`}>
          <div className={itemStyles.other}>
            <span className={`${itemStyles.otherItem} clouds`} />
            <span className={`${itemStyles.otherItem} clouds`} />
            <span className={`${itemStyles.otherItem} clouds`} />
            <span className={`${itemStyles.otherItem} ${itemStyles.otherItemLonger} clouds`} />
          </div>
          <div className={`${styles.text} clouds`} />
        </div>
      </div>
      <div className={`${itemStyles.children} ${styles.children} ${styles.skeleton}`}>
        <div className={styles.replyPadder}>
          <div className={`${itemStyles.other} ${styles.reply} clouds`} />
        </div>
        <div className={`${styles.comments} ms-sm-1 ms-md-3`}>
          {skeletonChildren
            ? <CommentSkeleton skeletonChildren={skeletonChildren - 1} />
            : null}
        </div>
      </div>
    </div>
  )
}
