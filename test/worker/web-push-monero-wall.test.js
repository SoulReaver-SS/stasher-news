/* eslint-env jest */
// Monerowall-covered discussions (2026-10-14): push payloads bypass app-side
// gating and any subscriber/parent/mentioned user may be unentitled, so a
// comment under a walled discussion never carries its text in the push body.
// Recipients click through; the in-app view is gated by the resolvers.
import webPush from 'web-push'

// notifyUserSubscribers fires on every comment creation for the author's
// followers — it must mask like its sibling push bodies. The sat-filter and
// subscription lookups use webPush's module-level models (not the injected
// param), so mock the models module itself.
jest.mock('../../api/models', () => ({
  __esModule: true,
  default: {
    user: {
      findMany: jest.fn(async () => [{ id: 55, postsPiconerosFilter: null, commentsPiconerosFilter: null }])
    },
    pushSubscription: { findMany: jest.fn(async () => [{ endpoint: 'https://push.test/1' }]) },
    $queryRawUnsafe: jest.fn(async () => [{ id: '5' }])
  }
}))

jest.mock('web-push', () => ({
  __esModule: true,
  default: { sendNotification: jest.fn(async () => ({})) }
}))

// lib/webPush freezes `webPushEnabled` from these at module load — set them
// BEFORE the dynamic import in beforeAll below.
process.env.VAPID_MAILTO = 'mailto:test@example.com'
process.env.NEXT_PUBLIC_VAPID_PUBKEY = 'BTestVapidPubKeyNotReal00000000000000000000000000000000000000000'
process.env.VAPID_PRIVKEY = 'test-vapid-privkey'

const enabledAt = new Date('2026-09-18T00:00:00Z')

const walledRoot = (over = {}) => ({
  moneroWallEnabledAt: enabledAt,
  moneroWallRemovedAt: null,
  moneroWallCoversComments: true,
  moneroWallCommentsRemovedAt: null,
  ...over
})

const modelsFor = root => ({
  item: { findUnique: jest.fn(async () => root) }
})

const comment = (over = {}) => ({ id: 5, parentId: 1, rootId: 1, text: 'the answer is 42', ...over })

let pushBodyFor
let notifyUserSubscribers

beforeAll(async () => {
  ({ pushBodyFor, notifyUserSubscribers } = await import('../../lib/webPush'))
})

test('walled-discussion comment: body is the placeholder, never the text', async () => {
  const models = modelsFor(walledRoot())
  const body = await pushBodyFor({ models, item: comment() })
  expect(body).not.toContain('the answer is 42')
  expect(body).toMatch(/monerowall/i)
})

test('post-only wall: comment text is delivered as before', async () => {
  const models = modelsFor(walledRoot({ moneroWallCoversComments: false }))
  expect(await pushBodyFor({ models, item: comment() })).toBe('the answer is 42')
})

test('opened discussion: comment text is delivered again', async () => {
  const models = modelsFor(walledRoot({ moneroWallCommentsRemovedAt: new Date('2026-09-21T00:00:00Z') }))
  expect(await pushBodyFor({ models, item: comment() })).toBe('the answer is 42')
})

test('posts keep the existing indexable-text behavior (teaser for walled posts)', async () => {
  const models = modelsFor(walledRoot())
  const post = {
    id: 1,
    parentId: null,
    rootId: null,
    text: 'public intro\n[monerowall]\nsecret body',
    moneroWallEnabledAt: enabledAt,
    moneroWallRemovedAt: null
  }
  expect(await pushBodyFor({ models, item: post })).toBe('public intro')
  expect(models.item.findUnique).not.toHaveBeenCalled()
})

const subscriberModels = (root) => ({
  $queryRaw: jest.fn(async () => [{ followerId: 55, followeeName: 'replyguy' }]),
  item: { findUnique: jest.fn(async () => root) }
})

test('notifyUserSubscribers: walled-discussion comment text never reaches followers', async () => {
  webPush.sendNotification.mockClear()
  const models = subscriberModels(walledRoot())
  await notifyUserSubscribers({ models, item: comment() })
  expect(webPush.sendNotification).toHaveBeenCalledTimes(1)
  const payload = JSON.parse(webPush.sendNotification.mock.calls[0][1]).notification
  expect(payload.body).not.toContain('the answer is 42')
  expect(payload.body).toMatch(/monerowall/i)
})

test('notifyUserSubscribers: comments under post-only walls deliver text as before', async () => {
  webPush.sendNotification.mockClear()
  const models = subscriberModels(walledRoot({ moneroWallCoversComments: false }))
  await notifyUserSubscribers({ models, item: comment() })
  const payload = JSON.parse(webPush.sendNotification.mock.calls[0][1]).notification
  expect(payload.body).toBe('the answer is 42')
})

test('pushBodyFor: an unresolvable root masks too (fail closed, aligned with the resolvers)', async () => {
  const models = modelsFor(null)
  const body = await pushBodyFor({ models, item: comment() })
  expect(body).not.toContain('the answer is 42')
  expect(body).toMatch(/monerowall/i)
})
