/* eslint-env jest */

// Keep the account trigger real without loading unrelated wallet/auth UI.
jest.mock('../../components/nav/common', () => ({
  Indicator: ({ children }) => children,
  NavWalletSummary: () => null,
  LoginButtons: () => null,
  LogoutDropdownItem: () => null
}))

// next/jest stubs SVG files as objects rather than SVGR components.
jest.mock('../../svgs/spy-fill.svg', () => ({
  __esModule: true,
  default: (props) => require('react').createElement('svg', props)
}))

const originalEnv = {
  NEXT_PUBLIC_MEDIA_URL: process.env.NEXT_PUBLIC_MEDIA_URL,
  MEDIA_URL_DOCKER: process.env.MEDIA_URL_DOCKER
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_MEDIA_URL = 'https://media.example.test/uploads'
  process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function renderAccountMenu (me) {
  let html
  jest.isolateModules(() => {
    const React = require('react')
    const { renderToStaticMarkup } = require('react-dom/server')
    const OffCanvas = require('../../components/nav/mobile/offcanvas').default
    html = renderToStaticMarkup(React.createElement(OffCanvas, { me }))
  })
  return html
}

test('server-rendered account avatar uses the public URL, not the Docker endpoint', () => {
  const html = renderAccountMenu({ name: 'bob', photoId: 1808, bioId: 1 })

  expect(html).toContain('src="https://media.example.test/uploads/1808"')
  expect(html).not.toContain('http://minio:9000')
  expect(html).toContain('aria-label="account menu"')
})

test('account without a photo keeps the default avatar', () => {
  const html = renderAccountMenu({ name: 'bob', photoId: null, bioId: 1 })

  expect(html).toContain('src="/xmrgirl.jpg"')
  expect(html).toContain('aria-label="account menu"')
})

test('logged-out account menu remains available without an avatar image', () => {
  const html = renderAccountMenu(null)

  expect(html).toContain('aria-label="account menu"')
  expect(html).not.toContain('<img')
})
