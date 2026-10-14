/* eslint-env jest */
// Monerowall-covered discussions (2026-10-14): a walled-discussion comment
// that tops an anniversary day resolves with text: null for the anon worker
// (fail-closed resolver gate). topComments must not crash the thisDay job on
// it — and must never post the underlying text either.
import { topComments } from '../../worker/thisDay'

// thisDay → weeklyPosts drags the payIn/lexical ESM chain in; this test only
// exercises the pure topComments formatter, so stub weeklyPosts wholesale.
jest.mock('../../worker/weeklyPosts', () => ({
  __esModule: true,
  autoPost: jest.fn(async () => {})
}))

// read at call time by topComments (link prefix)
process.env.NEXT_PUBLIC_URL = 'https://test.stasher.news'

const baseComment = (over = {}) => ({
  id: 5,
  root: { id: 1, title: 'a puzzle' },
  piconeros: 1_000_000n,
  ncomments: 2,
  user: { name: 'replyguy' },
  text: 'first line\nsecond line',
  ...over
})

test('includes a normal top comment with its first line', () => {
  const text = topComments([{ day: '2025-10-14', data: { comments: { items: [baseComment()] } } }])
  expect(text).toContain('first line')
  expect(text).not.toContain('second line')
})

test('skips the quote line for a walled comment (null text) instead of crashing', () => {
  const text = topComments([{ day: '2025-10-14', data: { comments: { items: [baseComment({ text: null })] } } }])
  expect(text).toContain('/items/1?commentId=5')
  expect(text).not.toContain('null')
  expect(text).not.toContain('undefined')
})
