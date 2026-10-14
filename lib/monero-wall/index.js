// lib/monero-wall/index.js
// Pure Monerowall helpers. No DB, no React. See
// docs/superpowers/specs/2026-09-18-monerowall-design.md.

export const MONERO_WALL_MARKER = '[monerowall]'

const MARKER_LINE_RE = /^[ \t]*\[monerowall\][ \t]*$/m

/** Wall is active iff enabled and not removed (removal is one-way, 2026-09-21 amendment). */
export function moneroWallEnabled (item) {
  return item?.moneroWallEnabledAt != null && item?.moneroWallRemovedAt == null
}

/**
 * Comments wall is active iff the whole wall is active AND the post was created
 * with the discussion walled AND the discussion has not been opened (one-way
 * lift via openMoneroWallComments). Removing the whole wall opens the
 * discussion with it — moneroWallEnabled is the superset gate.
 */
export function moneroWallCommentsEnabled (item) {
  return moneroWallEnabled(item) && item?.moneroWallCoversComments === true && item?.moneroWallCommentsRemovedAt == null
}

/**
 * Validate a moneroWallCoversComments write. Returns an error string or null.
 * Create-only: the flag can only be set true when the post is created, and
 * only alongside a wall (it walls a subset of what the wall already walls).
 * `old` is the DB item on the update path, null at creation.
 */
export function moneroWallCommentsConfigError ({ coversComments, hasWallLeg, old }) {
  if (coversComments !== true) return null
  if (old != null) {
    if (old.moneroWallCoversComments !== true) {
      return 'the discussion wall can only be set when the post is created'
    }
    return null
  }
  if (!hasWallLeg) return 'walling the discussion requires a monerowall'
  return null
}

/**
 * Split body text into the public teaser and the locked remainder.
 * Prefers the explicit [monerowall] marker line; falls back to the first
 * paragraph break. lockedText is null when there is no locked content.
 * @returns {{ teaserText: string|null, lockedText: string|null, hasMarker: boolean }}
 */
export function splitMoneroWallText (text) {
  if (typeof text !== 'string') return { teaserText: text ?? null, lockedText: null, hasMarker: false }
  const match = MARKER_LINE_RE.exec(text)
  if (match) {
    const before = text.slice(0, match.index)
    const after = text.slice(match.index + match[0].length).replace(/^\r?\n/, '')
    return { teaserText: before.trimEnd(), lockedText: after.trim() ? after : null, hasMarker: true }
  }
  const blank = text.search(/\r?\n[ \t]*\r?\n/)
  if (blank !== -1) {
    return { teaserText: text.slice(0, blank).trimEnd(), lockedText: text.slice(blank).trimStart(), hasMarker: false }
  }
  return { teaserText: text, lockedText: null, hasMarker: false }
}

/** Remove the marker line from text that will be rendered or served in full. */
export function stripMoneroWallMarker (text) {
  if (typeof text !== 'string') return text
  return text.replace(/^[ \t]*\[monerowall\][ \t]*$/m, '')
}

function toPiconeros (value) {
  if (value == null) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

/**
 * Validate wall config at write time. Returns an error string or null.
 */
export function moneroWallConfigError ({ pricePiconeros, thresholdPiconeros, text, minTipPiconeros }) {
  const price = toPiconeros(pricePiconeros)
  const threshold = toPiconeros(thresholdPiconeros)
  if (price == null && threshold == null) return null
  if (pricePiconeros != null && price == null) return 'individual unlock threshold must be a whole piconero amount'
  if (thresholdPiconeros != null && threshold == null) return 'global unlock threshold must be a whole piconero amount'
  if (price != null && price <= 0n) return 'individual unlock threshold must be greater than zero'
  if (threshold != null && threshold <= 0n) return 'global unlock threshold must be greater than zero'
  if (price != null && minTipPiconeros != null && price < BigInt(minTipPiconeros)) {
    return `individual unlock threshold must be at least the minimum tip (${minTipPiconeros} piconeros)`
  }
  if (price != null && threshold != null && threshold < price) {
    return 'global unlock threshold must be at least the individual unlock threshold'
  }
  const { lockedText } = splitMoneroWallText(text)
  if (!lockedText) return 'a monerowall needs content below the wall (add a [monerowall] marker or a second paragraph)'
  return null
}

/**
 * Validate a wall change on edit. `old` is the DB item; `nextPrice`/
 * `nextThreshold` are the submitted values (null = cleared, undefined = untouched).
 * Walls are create-time only; removal is one-way via removeMoneroWall
 * (never by nulling both settings in an edit). Text-only edits on an active
 * wall are permitted even if they leave no locked content.
 */
export function moneroWallUpdateError ({ old, nextPrice, nextThreshold, frozen, minTipPiconeros, text }) {
  if (old?.moneroWallRemovedAt != null) {
    return 'a removed monerowall cannot be re-added'
  }
  if (old != null && old.moneroWallEnabledAt == null) {
    return 'a monerowall can only be added when the post is created'
  }
  const oldPrice = toPiconeros(old?.moneroWallPricePiconeros)
  const oldThreshold = toPiconeros(old?.moneroWallThresholdPiconeros)
  const price = nextPrice === undefined ? oldPrice : toPiconeros(nextPrice)
  const threshold = nextThreshold === undefined ? oldThreshold : toPiconeros(nextThreshold)

  if (price == null && threshold == null) {
    return 'clearing both settings requires removeMoneroWall (removal is permanent)'
  }
  const changing = price !== oldPrice || threshold !== oldThreshold
  // Text-only edits on an active wall may merge paragraphs or delete the
  // [monerowall] marker; leaving no locked content only reveals more, so it is
  // permitted (spec: "an edit that leaves no locked content is harmless").
  // Config validation (including locked-text) still applies when X/T change.
  if (moneroWallEnabled(old) && !changing) return null
  if (moneroWallEnabled(old) && frozen && changing) {
    return 'monerowall settings are frozen while tips are pending or paid (you can still remove the wall)'
  }
  return moneroWallConfigError({ pricePiconeros: price, thresholdPiconeros: threshold, text, minTipPiconeros })
}

/**
 * Shape the GraphQL MoneroWall view. locked is viewer-relative.
 * Returns null for non-walled items.
 */
export function buildMoneroWallView ({ item, meId, progressPiconeros, myContributionPiconeros, myRateablePiconeros, frozen }) {
  if (!moneroWallEnabled(item)) return null
  const price = toPiconeros(item.moneroWallPricePiconeros)
  const threshold = toPiconeros(item.moneroWallThresholdPiconeros)
  const progress = BigInt(progressPiconeros ?? 0n)
  const contribution = BigInt(myContributionPiconeros ?? 0n)
  const isAuthor = meId != null && Number(item.userId) === Number(meId)
  const publiclyUnlocked = threshold != null && progress >= threshold
  const personallyUnlocked = price != null && contribution >= price
  const locked = !isAuthor && !publiclyUnlocked && !personallyUnlocked
  const coversComments = moneroWallCommentsEnabled(item)
  return {
    pricePiconeros: price,
    thresholdPiconeros: threshold,
    enabledAt: item.moneroWallEnabledAt,
    frozen: !!frozen,
    publiclyUnlocked,
    locked,
    coversComments,
    commentsLocked: coversComments && locked,
    myContributionPiconeros: contribution,
    myRateablePiconeros: BigInt(myRateablePiconeros ?? 0n),
    progressPiconeros: progress,
    remainingPiconeros: threshold == null || progress >= threshold ? 0n : threshold - progress
  }
}

/**
 * className for the item-page teaser: a locked viewer's tail fades into the
 * monerowalled panel below (mask in styles/text.scss). Author, entitled, and
 * publicly unlocked viewers keep the normal hard end.
 */
export function moneroWallTeaserFadeClass (item) {
  return item?.moneroWall?.locked === true ? 'sn-text--wall-faded' : undefined
}

/** Body text safe to publish off-platform (search index, email digest). */
export function indexableMoneroWallText (item) {
  if (!item?.text) return item?.text ?? null
  if (!moneroWallEnabled(item)) return stripMoneroWallMarker(item.text)
  return splitMoneroWallText(item.text).teaserText ?? item.text
}
