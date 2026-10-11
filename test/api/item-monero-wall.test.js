/* eslint-env jest */
import resolvers from '@/api/resolvers/item'
import { Prisma } from '@prisma/client'
import { applyItemUpdate } from '@/api/payIn/types/itemUpdate'

// api/resolvers/item.js drags in heavy ESM-only transitive deps; the mocks
// below break that chain — same pattern as test/api/resolvers/item-*.test.js.
jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

// applyItemUpdate (Task 3 invalidation tests below) statically imports the
// ESM-only lexical mentions chain and queries text-derived relations; stub the
// same boundaries test/engine/payInItemUpdate.test.js stubs.
jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))

jest.mock('../../api/payIn/lib/item', () => ({
  __esModule: true,
  getMentions: async () => [],
  getItemMentions: async () => [],
  getSubs: async () => [],
  performBotBehavior: async () => {}
}))

jest.mock('../../api/payIn/lib/upload', () => ({
  __esModule: true,
  getTempImgproxyUrls: async () => ({})
}))

// keep the real resolvers; only applyItemUpdate's tail getItem is stubbed
jest.mock('../../api/resolvers/item', () => {
  const actual = jest.requireActual('../../api/resolvers/item')
  return { ...actual, __esModule: true, getItem: jest.fn(async () => ({})) }
})

const enabledAt = new Date('2026-09-18T00:00:00Z')
const lockedItem = {
  id: 1,
  userId: 7,
  text: 'public intro\n[monerowall]\nsecret body',
  moneroWallPricePiconeros: 1_000_000_000n,
  moneroWallThresholdPiconeros: 5_000_000_000n,
  moneroWallEnabledAt: enabledAt
}
const unlockedItem = {
  ...lockedItem,
  moneroWallThresholdPiconeros: 1_000_000_000n
}
const fakeLoader = state => ({ load: async () => state })
const lockedState = { progressPiconeros: 2_000_000_000n, myContributionPiconeros: 0n, frozen: true }
const entitledState = { progressPiconeros: 2_000_000_000n, myContributionPiconeros: 1_000_000_000n, frozen: true }
const publicState = { progressPiconeros: 5_000_000_000n, myContributionPiconeros: 0n, frozen: true }

test('text: locked viewer gets the teaser only', async () => {
  const text = await resolvers.Item.text(lockedItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(text).toBe('public intro')
})

test('text: entitled viewer gets full text without the marker', async () => {
  const text = await resolvers.Item.text(lockedItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(entitledState) })
  expect(text).toBe('public intro\n\nsecret body')
})

test('text: author gets raw text with the marker for editing', async () => {
  const text = await resolvers.Item.text(lockedItem, {}, { me: { id: 7 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(text).toBe('public intro\n[monerowall]\nsecret body')
})

test('text: publicly unlocked item serves full text to anonymous viewers', async () => {
  const text = await resolvers.Item.text(unlockedItem, {}, { me: null, moneroWallLoader: fakeLoader(publicState) })
  expect(text).toBe('public intro\n\nsecret body')
})

test('excerpt: teaser-based while locked', async () => {
  const excerpt = await resolvers.Item.excerpt(lockedItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(excerpt).toBe('public intro')
})

test('excerpt: full once publicly unlocked', async () => {
  const excerpt = await resolvers.Item.excerpt(unlockedItem, {}, { me: null, moneroWallLoader: fakeLoader(publicState) })
  expect(excerpt).toContain('secret body')
})

test('moneroWall: returns the view for walled items and null otherwise', async () => {
  const view = await resolvers.Item.moneroWall(lockedItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(view.locked).toBe(true)
  expect(view.remainingPiconeros).toBe(3_000_000_000n)
  expect(await resolvers.Item.moneroWall({ ...lockedItem, moneroWallEnabledAt: null }, {}, { me: null, moneroWallLoader: fakeLoader(lockedState) })).toBe(null)
})

test('moneroWall + text: a removed wall is inert — null view, full text for everyone', async () => {
  const removed = { ...lockedItem, moneroWallRemovedAt: new Date('2026-09-20T00:00:00Z') }
  expect(await resolvers.Item.moneroWall(removed, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })).toBe(null)
  const text = await resolvers.Item.text(removed, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(text).toBe('public intro\n\nsecret body')
})

const capturingLexicalLoader = () => {
  const calls = []
  return { calls, load: async arg => { calls.push(arg); return {} } }
}

test('html: locked viewer — lexical loader receives only the teaser', async () => {
  const loader = capturingLexicalLoader()
  await resolvers.Item.html(lockedItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState), lexicalStateLoader: loader })
  expect(loader.calls).toHaveLength(1)
  expect(loader.calls[0].text).toBe('public intro')
  expect(loader.calls[0].text).not.toContain('secret body')
})

test('lexicalState: author — lexical loader receives marker-stripped full text', async () => {
  const loader = capturingLexicalLoader()
  await resolvers.Item.lexicalState(lockedItem, {}, { me: { id: 7 }, moneroWallLoader: fakeLoader(lockedState), lexicalStateLoader: loader })
  expect(loader.calls).toHaveLength(1)
  expect(loader.calls[0].text).toBe('public intro\n\nsecret body')
})

test('lexicalState: non-walled item — lexical loader receives text unchanged', async () => {
  const plain = { ...lockedItem, text: 'raw body', moneroWallEnabledAt: null, moneroWallRemovedAt: null }
  const loader = capturingLexicalLoader()
  await resolvers.Item.lexicalState(plain, {}, { me: null, moneroWallLoader: fakeLoader(lockedState), lexicalStateLoader: loader })
  expect(loader.calls).toHaveLength(1)
  expect(loader.calls[0].text).toBe('raw body')
})

// --- H1 (2026-09-26 review): imgproxyUrls must not leak below-wall media ---
// The worker derives signed derivative URLs from the FULL text, below the wall
// included, and the field had no resolver — the raw map serialized to every
// viewer in every payload. Locked viewers now get only teaser-referenced
// entries; the client Text/ItemEmbed renderers look entries up by URL, so
// teaser media keeps rendering.
const walledMediaItem = {
  ...lockedItem,
  text: 'public intro\n\n![teaser image](https://media.stasher.news/uploads/101)\n[monerowall]\nsecret body\n\n![secret image](https://media.stasher.news/uploads/202)',
  imgproxyUrls: {
    'https://media.stasher.news/uploads/101': { '640w': '/sig/rs/101', '960w': '/sig/rs/101b' },
    'https://media.stasher.news/uploads/202': { '640w': '/sig/rs/202', video: true }
  }
}

test('imgproxyUrls: locked viewer receives only teaser-referenced derivatives', async () => {
  const urls = await resolvers.Item.imgproxyUrls(walledMediaItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(Object.keys(urls)).toEqual(['https://media.stasher.news/uploads/101'])
  expect(urls['https://media.stasher.news/uploads/101']['640w']).toBe('/sig/rs/101')
})

test('imgproxyUrls: entitled viewer receives the full map', async () => {
  const urls = await resolvers.Item.imgproxyUrls(walledMediaItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(entitledState) })
  expect(Object.keys(urls).sort()).toEqual(['https://media.stasher.news/uploads/101', 'https://media.stasher.news/uploads/202'])
})

test('imgproxyUrls: author receives the full map (edits below-wall media)', async () => {
  const urls = await resolvers.Item.imgproxyUrls(walledMediaItem, {}, { me: { id: 7 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(Object.keys(urls)).toHaveLength(2)
})

test('imgproxyUrls: publicly unlocked item serves the full map to anonymous viewers', async () => {
  const item = { ...walledMediaItem, moneroWallThresholdPiconeros: 1_000_000_000n }
  const urls = await resolvers.Item.imgproxyUrls(item, {}, { me: null, moneroWallLoader: fakeLoader(publicState) })
  expect(Object.keys(urls)).toHaveLength(2)
})

test('imgproxyUrls: non-walled items pass through untouched', async () => {
  const item = { id: 2, userId: 7, text: 'no wall here', imgproxyUrls: { 'https://x.test/1.png': { '640w': '/s/x' } } }
  const urls = await resolvers.Item.imgproxyUrls(item, {}, { me: null })
  expect(urls).toBe(item.imgproxyUrls)
})

// exact whole-token matching (final review, regraded Important): substring
// matching kept a below-wall key whenever the teaser contained that URL as a
// PREFIX of a longer teaser URL (/uploads/202 vs /uploads/2023) — a leak on a
// security gate. Matching now requires the URL as a whole token in the teaser
// (the same exact-key lookup the client's MediaNode transform does), so only
// genuinely referenced URLs survive.
test('imgproxyUrls: exact-URL matching — a below-wall key that is a substring of a teaser URL does not leak', async () => {
  const item = {
    ...walledMediaItem,
    text: 'public intro\n\n![teaser image](https://media.stasher.news/uploads/2023)\n[monerowall]\nsecret body\n\n![secret image](https://media.stasher.news/uploads/202)',
    imgproxyUrls: {
      'https://media.stasher.news/uploads/202': { '640w': '/sig/rs/202' },
      'https://media.stasher.news/uploads/2023': { '640w': '/sig/rs/2023' }
    }
  }
  const urls = await resolvers.Item.imgproxyUrls(item, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(Object.keys(urls)).toEqual(['https://media.stasher.news/uploads/2023'])
})

// the public link's own derivatives are body-independent (the wall gates the
// body text, not the post's link), so locked viewers keep the link embed
test('imgproxyUrls: locked viewers keep the public link (item.url) derivatives', async () => {
  const item = {
    ...walledMediaItem,
    url: 'https://example.com/article',
    imgproxyUrls: {
      'https://example.com/article': { '640w': '/sig/article' },
      'https://media.stasher.news/uploads/202': { '640w': '/sig/rs/202', video: true }
    },
    text: 'public intro\n[monerowall]\nsecret body'
  }
  const urls = await resolvers.Item.imgproxyUrls(item, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(Object.keys(urls)).toEqual(['https://example.com/article'])
})

// --- xPreview: one cached preview, published only when it is provably public ---
// The worker caches the preview's `sourceUrl` and whether that source came from
// the public main URL or the public teaser (`publicSource`). A locked viewer
// must never receive tweet text or signed image derivatives selected from
// below the wall; old previews without provenance fail closed unless they
// match a validated main URL.
const makePreview = (overrides = {}) => ({
  statusUrl: 'https://x.com/alice/status/123',
  sourceUrl: 'https://x.com/alice/status/123',
  publicSource: false,
  handle: 'alice',
  authorName: 'Alice',
  text: 'secret tweet text',
  date: 'October 9, 2026',
  image: { '640w': '/sig/tweet' },
  ...overrides
})

const walledWithPreview = (overrides = {}) => ({
  ...lockedItem,
  url: 'https://example.com/article',
  xPreview: makePreview(),
  ...overrides
})

test('xPreview: locked viewer does not see a hidden body preview', async () => {
  const preview = await resolvers.Item.xPreview(walledWithPreview(), {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(preview).toBeNull()
})

test('xPreview: anonymous viewer does not see a hidden body preview', async () => {
  const preview = await resolvers.Item.xPreview(walledWithPreview(), {}, { me: null, moneroWallLoader: fakeLoader(lockedState) })
  expect(preview).toBeNull()
})

test('xPreview: entitled viewer sees the full preview', async () => {
  const preview = await resolvers.Item.xPreview(walledWithPreview(), {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(entitledState) })
  expect(preview.text).toBe('secret tweet text')
  expect(preview.image['640w']).toBe('/sig/tweet')
})

test('xPreview: author sees the full preview', async () => {
  const preview = await resolvers.Item.xPreview(walledWithPreview(), {}, { me: { id: 7 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(preview.text).toBe('secret tweet text')
})

test('xPreview: publicly unlocked item serves the full preview', async () => {
  const item = { ...walledWithPreview(), moneroWallThresholdPiconeros: 1_000_000_000n }
  const preview = await resolvers.Item.xPreview(item, {}, { me: null, moneroWallLoader: fakeLoader(publicState) })
  expect(preview.text).toBe('secret tweet text')
})

test('xPreview: a preview from the public main URL passes even when locked', async () => {
  const item = walledWithPreview({ url: 'https://x.com/alice/status/123' })
  const preview = await resolvers.Item.xPreview(item, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(preview.statusUrl).toBe('https://x.com/alice/status/123')
})

test('xPreview: a legacy preview without provenance passes only when it matches the validated main URL', async () => {
  const legacy = {
    ...lockedItem,
    url: 'https://x.com/alice/status/123',
    xPreview: { statusUrl: 'https://x.com/alice/status/123', text: 'legacy tweet', handle: 'alice' }
  }
  const preview = await resolvers.Item.xPreview(legacy, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(preview.statusUrl).toBe('https://x.com/alice/status/123')

  const mismatch = walledWithPreview({
    xPreview: { statusUrl: 'https://x.com/alice/status/123', text: 'legacy tweet', handle: 'alice' }
  })
  expect(await resolvers.Item.xPreview(mismatch, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })).toBeNull()
})

test('xPreview: a teaser-derived preview is served to locked viewers', async () => {
  const item = walledWithPreview({
    text: 'teaser [shown](https://x.com/alice/status/123)\n[monerowall]\nsecret',
    xPreview: makePreview({ publicSource: true })
  })
  const preview = await resolvers.Item.xPreview(item, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(preview.statusUrl).toBe('https://x.com/alice/status/123')
})

test('xPreview: publicSource is honored only when sourceUrl and statusUrl agree (prefix-similar data fails closed)', async () => {
  const item = walledWithPreview({
    xPreview: makePreview({ publicSource: true, sourceUrl: 'https://x.com/alice/status/12' })
  })
  expect(await resolvers.Item.xPreview(item, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })).toBeNull()
})

test('xPreview: non-walled items pass through untouched', async () => {
  const item = { id: 2, userId: 7, text: 'no wall here', url: 'https://example.com/article', xPreview: makePreview() }
  expect(await resolvers.Item.xPreview(item, {}, { me: null })).toBe(item.xPreview)
})

// --- xPreview invalidation: a content edit clears the cached preview in the
// same write, before the async imgproxy refresh can run ---
const editTx = (old) => ({
  item: {
    findUnique: jest.fn(async () => old),
    update: jest.fn(async () => old)
  },
  observedTip: { findFirst: jest.fn(async () => null) },
  $executeRaw: jest.fn(async () => 1)
})

const oldRow = {
  ...lockedItem,
  subNames: [],
  imgproxyUrls: null,
  mentions: [],
  itemUploads: [],
  itemReferrers: [],
  threadSubscriptions: []
}

test('applyItemUpdate: a text edit clears the cached preview in the same write', async () => {
  const tx = editTx(oldRow)
  await applyItemUpdate(tx, { piconeros: 0n }, { id: 1, userId: 7, text: 'new body [t](https://x.com/alice/status/123)' })
  const { data } = tx.item.update.mock.calls[0][0]
  expect(data.xPreview).toBe(Prisma.DbNull)
})

test('applyItemUpdate: a url edit clears the cached preview', async () => {
  const tx = editTx(oldRow)
  await applyItemUpdate(tx, { piconeros: 0n }, { id: 1, userId: 7, url: 'https://x.com/new/status/9' })
  const { data } = tx.item.update.mock.calls[0][0]
  expect(data.xPreview).toBe(Prisma.DbNull)
})

test('applyItemUpdate: an unrelated edit leaves the cached preview alone', async () => {
  const tx = editTx(oldRow)
  await applyItemUpdate(tx, { piconeros: 0n }, { id: 1, userId: 7, title: 'new title' })
  const { data } = tx.item.update.mock.calls[0][0]
  expect('xPreview' in data).toBe(false)
})
