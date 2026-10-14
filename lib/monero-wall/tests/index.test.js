/* eslint-env jest */
import {
  MONERO_WALL_MARKER, splitMoneroWallText, stripMoneroWallMarker,
  moneroWallConfigError, moneroWallUpdateError, buildMoneroWallView, indexableMoneroWallText,
  moneroWallCommentsEnabled, moneroWallCommentsConfigError
} from '@/lib/monero-wall'

const walled = (over = {}) => ({
  userId: 7,
  text: 'intro para\n\nsecret body',
  moneroWallPricePiconeros: null,
  moneroWallThresholdPiconeros: null,
  moneroWallEnabledAt: new Date('2026-09-18T00:00:00Z'),
  moneroWallRemovedAt: null,
  ...over
})

describe('splitMoneroWallText', () => {
  test('splits at the marker and strips it from both sides', () => {
    const { teaserText, lockedText, hasMarker } = splitMoneroWallText(`intro\n${MONERO_WALL_MARKER}\nsecret`)
    expect(teaserText).toBe('intro')
    expect(lockedText).toBe('secret')
    expect(hasMarker).toBe(true)
  })

  test('falls back to the first paragraph break', () => {
    const { teaserText, lockedText, hasMarker } = splitMoneroWallText('intro para\n\nsecret body')
    expect(teaserText).toBe('intro para')
    expect(lockedText).toBe('secret body')
    expect(hasMarker).toBe(false)
  })

  test('reports no locked portion for a single paragraph', () => {
    const { teaserText, lockedText } = splitMoneroWallText('just one paragraph')
    expect(teaserText).toBe('just one paragraph')
    expect(lockedText).toBe(null)
  })
})

describe('stripMoneroWallMarker', () => {
  test('removes the marker line from full text', () => {
    expect(stripMoneroWallMarker(`a\n${MONERO_WALL_MARKER}\nb`)).toBe('a\n\nb')
  })
})

describe('moneroWallConfigError', () => {
  const min = 100_000_000n // 0.0001 XMR
  test('accepts a valid price and threshold', () => {
    expect(moneroWallConfigError({ pricePiconeros: 1_000_000_000n, thresholdPiconeros: 5_000_000_000n, text: 'a\n\nb', minTipPiconeros: min })).toBe(null)
  })
  test('rejects a price below the min tip floor', () => {
    expect(moneroWallConfigError({ pricePiconeros: 1n, thresholdPiconeros: null, text: 'a\n\nb', minTipPiconeros: min })).toMatch(/min/i)
  })
  test('rejects a threshold below the price', () => {
    expect(moneroWallConfigError({ pricePiconeros: 5_000_000_000n, thresholdPiconeros: 1_000_000_000n, text: 'a\n\nb', minTipPiconeros: min })).toMatch(/threshold/i)
  })
  test('rejects when no locked content exists', () => {
    expect(moneroWallConfigError({ pricePiconeros: 1_000_000_000n, thresholdPiconeros: null, text: 'one paragraph only', minTipPiconeros: min })).toMatch(/below the wall/i)
  })
})

describe('moneroWallUpdateError', () => {
  const old = walled({ moneroWallPricePiconeros: 1_000_000_000n })
  test('freezes changes after the first payment', () => {
    expect(moneroWallUpdateError({ old, nextPrice: 2_000_000_000n, nextThreshold: null, frozen: true, minTipPiconeros: 100_000_000n, text: old.text })).toMatch(/frozen/i)
  })
  test('allows X/T edits before the first payment', () => {
    expect(moneroWallUpdateError({ old, nextPrice: 2_000_000_000n, nextThreshold: null, frozen: false, minTipPiconeros: 100_000_000n, text: old.text })).toBe(null)
  })
  test('is a no-op when values are unchanged', () => {
    expect(moneroWallUpdateError({ old, nextPrice: 1_000_000_000n, nextThreshold: null, frozen: true, minTipPiconeros: 100_000_000n, text: old.text })).toBe(null)
  })
  test('allows a text-only edit that leaves no locked content (unchanged X/T)', () => {
    expect(moneroWallUpdateError({ old, nextPrice: 1_000_000_000n, nextThreshold: null, frozen: true, minTipPiconeros: 100_000_000n, text: 'one paragraph only' })).toBe(null)
  })
  test('still rejects removing the locked content when X/T change', () => {
    expect(moneroWallUpdateError({ old, nextPrice: 2_000_000_000n, nextThreshold: null, frozen: false, minTipPiconeros: 100_000_000n, text: 'one paragraph only' })).toMatch(/below the wall/i)
  })
  test('rejects nulling both X and T via edit — removal goes through removeMoneroWall', () => {
    expect(moneroWallUpdateError({ old, nextPrice: null, nextThreshold: null, frozen: false, minTipPiconeros: 100_000_000n, text: old.text })).toMatch(/remove/i)
  })
  test('rejects adding a wall to a never-walled post at edit (create-time only)', () => {
    expect(moneroWallUpdateError({ old: walled({ moneroWallEnabledAt: null }), nextPrice: 1_000_000_000n, nextThreshold: null, frozen: false, minTipPiconeros: 100_000_000n, text: 'a\n\nb' })).toMatch(/created/i)
  })
  test('rejects re-adding a removed wall', () => {
    expect(moneroWallUpdateError({ old: walled({ moneroWallRemovedAt: new Date('2026-09-20T00:00:00Z') }), nextPrice: 1_000_000_000n, nextThreshold: null, frozen: false, minTipPiconeros: 100_000_000n, text: 'a\n\nb' })).toMatch(/re-add|cannot be re/i)
  })
})

describe('buildMoneroWallView', () => {
  test('locks for a stranger with only partial progress', () => {
    const item = walled({ moneroWallPricePiconeros: 1_000_000_000n, moneroWallThresholdPiconeros: 5_000_000_000n })
    const view = buildMoneroWallView({ item, meId: 99, progressPiconeros: 2_000_000_000n, myContributionPiconeros: 0n, frozen: false })
    expect(view.locked).toBe(true)
    expect(view.publiclyUnlocked).toBe(false)
    expect(view.remainingPiconeros).toBe(3_000_000_000n)
  })
  test('publicly unlocks at the threshold for everyone', () => {
    const item = walled({ moneroWallThresholdPiconeros: 5_000_000_000n })
    const view = buildMoneroWallView({ item, meId: null, progressPiconeros: 5_000_000_000n, myContributionPiconeros: 0n, frozen: true })
    expect(view.locked).toBe(false)
    expect(view.publiclyUnlocked).toBe(true)
  })
  test('personally unlocks a contributor at the price', () => {
    const item = walled({ moneroWallPricePiconeros: 1_000_000_000n })
    const view = buildMoneroWallView({ item, meId: 99, progressPiconeros: 1_000_000_000n, myContributionPiconeros: 1_000_000_000n, frozen: true })
    expect(view.locked).toBe(false)
  })
  test('never locks the author', () => {
    const item = walled({ moneroWallPricePiconeros: 9_000_000_000n })
    const view = buildMoneroWallView({ item, meId: 7, progressPiconeros: 0n, myContributionPiconeros: 0n, frozen: false })
    expect(view.locked).toBe(false)
  })
  test('returns null for a non-walled item', () => {
    expect(buildMoneroWallView({ item: walled({ moneroWallEnabledAt: null }), meId: 1, progressPiconeros: 0n, myContributionPiconeros: 0n, frozen: false })).toBe(null)
  })
  test('returns null for a removed wall (one-way removal)', () => {
    expect(buildMoneroWallView({ item: walled({ moneroWallRemovedAt: new Date('2026-09-20T00:00:00Z') }), meId: 1, progressPiconeros: 0n, myContributionPiconeros: 0n, frozen: false })).toBe(null)
  })
})

describe('moneroWallCommentsEnabled', () => {
  const walledComments = (over = {}) => walled({ moneroWallCoversComments: true, ...over })
  test('is true for an active wall covering comments', () => {
    expect(moneroWallCommentsEnabled(walledComments())).toBe(true)
  })
  test('is false when the wall does not cover comments', () => {
    expect(moneroWallCommentsEnabled(walled())).toBe(false)
  })
  test('is false once the discussion is opened (one-way lift)', () => {
    expect(moneroWallCommentsEnabled(walledComments({ moneroWallCommentsRemovedAt: new Date('2026-09-21T00:00:00Z') }))).toBe(false)
  })
  test('is false when the whole wall is removed (removal is a superset)', () => {
    expect(moneroWallCommentsEnabled(walledComments({ moneroWallRemovedAt: new Date('2026-09-20T00:00:00Z') }))).toBe(false)
  })
  test('is false for a never-walled or missing item', () => {
    expect(moneroWallCommentsEnabled(walledComments({ moneroWallEnabledAt: null }))).toBe(false)
    expect(moneroWallCommentsEnabled(null)).toBe(false)
  })
})

describe('moneroWallCommentsConfigError', () => {
  const leg = { hasWallLeg: true }
  test('accepts the flag at creation with a wall leg', () => {
    expect(moneroWallCommentsConfigError({ coversComments: true, ...leg, old: null })).toBe(null)
  })
  test('rejects the flag at creation without a wall', () => {
    expect(moneroWallCommentsConfigError({ coversComments: true, hasWallLeg: false, old: null })).toMatch(/requires a monerowall/i)
  })
  test('rejects enabling the flag at edit on a post without it (create-time only)', () => {
    const old = walled({ moneroWallCoversComments: false })
    expect(moneroWallCommentsConfigError({ coversComments: true, ...leg, old })).toMatch(/created/i)
  })
  test('accepts resubmitting the stored value at edit', () => {
    const old = walled({ moneroWallCoversComments: true })
    expect(moneroWallCommentsConfigError({ coversComments: true, ...leg, old })).toBe(null)
  })
  test('ignores a falsy flag everywhere', () => {
    expect(moneroWallCommentsConfigError({ coversComments: false, hasWallLeg: false, old: null })).toBe(null)
    expect(moneroWallCommentsConfigError({ coversComments: null, hasWallLeg: false, old: walled() })).toBe(null)
  })
})

describe('buildMoneroWallView comments fields', () => {
  test('reports coversComments and commentsLocked for a locked viewer', () => {
    const item = walled({ moneroWallCoversComments: true, moneroWallPricePiconeros: 1_000_000_000n })
    const view = buildMoneroWallView({ item, meId: 99, progressPiconeros: 0n, myContributionPiconeros: 0n, frozen: false })
    expect(view.coversComments).toBe(true)
    expect(view.commentsLocked).toBe(true)
    expect(view.locked).toBe(true)
  })
  test('commentsLocked is false once the viewer is entitled', () => {
    const item = walled({ moneroWallCoversComments: true, moneroWallPricePiconeros: 1_000_000_000n })
    const view = buildMoneroWallView({ item, meId: 99, progressPiconeros: 0n, myContributionPiconeros: 1_000_000_000n, frozen: false })
    expect(view.coversComments).toBe(true)
    expect(view.commentsLocked).toBe(false)
  })
  test('commentsLocked is false when the discussion is opened', () => {
    const item = walled({ moneroWallCoversComments: true, moneroWallPricePiconeros: 1_000_000_000n, moneroWallCommentsRemovedAt: new Date('2026-09-21T00:00:00Z') })
    const view = buildMoneroWallView({ item, meId: 99, progressPiconeros: 0n, myContributionPiconeros: 0n, frozen: false })
    expect(view.coversComments).toBe(false)
    expect(view.commentsLocked).toBe(false)
  })
  test('commentsLocked is false when the wall never covered comments', () => {
    const view = buildMoneroWallView({ item: walled({ moneroWallPricePiconeros: 1_000_000_000n }), meId: 99, progressPiconeros: 0n, myContributionPiconeros: 0n, frozen: false })
    expect(view.coversComments).toBe(false)
    expect(view.commentsLocked).toBe(false)
  })
})

describe('indexableMoneroWallText', () => {
  test('returns teaser only for walled items', () => {
    expect(indexableMoneroWallText(walled())).toBe('intro para')
  })
  test('returns full text for non-walled items', () => {
    expect(indexableMoneroWallText(walled({ moneroWallEnabledAt: null }))).toBe('intro para\n\nsecret body')
  })
  test('returns full text for removed walls', () => {
    expect(indexableMoneroWallText(walled({ moneroWallRemovedAt: new Date('2026-09-20T00:00:00Z') }))).toBe('intro para\n\nsecret body')
  })
})
