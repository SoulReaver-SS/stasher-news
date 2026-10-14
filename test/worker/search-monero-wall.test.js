/* eslint-env jest */
// Monerowall-covered discussions (2026-10-14): comments under a walled
// discussion must stay out of the search index (scrapers read search, not
// just GraphQL). The incremental _indexItem path and the bulk indexAllItems
// path both skip them; the lift mutations enqueue subtree re-index jobs so
// opened comments become searchable again.
import { _indexItem } from '../../worker/search'
import search from '../../api/search/index'

jest.mock('../../api/search/index', () => ({
  __esModule: true,
  default: {
    getSource: async () => { throw new Error('not found') },
    index: jest.fn(async () => ({}))
  }
}))

const enabledAt = new Date('2026-09-18T00:00:00Z')

const commentRow = (over = {}) => ({
  id: 5,
  parentId: 1,
  rootId: 1,
  userId: 42,
  title: null,
  text: 'the answer is 42',
  url: null,
  subNames: [],
  status: 'ACTIVE',
  createdAt: new Date('2026-09-19T00:00:00Z'),
  updatedAt: new Date('2026-09-19T00:00:00Z'),
  upvotes: 0,
  ncomments: 0,
  user: { name: 'replyguy' },
  root: { subNames: [] },
  ...over
})

const itemDb = (over = {}) => ({
  weightedVotes: 0,
  weightedDownVotes: 0,
  ranktop: 0,
  text: 'the answer is 42',
  moneroWallEnabledAt: null,
  moneroWallRemovedAt: null,
  parentId: 1,
  rootId: 1,
  ...over
})

const rootRow = (over = {}) => ({
  moneroWallEnabledAt: enabledAt,
  moneroWallRemovedAt: null,
  moneroWallCoversComments: true,
  moneroWallCommentsRemovedAt: null,
  ...over
})

const modelsFor = (root) => ({
  item: {
    findUnique: jest.fn(async ({ where }) =>
      Number(where.id) === 5
        ? itemDb()
        : root)
  },
  bookmark: { findMany: async () => [] }
})

test('skips indexing a comment under a walled discussion', async () => {
  search.index.mockClear()
  const models = modelsFor(rootRow())
  await _indexItem(commentRow(), { models })
  expect(search.index).not.toHaveBeenCalled()
})

test('indexes a comment under a post-only wall (discussion public)', async () => {
  search.index.mockClear()
  const models = modelsFor(rootRow({ moneroWallCoversComments: false }))
  await _indexItem(commentRow(), { models })
  expect(search.index).toHaveBeenCalledTimes(1)
})

test('indexes a comment after the discussion is opened (one-way lift)', async () => {
  search.index.mockClear()
  const models = modelsFor(rootRow({ moneroWallCommentsRemovedAt: new Date('2026-09-21T00:00:00Z') }))
  await _indexItem(commentRow(), { models })
  expect(search.index).toHaveBeenCalledTimes(1)
})

test('indexes a comment whose root has no wall at all', async () => {
  search.index.mockClear()
  const models = modelsFor(rootRow({ moneroWallEnabledAt: null }))
  await _indexItem(commentRow(), { models })
  expect(search.index).toHaveBeenCalledTimes(1)
})

test('skips a comment whose root row cannot be resolved (fail closed, aligned)', async () => {
  search.index.mockClear()
  const models = modelsFor(null)
  await _indexItem(commentRow(), { models })
  expect(search.index).not.toHaveBeenCalled()
})
