/* eslint-env jest */
// pubkeyAuth lives inside pages/api/auth/[...nextauth].js and is reachable
// through the phrase provider's authorize(). These tests exercise that entry
// point with every side effect (db, jwt, rate limiting, middleware) mocked,
// mirroring the jest.mock conventions of test/api/auth/authorization.test.js.
// (babel-plugin-jest-hoist lifts the jest.mock calls above the imports.)

import prisma from '../../../api/models'
import { consumeChallenge } from '../../../api/resolvers/phrase'
import { getAuthOptions } from '../../../pages/api/auth/[...nextauth]'
import { getToken, encode } from 'next-auth/jwt'
import { MULTI_AUTH_LIST, MULTI_AUTH_POINTER, MULTI_AUTH_JWT } from '../../../lib/auth'
import * as cookie from 'cookie'

jest.mock('../../../api/models', () => ({
  __esModule: true,
  default: {
    authChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn()
    }
  }
}))

jest.mock('../../../api/resolvers/phrase', () => ({
  __esModule: true,
  consumeChallenge: jest.fn()
}))

jest.mock('../../../lib/recoveryPhrase', () => ({
  __esModule: true,
  verifyChallengeSignature: jest.fn(() => true)
}))

jest.mock('../../../lib/auth', () => ({
  __esModule: true,
  ...jest.requireActual('../../../lib/auth'),
  multiAuthMiddleware: jest.fn(async req => req)
}))

jest.mock('next-auth/jwt', () => ({
  __esModule: true,
  getToken: jest.fn(async () => null),
  encode: jest.fn()
}))

jest.mock('../../../lib/auth-send-limiter', () => ({
  __esModule: true,
  checkEmailSendAllowance: jest.fn(() => true),
  checkPubkeySignupAllowance: jest.fn(() => true)
}))

jest.mock('../../../lib/webPush', () => ({
  __esModule: true,
  notifyReferral: jest.fn()
}))

// parses NEXT_PUBLIC_URL at module scope (new URL(...)), which is unset in the
// CI test env (next/jest only sees gitignored .env.local here). Same mock as
// test/api/ssr-errors.test.js; the route only uses getDomainMapping, which the
// credentials path never reaches.
jest.mock('../../../lib/domains', () => ({
  __esModule: true,
  getDomainMapping: jest.fn()
}))

// ESM-only; jest's CJS sandbox cannot require it (same class of problem the
// uuid shim solves). The route only spreads it into adapter callbacks the
// credentials path never touches.
jest.mock('@auth/prisma-adapter', () => ({
  __esModule: true,
  PrismaAdapter: jest.fn(() => ({}))
}))

// provider list is env-gated; the gate is read when getAuthOptions is called
process.env.PHRASE_AUTH = '1'

const PUBKEY = 'a'.repeat(64)

// shape next-auth hands authorize(): { query, body, headers, method }.
// NodeNextRequest(req) parses cookies from headers.cookie.
function makeReq ({ signinCookie } = {}) {
  return {
    method: 'POST',
    url: '/api/auth/callback/phrase',
    headers: signinCookie ? { cookie: 'signin=true' } : {},
    body: {},
    query: {}
  }
}

function phraseAuthorize () {
  // next-auth v4.24 CredentialsProvider hardcodes id 'credentials' on the raw
  // object and stashes our config (id: 'phrase', authorize) in .options;
  // its core parseProviders merges the two at runtime. Mirror that merge.
  const raw = getAuthOptions(makeReq(), {}).providers.find(p => p.options?.id === 'phrase')
  if (!raw) throw new Error('phrase provider missing — is PHRASE_AUTH set?')
  return { ...raw, ...raw.options }.authorize
}

beforeEach(() => {
  jest.clearAllMocks()
  getToken.mockResolvedValue(null)
  consumeChallenge.mockResolvedValue(true)
  prisma.user.findUnique.mockResolvedValue(null)
})

test('adding an existing phrase account authenticates it without modifying either identity', async () => {
  const existing = { id: 7, name: 'existing' }
  prisma.user.findUnique.mockResolvedValue(existing)
  getToken.mockResolvedValue({ id: 42 })
  const req = makeReq({ signinCookie: true })
  req.body.multiAuth = 'true'

  await expect(phraseAuthorize()({ k1: 'k1', pubkey: PUBKEY, sig: 'sig' }, req)).resolves.toEqual(existing)
  expect(prisma.user.create).not.toHaveBeenCalled()
  expect(prisma.user.update).not.toHaveBeenCalled()
})

test.each(['email', 'phrase'])('%s login selects the added account while retaining the previous account', async provider => {
  const previous = { id: 42, name: 'previous', photoId: null }
  const existing = { id: 7, name: 'existing', photoId: null }
  const req = {
    headers: {},
    cookies: {
      signin: 'true',
      [MULTI_AUTH_LIST]: Buffer.from(JSON.stringify([previous])).toString('base64'),
      [MULTI_AUTH_POINTER]: '42',
      [MULTI_AUTH_JWT(42)]: 'previous-jwt'
    }
  }
  const headers = []
  const res = { appendHeader: (name, value) => headers.push([name, value]) }
  prisma.user.findUnique.mockResolvedValue(existing)
  encode.mockResolvedValue('existing-jwt')

  const token = await getAuthOptions(req, res).callbacks.jwt({ token: {}, user: existing, account: { provider } })
  const cookies = Object.assign({}, ...headers.map(([, value]) => cookie.parse(value)))

  expect(token.id).toBe(7)
  expect(cookies[MULTI_AUTH_POINTER]).toBe('7')
  expect(cookies[MULTI_AUTH_JWT(7)]).toBe('existing-jwt')
  expect(JSON.parse(Buffer.from(cookies[MULTI_AUTH_LIST], 'base64').toString())).toEqual([previous, existing])
  expect(req.cookies[MULTI_AUTH_JWT(42)]).toBe('previous-jwt')
  expect(cookies[MULTI_AUTH_JWT(42)]).toBeUndefined()
  expect(prisma.user.create).not.toHaveBeenCalled()
  expect(prisma.user.update).not.toHaveBeenCalled()
})

test('login mode with an unregistered phrase throws the distinct no-account error', async () => {
  const creds = { k1: 'k1', pubkey: PUBKEY, sig: 'sig' }
  await expect(phraseAuthorize()(creds, makeReq({ signinCookie: true })))
    .rejects.toThrow('PhraseNoAccount')
  // the challenge is consumed before the lookup (single-use semantics);
  // the form mints a fresh one on the next submit
  expect(consumeChallenge).toHaveBeenCalledWith(prisma, 'k1')
  // login mode must never silently create an account
  expect(prisma.user.create).not.toHaveBeenCalled()
})

test('an expired or unknown challenge still resolves null (generic failure)', async () => {
  consumeChallenge.mockResolvedValue(false)
  const creds = { k1: 'k1', pubkey: PUBKEY, sig: 'sig' }
  await expect(phraseAuthorize()(creds, makeReq({ signinCookie: true })))
    .resolves.toBeNull()
})

test('signup mode (no signin cookie) still creates the account', async () => {
  const user = { id: 7, name: PUBKEY.slice(0, 10) }
  prisma.user.create.mockResolvedValue(user)
  const creds = { k1: 'k1', pubkey: PUBKEY, sig: 'sig' }
  await expect(phraseAuthorize()(creds, makeReq())).resolves.toEqual(user)
  expect(prisma.user.create).toHaveBeenCalledWith({
    data: { name: PUBKEY.slice(0, 10), phrasePubkey: PUBKEY }
  })
})
