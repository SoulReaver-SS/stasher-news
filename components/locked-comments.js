import replyStyles from './reply.module.css'
import styles from './locked-comments.module.css'

const MAX_PLACEHOLDERS = 3

export function LockedReply () {
  return (
    <div className={`${replyStyles.reply} ${styles.composer}`}>
      <div className={styles.toolbar} aria-hidden='true'>
        <span className={styles.activeTab}>write</span>
        <span>compose</span>
        <span className='ms-auto'>Aa</span>
      </div>
      <textarea
        className={`form-control ${styles.input}`}
        rows={6}
        disabled
        aria-label='Comment editor locked. Unlock the post to join the discussion.'
        placeholder='unlock the post to join the discussion'
      />
      <div className='d-flex justify-content-end mt-3'>
        <button type='button' className='btn btn-secondary' disabled>locked</button>
      </div>
    </div>
  )
}

export function LockedComments ({ count }) {
  if (!(count > 0)) return null
  return (
    <section className={styles.comments} aria-label='Locked comment section'>
      <p className={styles.count}>{count} {count === 1 ? 'reply' : 'replies'} locked</p>
      {/* These are decorative patterns, never obscured real text. Only the
          already-public count determines how many cards appear. */}
      <div aria-hidden='true'>
        {Array.from({ length: Math.min(count, MAX_PLACEHOLDERS) }, (_, index) => (
          <div className={styles.card} data-locked-comment='true' key={index}>
            <div className={styles.voteRail}>▲<span>▼</span></div>
            <div className={styles.content}>
              <div className={styles.meta} />
              <div className={styles.pixels} />
              <div className={`${styles.pixels} ${styles.shortLine}`} />
              <span className={styles.replyLabel}>locked</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
