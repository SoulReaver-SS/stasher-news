import { useCallback } from 'react'
import { useMutation, useApolloClient } from '@apollo/client/react'
import { useShowModal } from './modal'
import TipModal from './tip-modal'
import { useMe } from './me'
import { useToast } from './toast'
import { piconerosToMXmr } from '@/lib/format'
import { REMOVE_MONERO_WALL, OPEN_MONERO_WALL_COMMENTS } from '@/fragments/items'
import styles from './monero-wall.module.css'

// Monerowall panel (spec §UI). The server serves only the teaser to locked
// viewers, so this renders under the teaser: progress toward the public-unlock
// threshold, a fixed-amount unlock for logged-in readers, and an any-amount
// contribute leg. Unlocking IS an ordinary P2P tip (initiateTip via TipModal) —
// no new payment mutation. The author sees the settings summary plus a one-way
// remove action instead (removal only ever widens access, so it bypasses the
// edit window by design).
export default function MoneroWallPanel ({ item }) {
  const wall = item.moneroWall
  const showModal = useShowModal()
  const { me } = useMe()
  const client = useApolloClient()

  // TipModal calls this the moment a payment is DETECTED (0-conf). Entitlement
  // now counts DETECTED tips, so one refetch flips the wall — no persisted
  // pending state needed (2026-09-22 spec).
  const onDetected = useCallback(() => {
    client.refetchQueries({ include: ['Item'] }).catch(() => {})
  }, [client])

  if (!wall) return null
  // ITEM_FIELDS selects `mine`, so the author branch never falls back to a
  // locked-viewer UI (the server also reports locked: false for the author).
  if (item.mine) return <AuthorMoneroWallView item={item} />

  const pricePiconeros = wall.pricePiconeros != null ? BigInt(wall.pricePiconeros) : null
  const thresholdPiconeros = wall.thresholdPiconeros != null ? BigInt(wall.thresholdPiconeros) : null
  const progressPiconeros = BigInt(wall.progressPiconeros ?? 0)
  const remainingPiconeros = BigInt(wall.remainingPiconeros ?? 0)
  const progressPct = thresholdPiconeros != null && thresholdPiconeros > 0n
    ? Math.min(100, Number((progressPiconeros * 100n) / thresholdPiconeros))
    : null

  const openUnlock = () => showModal(onClose => <TipModal item={item} onClose={onClose} fixedAmount={pricePiconeros} unlockMode onDetected={onDetected} />)
  const openContribute = () => showModal(onClose => <TipModal item={item} onClose={onClose} unlockMode onDetected={onDetected} />)

  // An entitled viewer (individual unlock paid) still sees the collective
  // panel while the global goal is open: the post is readable for them, but
  // the bar and the contribute leg keep working toward the public unlock.
  if (!wall.locked && !wall.publiclyUnlocked && thresholdPiconeros != null) {
    return (
      <div className={styles.wall}>
        <div className={styles.rule} />
        <div className={styles.inner}>
          <h6 className={styles.title}>monerowalled</h6>
          <p className={styles.copy}>you&apos;ve unlocked this post</p>
          <CollectiveProgress thresholdPiconeros={thresholdPiconeros} progressPct={progressPct} remainingPiconeros={remainingPiconeros} />
          <div className={styles.actions}>
            <button className='btn btn-outline-secondary btn-sm' onClick={openContribute}>
              contribute
            </button>
          </div>
          <p className={styles.help}>100% of every unlock goes to the author, wallet-to-wallet.</p>
        </div>
      </div>
    )
  }

  if (!wall.locked) return null

  return (
    <div className={styles.wall}>
      <div className={styles.rule} />
      <div className={styles.inner}>
        <h6 className={styles.title}>monerowalled</h6>
        {wall.commentsLocked && (
          <p className={styles.copy}>the comments section is walled too. unlock to read it and join the discussion.</p>
        )}
        <CollectiveProgress thresholdPiconeros={thresholdPiconeros} progressPct={progressPct} remainingPiconeros={remainingPiconeros} />
        <div className={styles.actions}>
          {pricePiconeros != null && me && (
            <button className='btn btn-primary btn-sm' onClick={openUnlock}>
              unlock for {piconerosToMXmr(pricePiconeros)}
            </button>
          )}
          {thresholdPiconeros != null && (
            <button className='btn btn-outline-secondary btn-sm' onClick={openContribute}>
              contribute
            </button>
          )}
        </div>
        <p className={styles.help}>100% of every unlock goes to the author, wallet-to-wallet.</p>
      </div>
    </div>
  )
}

// Progress toward the public-unlock threshold — shared by the locked and the
// entitled-but-not-public panel variants. (`publiclyUnlocked` is always false
// in both: once the post unlocks for everyone, no viewer gets a panel.)
function CollectiveProgress ({ thresholdPiconeros, progressPct, remainingPiconeros }) {
  if (thresholdPiconeros == null) return null
  return (
    <>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${progressPct ?? 0}%` }} />
      </div>
      <p className={styles.copy}>
        {piconerosToMXmr(remainingPiconeros)} to go until this unlocks for everyone
      </p>
    </>
  )
}

function AuthorMoneroWallView ({ item }) {
  const wall = item.moneroWall
  const toaster = useToast()
  const showModal = useShowModal()
  const [removeMoneroWall, { loading }] = useMutation(REMOVE_MONERO_WALL, {
    update (cache) {
      // Null the wall in the cache so the panel (and the feed chip) disappear
      // immediately; refetchQueries below then restores the full body text.
      cache.modify({
        id: `Item:${item.id}`,
        fields: { moneroWall: () => null }
      })
    },
    refetchQueries: ['Item']
  })
  const [openMoneroWallComments, { loading: opening }] = useMutation(OPEN_MONERO_WALL_COMMENTS, {
    refetchQueries: ['Item']
  })

  const thresholdPiconeros = wall.thresholdPiconeros != null ? BigInt(wall.thresholdPiconeros) : null
  const progressPiconeros = BigInt(wall.progressPiconeros ?? 0)
  const progressPct = thresholdPiconeros != null && thresholdPiconeros > 0n
    ? Math.min(100, Number((progressPiconeros * 100n) / thresholdPiconeros))
    : null

  // Destructive and one-way: a misclick costs the author their wall forever,
  // so confirm in a modal first (mirrors the open-discussion confirmation).
  const onRemove = () => {
    showModal(onClose => (
      <div className='p-3'>
        <h5>remove monerowall</h5>
        <p className='text-muted'>
          this unlocks the post{wall.coversComments ? ' and the walled comment section' : ''} for everyone, immediately. this is permanent; you can&apos;t wall it again.
        </p>
        <div className='d-flex justify-content-end'>
          <button className='btn btn-link' onClick={onClose}>cancel</button>
          <button
            className='btn btn-danger'
            disabled={loading}
            onClick={async () => {
              try {
                await removeMoneroWall({ variables: { id: String(item.id) } })
                toaster.success('monerowall removed')
              } catch (err) {
                toaster.danger(err?.message ?? 'failed to remove monerowall')
              }
              onClose()
            }}
          >{loading ? 'removing…' : 'remove it'}
          </button>
        </div>
      </div>
    ))
  }

  // One-way like removal: the post stays walled, the discussion opens for
  // everyone. Confirmed in a modal because it cannot be undone.
  const onOpenComments = () => {
    showModal(onClose => (
      <div className='p-3'>
        <h5>open the discussion</h5>
        <p className='text-muted'>
          the post stays walled — replies become visible to everyone and anyone can join in. this is permanent; you can&apos;t wall the discussion again.
        </p>
        <div className='d-flex justify-content-end'>
          <button className='btn btn-link' onClick={onClose}>cancel</button>
          <button
            className='btn btn-primary'
            disabled={opening}
            onClick={async () => {
              try {
                await openMoneroWallComments({ variables: { id: String(item.id) } })
                toaster.success('discussion opened')
              } catch (err) {
                toaster.danger(err?.message ?? 'failed to open the discussion')
              }
              onClose()
            }}
          >{opening ? 'opening…' : 'open it'}
          </button>
        </div>
      </div>
    ))
  }

  return (
    <div className={styles.wall}>
      <div className={styles.rule} />
      <div className={styles.inner}>
        <h6 className={styles.title}>monerowalled (yours)</h6>
        <div className={styles.rows}>
          {wall.pricePiconeros != null && (
            <div className={styles.row}>
              <span>individual unlock threshold</span>
              <span className={styles.rowValue}>{piconerosToMXmr(BigInt(wall.pricePiconeros))}</span>
            </div>
          )}
          {thresholdPiconeros != null && (
            <div className={styles.row}>
              <span>global unlock threshold</span>
              <span className={styles.rowValue}>{piconerosToMXmr(thresholdPiconeros)}</span>
            </div>
          )}
          {wall.coversComments && (
            <div className={styles.row}>
              <span>discussion</span>
              <span className={styles.rowValue}>walled</span>
            </div>
          )}
          {thresholdPiconeros != null && (
            <div className={styles.row}>
              <span>tips so far</span>
              <span className={styles.rowValue}>
                {piconerosToMXmr(progressPiconeros)}{progressPct != null ? ` · ${progressPct}%` : ''}
              </span>
            </div>
          )}
        </div>
        {wall.frozen && (
          <p className={styles.copy}>settings freeze while a tip is pending or paid — you can still remove the wall.</p>
        )}
        {wall.coversComments && (
          <>
            <button className={styles.remove} onClick={onOpenComments} disabled={opening}>
              {opening ? 'opening…' : 'open the discussion'}
            </button>
            <p className={styles.help}>opens the replies for everyone — the post stays walled. permanent.</p>
          </>
        )}
        <button className={styles.remove} onClick={onRemove} disabled={loading}>
          {loading ? 'removing…' : 'remove monerowall'}
        </button>
        <p className={styles.help}>removing unlocks the full post for everyone, immediately.</p>
      </div>
    </div>
  )
}
