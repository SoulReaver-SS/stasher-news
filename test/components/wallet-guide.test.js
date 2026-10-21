/* eslint-env jest */
// Pins the wallet-guide card copy on /wallets (components/wallet-setup.js):
// the "New to Monero?" section must keep pointing at the user-written guide.
// Renders with the repo's linkedom harness (see
// test/components/header-merged.test.js); only environment-level leaves are
// mocked (the module's component/hook imports never rendered by this card).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { parseHTML } from 'linkedom'

jest.mock(`${process.cwd()}/components/form`, () => ({
  Form: 'form',
  Input: 'input',
  SubmitButton: 'button',
  CopyButton: 'button'
}))
jest.mock(`${process.cwd()}/components/toast`, () => ({ useToast: () => () => {} }))
jest.mock(`${process.cwd()}/components/modal`, () => ({ useShowModal: () => () => {} }))
jest.mock(`${process.cwd()}/components/obstacle`, () => ({ ObstacleButtons: () => null }))
jest.mock(`${process.cwd()}/components/qr`, () => ({ __esModule: true, default: () => null }))
jest.mock('@apollo/client/react', () => ({
  __esModule: true,
  useQuery: () => ({ data: undefined }),
  useMutation: () => [jest.fn(), { loading: false }]
}))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }) => <a href={href} {...props}>{children}</a>
}))

import { WalletGuideCard } from '@/components/wallet-setup'

let win
let container

beforeAll(() => {
  const parsed = parseHTML('<!doctype html><html><body></body></html>')
  win = parsed.window
  global.window = win
  global.document = parsed.document
  global.navigator = win.navigator
  global.HTMLElement = win.HTMLElement
  global.Node = win.Node
  global.IS_REACT_ACT_ENVIRONMENT = true

  container = parsed.document.createElement('div')
  parsed.document.body.appendChild(container)
})

afterAll(() => {
  delete global.window
  delete global.document
  delete global.navigator
  delete global.HTMLElement
  delete global.Node
  delete global.IS_REACT_ACT_ENVIRONMENT
})

function render (element) {
  act(() => {
    createRoot(container).render(element)
  })
  return container.innerHTML
}

test('wallet guide card links the user-written Monero guide under the recommendations', () => {
  const html = render(<WalletGuideCard />)

  expect(html).toContain('New to Monero?')
  const guide = container.querySelector('a[href="/items/339260"]')
  expect(guide).not.toBeNull()
  expect(guide.textContent).toContain('guide to Monero wallets')
  // the wallet recommendations are untouched
  expect(container.querySelector('a[href="https://featherwallet.org"]')).not.toBeNull()
})
