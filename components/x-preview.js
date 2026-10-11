import { parseHandleFromUrl } from '@/lib/url'
import { privacyUrls } from '@/lib/privacy'
import styles from './x-preview.module.css'
import ExternalLinkIcon from '@/svgs/link-external.svg'

const XLogo = ({ className }) => (
  <svg className={className} width='14' height='14' viewBox='0 0 24 24' fill='currentColor' aria-hidden='true'>
    <path d='M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' />
  </svg>
)

// Compact card for the item detail page and the feed. `feed` caps the tweet
// image at the same max size as other feed media previews (card-media).
export function XPreviewCard ({ xPreview, url, showImage = true, feed = false }) {
  const handle = xPreview?.handle || parseHandleFromUrl(url)
  const authorName = xPreview?.authorName || handle
  const statusUrl = xPreview?.statusUrl || url
  const privacy = privacyUrls(statusUrl)
  // imgproxy paths are relative; resolve against the public imgproxy URL the
  // same way buildPreview does (components/card-media.js), else the browser
  // requests the app origin and the image 404s.
  const imgproxyBase = process.env.NEXT_PUBLIC_IMGPROXY_URL
  const imageSrc = xPreview?.image?.['640w']
    ? imgproxyBase ? new URL(xPreview.image['640w'], imgproxyBase).href : xPreview.image['640w']
    : null
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.avatar}>{authorName?.charAt(0).toUpperCase()}</span>
        <span className={styles.who}>
          <span className={styles.name}>{authorName}</span>
          {handle && <span className={styles.handle}>@{handle}</span>}
        </span>
        <a className={styles.logo} href={privacy?.primary ?? statusUrl} target='_blank' rel='noopener noreferrer' aria-label={privacy ? 'open privately' : 'view on X'}>
          {privacy ? <ExternalLinkIcon width='14' height='14' aria-hidden='true' /> : <XLogo />}
        </a>
      </div>
      {xPreview?.text && <p className={styles.text}>{xPreview.text}</p>}
      {showImage && imageSrc && (
        <img className={feed ? styles.imgFeed : styles.img} src={imageSrc} loading='lazy' decoding='async' alt='' />
      )}
      <div className={styles.foot}>
        {xPreview?.date && <span>{xPreview.date}</span>}
        {privacy
          ? (
            <span className={styles.links}>
              <a href={privacy.primary} target='_blank' rel='noopener noreferrer'>open privately ↗</a>
              {privacy.alternate && <a href={privacy.alternate} target='_blank' rel='noopener noreferrer'>try another instance ↗</a>}
              <a href={privacy.original} target='_blank' rel='noopener noreferrer'>original on X ↗</a>
            </span>)
          : <a href={statusUrl} target='_blank' rel='noopener noreferrer'>view on X ↗</a>}
      </div>
    </div>
  )
}
