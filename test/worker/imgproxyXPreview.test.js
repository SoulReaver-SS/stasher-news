/* eslint-env jest */

// Regression (security): a stale worker must never re-publish an X preview —
// with its public-provenance claim — computed from an item whose content
// changed while the fetch was in flight. The worker publishes through an
// atomic compare-and-set on the content snapshot (text/url/wall fields) used
// for selection; the fake below evaluates the same predicate the database
// would, so a mid-flight edit makes the write a no-op.

import { fetchXPreview } from '../../lib/x-preview'

jest.mock('../../lib/md', () => ({ __esModule: true, extractUrls: () => [] }))
jest.mock('../../lib/x-preview', () => ({ __esModule: true, fetchXPreview: jest.fn() }))
jest.mock('../../lib/x-preview/select', () => ({
  __esModule: true,
  selectXPreviewCandidate: () => ({
    sourceUrl: 'https://x.com/alice/status/123',
    statusUrl: 'https://x.com/alice/status/123',
    publicSource: true
  })
}))
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))
jest.mock('../../lib/imgproxy', () => ({
  __esModule: true,
  imgProxyEnabled: false,
  createImgproxyPath: () => '/sig/path'
}))

let imgproxy

beforeAll(async () => {
  imgproxy = (await import('@/worker/imgproxy')).imgproxy
})

const makeRow = (overrides = {}) => ({
  id: 9,
  url: 'https://x.com/alice/status/123',
  text: 'teaser [t](https://x.com/alice/status/123)',
  addendumText: null,
  isJob: false,
  imgproxyUrls: null,
  xPreview: null,
  moneroWallEnabledAt: null,
  moneroWallRemovedAt: null,
  ...overrides
})

// updateMany evaluates the worker's content predicate against the mutable
// row — the same atomic WHERE the database applies to the real UPDATE
const makeModels = (row) => ({
  item: {
    findUnique: async () => ({ ...row }),
    updateMany: jest.fn(async ({ where, data }) => {
      const matches = where.id === row.id &&
        where.text === row.text &&
        where.url === row.url &&
        where.moneroWallEnabledAt === row.moneroWallEnabledAt &&
        where.moneroWallRemovedAt === row.moneroWallRemovedAt
      if (!matches) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    })
  }
})

beforeEach(() => fetchXPreview.mockReset())

test('a stale worker discards its preview after an edit moved the link below the wall', async () => {
  const row = makeRow({ moneroWallEnabledAt: new Date('2026-09-18T00:00:00Z') })
  const models = makeModels(row)
  let release
  fetchXPreview.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const worker = imgproxy({ data: { id: row.id }, models })
  // let the worker reach its network fetch before the edit lands
  await new Promise(resolve => setImmediate(resolve))

  // the edit lands while the fetch is in flight: same link moved below the
  // wall, and the invalidator cleared the cached preview synchronously
  row.text = 'teaser\n[monerowall]\nsecret [t](https://x.com/alice/status/123)'
  row.xPreview = null

  release({ handle: 'alice', text: 'secret tweet', statusUrl: 'https://x.com/alice/status/123' })
  await worker

  expect(row.xPreview).toBeNull()
})

test('an unchanged snapshot publishes the preview through the guarded write', async () => {
  const row = makeRow()
  const models = makeModels(row)
  fetchXPreview.mockResolvedValue({ handle: 'alice', text: 'tweet', statusUrl: 'https://x.com/alice/status/123' })
  await imgproxy({ data: { id: row.id }, models })

  expect(models.item.updateMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      id: row.id,
      text: 'teaser [t](https://x.com/alice/status/123)',
      url: 'https://x.com/alice/status/123',
      moneroWallEnabledAt: null,
      moneroWallRemovedAt: null
    })
  }))
  expect(row.xPreview).toEqual(expect.objectContaining({
    sourceUrl: 'https://x.com/alice/status/123',
    publicSource: true,
    statusUrl: 'https://x.com/alice/status/123'
  }))
})
