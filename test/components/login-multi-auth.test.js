/* eslint-env jest */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { signIn } from 'next-auth/react'
import Login, { EmailLoginForm } from '../../components/login'

jest.mock('next-auth/react', () => ({ signIn: jest.fn() }))

jest.mock('next/router', () => ({
  useRouter: () => ({ query: {}, pathname: '/login', push: jest.fn() })
}))
jest.mock('../../components/use-cookie', () => ({
  __esModule: true,
  default: () => [null, jest.fn()]
}))
jest.mock('../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../components/nostr-auth', () => ({ NostrAuthWithExplainer: () => null }))
jest.mock('../../components/account', () => ({ AccountChooser: () => null }))
jest.mock('../../components/phrase-login-form', () => ({ __esModule: true, default: () => null }))

const providers = {
  phrase: { id: 'phrase', name: 'Phrase', type: 'credentials' },
  email: { id: 'email', name: 'Email', type: 'email' },
  github: { id: 'github', name: 'GitHub', type: 'oauth' }
}

test.each([true, 'true'])('offers recovery-phrase login when adding an existing account (multiAuth=%s)', multiAuth => {
  const html = renderToStaticMarkup(<Login providers={providers} signin multiAuth={multiAuth} />)

  expect(html).toMatch(/<button[^>]*>Log in without Email<\/button>/)
  expect(html).not.toContain('disabled=')
  expect(html).not.toContain('with GitHub')
})

test.each([true, 'true'])('offers an enabled email form when adding an existing account (multiAuth=%s)', multiAuth => {
  const html = renderToStaticMarkup(<Login providers={providers} signin multiAuth={multiAuth} text='Log in' />)

  expect(html).toContain('name="email"')
  expect(html).toContain('Log in with Email')
  expect(html).not.toContain('disabled=')
  expect(html).not.toContain('with GitHub')
})

test('submitting an email preserves the callback and account-switching intent', async () => {
  const originalWindow = global.window
  const setItem = jest.fn()
  global.window = { sessionStorage: { setItem } }
  try {
    const form = EmailLoginForm({ callbackUrl: '/settings', multiAuth: true })
    await form.props.onSubmit({ email: 'existing@example.com' })

    expect(setItem).toHaveBeenCalledWith('callback', JSON.stringify({ email: 'existing@example.com', callbackUrl: '/settings' }))
    expect(signIn).toHaveBeenCalledWith('email', {
      email: 'existing@example.com', callbackUrl: '/settings', multiAuth: true
    })
  } finally {
    global.window = originalWindow
  }
})
