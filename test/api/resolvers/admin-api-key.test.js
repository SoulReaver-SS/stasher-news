/* eslint-env jest */
// Admin path for enabling API keys per account: Mutation.setApiKeyEnabled
// (api/resolvers/admin.js) and the User.apiKeyEnabled field only admins see
// (api/resolvers/user.js).
import adminResolvers from '@/api/resolvers/admin'
import userResolvers from '@/api/resolvers/user'
import { SN_ADMIN_IDS } from '@/lib/constants'
import { E_BAD_INPUT, E_FORBIDDEN, E_UNAUTHENTICATED } from '@/lib/error'

// api/resolvers/user.js transitively imports ESM-only lexical deps; same mocks
// as test/api/resolvers/user-mutation-guards.test.js.
jest.mock('../../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const ADMIN = { id: SN_ADMIN_IDS[0] }
const NON_ADMIN = { id: 4242 }
const TARGET_ID = 777

const setApiKeyEnabled = adminResolvers.Mutation.setApiKeyEnabled
const apiKeyEnabledField = userResolvers.User.apiKeyEnabled

function fakeModels ({ exists = true } = {}) {
  const updates = []
  return {
    updates,
    user: {
      findUnique: jest.fn(async ({ where }) => (exists ? { id: where.id, apiKeyEnabled: false } : null)),
      update: jest.fn(async ({ where, data }) => {
        updates.push({ where, data })
        return { id: where.id, name: 'target', ...data }
      })
    }
  }
}

function explodingModels () {
  return new Proxy({}, {
    get (target, prop) {
      throw new Error(`models.${String(prop)} touched before auth guard`)
    }
  })
}

describe('Mutation.setApiKeyEnabled', () => {
  test('rejects anonymous callers before touching the database', async () => {
    await expect(setApiKeyEnabled(null, { id: TARGET_ID, enabled: true }, { me: null, models: explodingModels() }))
      .rejects.toMatchObject({ extensions: { code: E_UNAUTHENTICATED } })
  })

  test('rejects non-admins before touching the database', async () => {
    await expect(setApiKeyEnabled(null, { id: TARGET_ID, enabled: true }, { me: NON_ADMIN, models: explodingModels() }))
      .rejects.toMatchObject({ extensions: { code: E_FORBIDDEN } })
  })

  test('returns an input error for an unknown user instead of a Prisma error', async () => {
    const models = fakeModels({ exists: false })
    await expect(setApiKeyEnabled(null, { id: TARGET_ID, enabled: true }, { me: ADMIN, models }))
      .rejects.toMatchObject({ extensions: { code: E_BAD_INPUT } })
    expect(models.user.update).not.toHaveBeenCalled()
  })

  test('enabling sets the flag and leaves any key hash alone', async () => {
    const models = fakeModels()
    const user = await setApiKeyEnabled(null, { id: String(TARGET_ID), enabled: true }, { me: ADMIN, models })
    expect(models.updates).toEqual([{ where: { id: TARGET_ID }, data: { apiKeyEnabled: true } }])
    expect(user.apiKeyEnabled).toBe(true)
  })

  test('disabling clears the flag and revokes the current key', async () => {
    const models = fakeModels()
    const user = await setApiKeyEnabled(null, { id: String(TARGET_ID), enabled: false }, { me: ADMIN, models })
    expect(models.updates).toEqual([{ where: { id: TARGET_ID }, data: { apiKeyEnabled: false, apiKeyHash: null } }])
    expect(user.apiKeyEnabled).toBe(false)
  })

  test('accepts admin ids that arrive as strings', async () => {
    const models = fakeModels()
    await expect(setApiKeyEnabled(null, { id: TARGET_ID, enabled: true }, { me: { id: String(ADMIN.id) }, models }))
      .resolves.toBeTruthy()
  })
})

describe('User.apiKeyEnabled', () => {
  test('is null for anonymous viewers', async () => {
    expect(await apiKeyEnabledField({ id: TARGET_ID, apiKeyEnabled: true }, {}, { me: null, models: explodingModels() })).toBeNull()
  })

  test('is null for non-admin viewers, including the user themself', async () => {
    const user = { id: TARGET_ID, apiKeyEnabled: true }
    expect(await apiKeyEnabledField(user, {}, { me: NON_ADMIN, models: explodingModels() })).toBeNull()
    expect(await apiKeyEnabledField(user, {}, { me: { id: TARGET_ID }, models: explodingModels() })).toBeNull()
  })

  test('returns the stored flag to admins without an extra query', async () => {
    expect(await apiKeyEnabledField({ id: TARGET_ID, apiKeyEnabled: true }, {}, { me: ADMIN, models: explodingModels() })).toBe(true)
    expect(await apiKeyEnabledField({ id: TARGET_ID, apiKeyEnabled: false }, {}, { me: ADMIN, models: explodingModels() })).toBe(false)
  })

  test('loads the flag for admins when the parent row lacks it', async () => {
    const models = fakeModels()
    expect(await apiKeyEnabledField({ id: TARGET_ID }, {}, { me: ADMIN, models })).toBe(false)
    expect(models.user.findUnique).toHaveBeenCalledWith({ where: { id: TARGET_ID }, select: { apiKeyEnabled: true } })
  })
})
