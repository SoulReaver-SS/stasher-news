import { COPY } from '@/lib/rebrand-copy'

// the platform meta turf: seeded as a default territory by migration and used
// as the fallback territory when attributing tips/trust for turf-less items
export const META_SUB = 'stasher'

// XXX this is temporary until we have so many subs they have
// to be loaded from the server
export const DEFAULT_SUBS = ['monero', 'bitcoin', 'crypto', 'bounties', 'jobs', 'memes', META_SUB, 'tech', 'worldnews']
export const DEFAULT_SUBS_NO_JOBS = DEFAULT_SUBS.filter(s => s !== 'jobs')

// turfs pinned to the top of the activeSubs dropdowns, in order; the rest follow
// alphabetically
export const ACTIVE_SUBS_PRIORITY = ['monero', 'bitcoin', 'crypto']
export const RESERVED_SUB_NAMES = ['all', 'home', 'frontpage']

export const PAID_ACTION_PAYMENT_METHODS = {
  FEE_CREDIT: 'FEE_CREDIT',
  PESSIMISTIC: 'PESSIMISTIC',
  OPTIMISTIC: 'OPTIMISTIC',
  DIRECT: 'DIRECT',
  P2P: 'P2P',
  REWARD_SATS: 'REWARD_SATS'
}
export const NOFOLLOW_LIMIT = 250
export const UNKNOWN_LINK_REL = 'noreferrer nofollow noopener'
export const UPLOAD_SIZE_MAX = 50 * 1024 * 1024
export const UPLOAD_SIZE_MAX_AVATAR = 5 * 1024 * 1024
export const UPLOAD_FREE_BYTES_MAX = 10 * 1024 * 1024 // 10MB — uploads over this pay the upload fee
export const UPLOAD_FEE_PICONEROS = 1000000000n // 0.001 XMR per upload over the free size
// Outstanding unpaid-upload caps (bytes). "Outstanding" = paid = false rows
// created within the retention window (7d users / 24h anon). Publishing and
// paying flips paid = true and frees capacity; the cleanup sweep also frees it.
export const UPLOAD_OUTSTANDING_CAP_USER = 100n * 1024n * 1024n
export const UPLOAD_OUTSTANDING_CAP_ANON = 50n * 1024n * 1024n
// Server-side drafts (2026-09-22 spec, user-set caps): at most 10 drafts and
// 20MB of pinned draft media per user; drafts untouched for 90 days are swept
// (pins cascade, the daily media sweep then reaps the files). No file-size
// tier rule — the >10MB upload fee stays at publish time, never at draft time.
export const DRAFT_MAX_COUNT = 10
export const DRAFT_MEDIA_CAP_BYTES = 20 * 1024 * 1024
export const DRAFT_TTL_DAYS = 90
export const BOOST_MIN = 1_000_000_000 // 0.001 XMR minimum boost (piconeros)
export const BOOST_MAX = 1_000_000_000_000 // 1 XMR cap for the UI slider
export const IMAGE_PIXELS_MAX = 35000000
// backwards compatibile with old media domain env var and precedence for docker url if set
export const PUBLIC_MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL || `https://${process.env.NEXT_PUBLIC_MEDIA_DOMAIN}`
export const MEDIA_URL = process.env.MEDIA_URL_DOCKER || PUBLIC_MEDIA_URL
export const AWS_S3_URL_REGEXP = new RegExp(`${process.env.NEXT_PUBLIC_MEDIA_URL || `https://${process.env.NEXT_PUBLIC_MEDIA_DOMAIN}`}/([0-9]+)`, 'g')
export const UPLOAD_TYPES_ALLOW = [
  'image/gif',
  'image/heic',
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/quicktime',
  'video/mp4',
  'video/mpeg',
  'video/webm'
]
export const AVATAR_TYPES_ALLOW = UPLOAD_TYPES_ALLOW.filter(t => t.startsWith('image/'))
export const PAY_IN_ACT_TYPES = ['TIP', 'DOWNVOTE', 'BOOST']
export const PAY_IN_NOTIFICATION_TYPES = ['ITEM_CREATE', ...PAY_IN_ACT_TYPES]
export const PAY_IN_AUTO_RETRY_TYPES = [...PAY_IN_NOTIFICATION_TYPES]
export const BOUNTY_MIN = 1000
export const POST_TYPES = ['LINK', 'DISCUSSION', 'JOB', 'POLL', 'BOUNTY']
// Display labels for the territory-form post-type checkboxes, one per POST_TYPES entry
export const POST_TYPE_LABELS = {
  LINK: 'links',
  DISCUSSION: 'discussions',
  JOB: 'jobs',
  POLL: 'polls',
  BOUNTY: 'bounties'
}
// JOB is a legacy, removal-only turf post type: jobs live in the `jobs` turf
// (job identity is subNames-based — see lib/item.js isJob), so new turfs never
// default to it
export const DEFAULT_POST_TYPES = POST_TYPES.filter(p => p !== 'JOB')
export const BOUNTY_MIN_PICONEROS = 10_000_000_000n // 0.01 XMR floor for a bounty amount
export const BOUNTY_UNDERPAY_ABANDON_DAYS = 7 // days a partially-paid bounty funding may be topped up before abandonment
export const FEE_ITEM_ABANDON_DAYS = 1 // days a PENDING_FEE item may stay unpaid before the sweep soft-deletes it
export const TERRITORY_BILLING_TYPES = ['MONTHLY', 'YEARLY', 'ONCE']
export const TERRITORY_GRACE_DAYS = 5
// pg-boss retry policy for every send/schedule: a single transient DB error
// must never kill a self-requeuing chain (default retryLimit is 0 — see
// migration 20260806090000_pgboss_schema). Handlers must be idempotent or
// CAS-guarded before adopting this.
export const BOSS_RETRY = Object.freeze({ retryLimit: 3, retryDelay: 30, retryBackoff: true })
export const COMMENT_DEPTH_LIMIT = 8
export const COMMENTS_LIMIT = 50
export const FULL_COMMENTS_THRESHOLD = 1000
export const COMMENTS_OF_COMMENT_LIMIT = 5
export const MAX_TITLE_LENGTH = 80
export const MIN_TITLE_LENGTH = 5
export const MAX_POST_TEXT_LENGTH = 100000 // 100k
export const MAX_COMMENT_TEXT_LENGTH = 10000 // 10k
// Post-window addendum (2026-10-04 spec): the single informational edit below
// a locked original. Counts submitted Markdown (links and syntax included),
// same String.length unit the editor's counter and textValidator enforce.
export const MAX_ITEM_ADDENDUM_LENGTH = 200
export const MAX_TERRITORY_DESC_LENGTH = 1000 // 1k
export const MAX_POLL_CHOICE_LENGTH = 40
export const ITEM_EDIT_SECONDS = 600
export const ITEM_SPAM_INTERVAL = '10m'
// Turf repost cap (2026-09-24): an item may live in at most this many turfs —
// the creation turf plus up to MAX_ITEM_TURFS - 1 paid reposts.
export const MAX_ITEM_TURFS = 5
export const ANON_ITEM_SPAM_INTERVAL = '0'
// spam-fee escalation rate: each post/repeat within the ITEM_SPAM_INTERVAL
// window multiplies the flat posting/comment fee by this factor (1.5x).
// Represented as a fraction so the server can compute the escalation exactly
// with BigInt (base x 3^n / 2^n); the fee button derives the float from it.
export const ITEM_SPAM_FEE_ESCALATION_NUMERATOR = 3n
export const ITEM_SPAM_FEE_ESCALATION_DENOMINATOR = 2n
export const FREE_COMMENTS_PER_WEEK = 1 // one tier: every registered user; Monday 00:00 UTC windows, never accumulates
export const FREE_POSTS_PER_MONTH = 1 // one tier: resets monthly, never accumulates
// Default feed filter values for users, in piconeros (also used for logged-out
// users). -0.025 XMR: by default feeds hide content whose net investment sank
// below -0.025 (roughly a dozen minimum downvotes) — a single downvote can't
// bury anything, but sustained downvoting eventually does. An explicit NULL
// (user-set "show all"/-∞ in settings) is still honored over these defaults.
export const DEFAULT_POSTS_PICONEROS_FILTER = -25000000000
export const DEFAULT_COMMENTS_PICONEROS_FILTER = -25000000000
// Homepage (null sub) lit/top floor for logged-out viewers (the logged-in
// viewer's explicit filter is respected as-is; see filterClause) and the
// unconditional floor in the `related` resolver. Deliberately a separate knob
// from DEFAULT_* so the front page can be re-tuned independently; currently
// aligned at -0.025 XMR.
export const HOMEPAGE_POSTS_PICONEROS_FILTER = -25000000000
export const INV_PENDING_LIMIT = 100
export const USER_ID = {
  stasher: 616,
  sn: 4502,
  anon: 27,
  ad: 9,
  delete: 106,
  saloon: 17226,
  rewards: 9513
}
export const SN_SYSTEM_ONLY_IDS = [USER_ID.sn, USER_ID.rewards, USER_ID.saloon, USER_ID.delete, USER_ID.ad]
export const SN_ADMIN_IDS = [USER_ID.stasher, USER_ID.sn]
export const SN_NO_REWARDS_IDS = [USER_ID.anon, USER_ID.sn, USER_ID.saloon, USER_ID.rewards]
export const MAX_POLL_NUM_CHOICES = 10
export const MIN_POLL_NUM_CHOICES = 2
export const POLL_COST = 1
export const ITEM_FILTER_THRESHOLD = 1.2
export const DONT_LIKE_THIS_COST = 1
export const COMMENT_TYPE_QUERY = ['comments', 'freebies', 'desperados', 'all', 'bookmarks']
export const USER_SORTS = ['stacked', 'spent', 'items']
export const ITEM_SORTS = ['sats', 'comments', 'downsats']
export const ITEM_SORT_LABELS = { sats: 'rank', comments: 'comments', downsats: 'downvotes' }
export const sortLabelToKey = (label) => {
  const entry = Object.entries(ITEM_SORT_LABELS).find(([, value]) => value === label)
  return entry ? entry[0] : label
}
export const SUB_SORTS = ['stacked', 'spent', 'items']
export const WHENS = ['day', 'week', 'month', 'year', 'forever', 'custom']
export const ITEM_TYPES_USER = ['all', 'posts', 'comments', 'bounties', 'links', 'discussions', 'polls', 'freebies', 'desperados', 'jobs', 'bookmarks']
export const ITEM_TYPES = ['all', 'posts', 'comments', 'bounties', 'links', 'discussions', 'polls', 'freebies', 'desperados', 'bios', 'jobs']
export const ITEM_TYPES_UNIVERSAL = ['all', 'posts', 'comments', 'freebies', 'desperados']
export const OLD_ITEM_DAYS = 3
export const ANON_POST_FEE_MULTIPLIER = 10 // anon posts: 0.001 x 10 = 0.01 XMR
export const ANON_COMMENT_FEE_MULTIPLIER = 3 // anon comments: 0.0006 x 3 = 0.0018 XMR
// anon/UI default mirroring PlatformFeeConfig(id=1).postingFeeFloorPiconeros (1e9
// = 0.001 XMR). The anon fee-button can't read me.privates, so it falls back to
// this; if the operator raises the config floor, update this to match.
export const DEFAULT_POSTING_FEE_PICONEROS = 1000000000n
// anon/UI default mirroring PlatformFeeConfig(id=1).commentFeePiconeros (6e8
// = 0.0006 XMR). Same fallback rule as the posting default above: if the
// operator retunes the comment fee, update this to match.
export const DEFAULT_COMMENT_FEE_PICONEROS = 600000000n
export const SSR = typeof window === 'undefined'
// BOLT11 tagged fields carry at most 1023 5-bit groups, or 639 bytes.
export const MAX_INVOICE_DESCRIPTION_LENGTH = 639
export const MAX_WALLET_INVOICE_SATS = 99_999_999
export const RESERVED_MAX_USER_ID = 615
export const FREEBIE_BASE_COST_THRESHOLD = 10
export const PROXY_RECEIVE_FEE_PERCENT = 10n
// the maximum msats we'll allow for the outgoing (wrapped) invoice
export const MAX_OUTGOING_MSATS = 700_000_000n

// largest whole-sat tip whose 70% single-recipient P2P share (api/payIn/types/zap.js) still fits
// under MAX_OUTGOING_MSATS. Larger tips can't be wrapped/delivered P2P to a single recipient, so we
// reject them at input time instead of silently degrading that recipient to credits.
export const MAX_TIP_PICONEROS = Number(MAX_OUTGOING_MSATS * 100n / 70n / 1000n)

// a bounty is paid to the winner as a single 100%-of-amount P2P invoice, so it can't exceed the
// wrap cap (MAX_OUTGOING_MSATS); a larger bounty could be set but never delivered — and now churns
// indefinitely since bounties have no custodial fallback — so reject it at input time.
export const MAX_BOUNTY_PICONEROS = Number(MAX_OUTGOING_MSATS / 1000n)

export const SANCTIONED_COUNTRY_CODES = process.env.SANCTIONED_COUNTRY_CODES?.split(',') || []

export const TERRITORY_COST_MONTHLY = 50000
export const TERRITORY_COST_YEARLY = 500000
export const TERRITORY_COST_ONCE = 3000000

export const TERRITORY_BILLING_OPTIONS = (labelPrefix) => ({
  monthly: {
    term: '+ 50k',
    label: `${labelPrefix} month`,
    op: '+',
    modifier: cost => cost + TERRITORY_COST_MONTHLY
  },
  yearly: {
    term: '+ 500k',
    label: `${labelPrefix} year`,
    op: '+',
    modifier: cost => cost + TERRITORY_COST_YEARLY
  },
  once: {
    term: '+ 3m',
    label: 'one time',
    op: '+',
    modifier: cost => cost + TERRITORY_COST_ONCE
  }
})

export const TERRITORY_PERIOD_COST = (billingType) => {
  switch (billingType.toUpperCase()) {
    case 'MONTHLY':
      return TERRITORY_COST_MONTHLY
    case 'YEARLY':
      return TERRITORY_COST_YEARLY
    case 'ONCE':
      return TERRITORY_COST_ONCE
  }
}

export const FOUND_BLURBS = {
  // Read by the in-app notifications bell for found-flame entries (the push
  // path uses the quest notifications instead).
  FLAME: [
    'Your flame is burning. Clear both daily quests to keep it alive.',
    'You lit a flame. Two quests a day keeps it going.',
    'A small flame has been kindled. Clear tomorrow\'s quests to feed it.',
    'Your streak earned you a flame. Nurture it and it will grow.'
  ],
  VERIFIED: [
    COPY.verifiedBody
  ]
}
export const LOST_BLURBS = {
  FLAME: [
    'your flame flickered out after a missed set of daily ops. Clear both today to relight a new run.',
    'the flame went cold with a missed day. Two quests a day keeps it burning.',
    'your quest streak broke. A fresh flame starts at day 1 with today\u2019s quests.'
  ]
}

export const ADMIN_ITEMS = [
  // FAQ, changelog, content guidelines, tos, privacy policy, copyright policy
  349, 78763, 81862, 338393, 338369, 338453
]

export const FAST_POLL_INTERVAL_MS = Number(process.env.NEXT_PUBLIC_FAST_POLL_INTERVAL_MS)
export const NORMAL_POLL_INTERVAL_MS = Number(process.env.NEXT_PUBLIC_NORMAL_POLL_INTERVAL_MS)
export const LONG_POLL_INTERVAL_MS = Number(process.env.NEXT_PUBLIC_LONG_POLL_INTERVAL_MS)
export const EXTRA_LONG_POLL_INTERVAL_MS = Number(process.env.NEXT_PUBLIC_EXTRA_LONG_POLL_INTERVAL_MS)
export const WALLET_LOG_POLL_INTERVAL_MS = 5_000

// monero-lws rewards-wallet observer poll interval (spec §5.4). The platform
// rewards wallet is polled every MONERO_POLL_INTERVAL_MS (default 20s) by the
// rewardsWalletObserver (author tips arrive via lws webhooks). Exactly-once is
// enforced by the ObservedTip/ObservedDownvote unique keys.
export const MONERO_POLL_INTERVAL_MS = Number(process.env.MONERO_POLL_INTERVAL_MS) || 20_000

// Reorg reconciliation (spec §5.5). REORG_GRACE_BLOCKS is the safety margin a
// DETECTED tip must fall behind the chain tip before its absence from an lws
// replay is treated as a reorg (vs. a not-yet-scanned recent block).
// REQUIRED_CONFIRMATIONS is the depth at which a tip is final and never reverted.
export const REORG_GRACE_BLOCKS = Number(process.env.REORG_GRACE_BLOCKS) || 2
export const REQUIRED_CONFIRMATIONS = Number(process.env.REQUIRED_CONFIRMATIONS) || 10

// Zero-conf wall tiers (2026-09-22 spec): rating eligibility needs this many
// confirmations; view entitlement counts DETECTED (0-conf). A chain tip older
// than CHAIN_TIP_MAX_AGE_MS is treated as absent -> rating falls back to
// CONFIRMED-only (grants late, never early beyond one block of tolerance).
export const RATING_CONFIRMATIONS = Number(process.env.RATING_CONFIRMATIONS) || 3
export const CHAIN_TIP_MAX_AGE_MS = Number(process.env.CHAIN_TIP_MAX_AGE_MS) || 10 * 60 * 1000

// confirmFinalizer poll interval (spec §5.5). Confirmation is low-frequency —
// a tip only matures at REQUIRED_CONFIRMATIONS (10) blocks (~20 min mainnet /
// ~2 min stagenet), so a 60s cadence is plenty and avoids hammering lws at the
// indexer's 20s cadence. Separate from MONERO_POLL_INTERVAL_MS because the two
// jobs have very different latency requirements (detection vs finalization).
export const CONFIRM_POLL_INTERVAL_MS = Number(process.env.CONFIRM_POLL_INTERVAL_MS) || 60_000

// lws webhook configuration (spec §4.4). LWS_WEBHOOK_URL is the base URL lws
// calls back with tx-confirmation payloads (the Docker network address in dev,
// the public URL in prod). LWS_WEBHOOK_TOKEN is the shared secret lws echoes
// back in the x-lws-token header; empty = no auth check (dev default).
export const LWS_WEBHOOK_URL = process.env.LWS_WEBHOOK_URL || 'http://app:3000/api/monero/webhook'
export const LWS_WEBHOOK_TOKEN = process.env.LWS_WEBHOOK_TOKEN || ''

// Delayed webhook-miss check (2026-09-15). A tx_not_found receipt verdict at
// 0-conf now means BOTH sources missed the tx: lws's REST view cannot see
// mempool txs and the monerod fallback either lacks the hash or is
// unreachable — not a benign lookup race that self-resolves. The receiver
// therefore logs it and schedules a one-shot check this far in the future; a
// still-PENDING ObservedTip by then is a genuine miss and pages.
export const WEBHOOK_MISS_CHECK_DELAY_SECONDS = Number(process.env.WEBHOOK_MISS_CHECK_DELAY_SECONDS) || 30 * 60

// PENDING-tip reconciliation (Phase 5). A tip is created PENDING at initiateTip and
// flipped to DETECTED by the 0-conf webhook. If that callback is missed, this sweep
// recovers it. RECONCILE_PENDING_AGE_MS is how long we wait before trusting the
// webhook is truly lost (give lws retries + the receiver time to fire). PENDING tips
// whose payment never appears on chain are expired after PENDING_EXPIRY_MS (24h —
// matching downvote pid-map and fee-subaddress reservation expiry).
export const RECONCILE_PENDING_AGE_MS = Number(process.env.RECONCILE_PENDING_AGE_MS) || 5 * 60 * 1000 // 5 min
export const PENDING_EXPIRY_MS = Number(process.env.PENDING_EXPIRY_MS) || 24 * 60 * 60 * 1000 // 24 hours

// NULL-height DETECTED tip backstop (confirmFinalizer). A tip detected at
// 0-conf (daemon level) or before lws reported its block can sit DETECTED with
// height NULL. If every later mined webhook is lost, nothing scans it: the
// maturity pass requires height NOT NULL, reconcilePendingTips scans PENDING
// only, webhookMissCheck pages PENDING only, and at STALE_DETECTED_EXPIRY_MS
// the stale sweep would flip it REORGED — silently reversing a real, paid tip.
// The finalizer's bounded backstop re-checks height-NULL DETECTED tips older
// than this grace period against lws/monerod (backfill height, correct amount,
// defer, or corroborated exclusion). 15 min is comfortably longer than the
// normal mined-callback latency (the first mined callback lands within ~1
// block of mining, ~2 min) and than lws delivery retries, and far below the
// 48h stale sweep it exists to pre-empt.
export const DETECTED_NULL_HEIGHT_BACKSTOP_AGE_MS = Number(process.env.DETECTED_NULL_HEIGHT_BACKSTOP_AGE_MS) || 15 * 60 * 1000 // 15 min

// Stale-DETECTED reversal (audit A-1, pre-open-beta). A DETECTED observation
// whose height is STILL NULL this long after detection only ever existed in
// the mempool — the tx was double-spent or evicted. The reverseStaleDetections
// sweep flips it REORGED (terminal; the tip/downvote modals already render the
// state) and reverses its provisional effects. 48h exceeds Monero's typical
// ~1-3 day mempool eviction so a merely slow-to-mine tx is not reversed, and is
// ~140x the ~20 min a real tx needs for 10 confirmations.
export const STALE_DETECTED_EXPIRY_MS = Number(process.env.STALE_DETECTED_EXPIRY_MS) || 48 * 60 * 60 * 1000 // 48 hours

// custom domains
export const DOMAIN_POLL_INTERVAL_MS = 10_000
export const DOMAIN_VERIFICATION_INTERVAL_SECONDS = 30
export const DOMAIN_VERIFICATION_SLOW_INTERVAL_SECONDS = 5 * 60
export const DOMAIN_VERIFICATION_SLOW_AFTER_HOURS = 1
export const DOMAIN_VERIFICATION_RETRY_LIMIT = 3
export const DOMAIN_VERIFICATION_RETRY_DELAY_SECONDS = 60
export const DOMAIN_VERIFICATION_HOLD_AFTER_DAYS = 2
export const DOMAIN_HOLD_RETENTION_DAYS = 30
// custom domains cached fetcher
export const CUSTOM_DOMAINS_CACHE_EXPIRY_MS = 1000 * 60 * 2 // 2 minutes expiry after request
export const CUSTOM_DOMAINS_CACHE_FORCE_REFRESH_THRESHOLD_MS = 1000 * 60 * 5 // 5 minutes force expiry
// custom domains debugging
export const CUSTOM_DOMAINS_DEBUG = Number(process.env.NEXT_PUBLIC_CUSTOM_DOMAINS_DEBUG) === 1
// custom domains beta access ids
export const DOMAIN_BETA_IDS = [USER_ID.stasher, USER_ID.sn]
// custom domains auth flow
export const DOMAINS_AUTH_CODE_EXPIRY_MS = 1000 * 60 * 5 // 5 minutes in milliseconds
// custom domain seo
export const MAX_SEO_TITLE_LENGTH = 80
export const MAX_SEO_TAGLINE_LENGTH = 200

// keep under the load balancer's request timeout so a slow receive wallet fails over (e.g. a zap's
// P2P wrap falls back to credits) before the LB 504s the in-flight act mutation
export const WALLET_CREATE_INVOICE_TIMEOUT_MS = 20_000

// interval between which failed invoices are returned to a client for automated retries.
// retry-after must be high enough such that intermediate failed invoices that will already
// be retried by the client due to sender or receiver fallbacks are not returned to the client.
export const WALLET_RETRY_AFTER_MS = 60_000 // 1 minute
// NOTE: if you update this, you need to update the comment SQL functions where it's hardcoded
export const WALLET_RETRY_BEFORE_MS = 3_600_000 // 1 hour
// NOTE: if you update this, you need to update the comment SQL functions where it's hardcoded
// we want to attempt a payment up to five times so we retry four times
export const WALLET_MAX_RETRIES = 5
// when a pending retry for an invoice should be considered expired and can be attempted again
export const WALLET_RETRY_TIMEOUT_MS = 60_000 // 1 minute

export const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

// MDAST pipeline debugging
export const MDAST_DEBUG = Number(process.env.NEXT_PUBLIC_MDAST_DEBUG) === 1
