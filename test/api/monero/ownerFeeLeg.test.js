/* eslint-env jest */
import { execSync } from 'node:child_process'
import { createOwnerFeeLeg, createPlatformFeeLeg, resolveFeeAccount, FEE_PID_TTL_MS } from '@/api/monero/ownerFeeLeg'
import { FEE_RESERVE_ATTEMPTS_PER_USER } from '@/api/monero/feePool'
import { moneroUriAddress, moneroUriAmountPiconeros } from '@/lib/format'
import { __resetForTests } from '@/lib/rate-limit'

// stagenet primary (from payInItemCreate.test.js) — valid base58+checksum so
// makeIntegratedAddress can derive an integrated address from it.
const PRIMARY = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'

// A distinct test-only stagenet address standing in for the rewards primary.
const PLATFORM = '53fNxyrnpzq9b7oZQt3SHsGJgyLLXEJGDP2G979eNKNdVjqJPC8xg6hcTNGgFKocCVj1EmSNAyrBf6uHjeeDNhPb9YHQX88'

function mockModels ({ rewardsAccount = { id: 91, address: PLATFORM, status: 'ACTIVE', label: 'platform_rewards', network: 'STAGENET' } } = {}) {
  const created = []
  return {
    created,
    subFeePidMap: {
      create: async ({ data }) => { created.push(data); return data }
    },
    moneroAccount: { findFirst: jest.fn(async () => rewardsAccount) }
  }
}

beforeEach(() => {
  __resetForTests()
  delete process.env.PLATFORM_REWARDS_ADDRESS
})

function mockMonero () {
  const hooks = []
  return {
    hooks,
    addWebhook: async (args) => { hooks.push(args); return { event_id: '555' } }
  }
}

describe('createOwnerFeeLeg', () => {
  it('mints a fee: pid, builds an integrated-address URI quoting the amount, registers the webhook, and records the pid map', async () => {
    const models = mockModels()
    const monero = mockMonero()
    const leg = await createOwnerFeeLeg(models, monero, {
      ownerAccount: { id: 9, address: PRIMARY, ownerUserId: 42 },
      subName: 'turf',
      amountPiconeros: 1_500_000_000n,
      description: 'test fee'
    })

    expect(leg.paymentId).toMatch(/^[0-9a-f]{16}$/)
    // URI carries the INTEGRATED address and the full amount
    const addr = moneroUriAddress(leg.moneroUri)
    expect(addr).not.toBe(PRIMARY)
    expect(addr.length).toBeGreaterThan(PRIMARY.length)
    expect(moneroUriAmountPiconeros(leg.moneroUri)).toBe(1_500_000_000n)
    // webhook registered against the OWNER primary + pid with the 10-conf ceiling
    expect(monero.hooks[0]).toMatchObject({
      type: 'tx-confirmation', address: PRIMARY, paymentId: leg.paymentId, confirmations: 10
    })
    // pid map row denormalizes attribution + webhook id + 7d expiry
    expect(models.created[0]).toMatchObject({
      paymentId: leg.paymentId,
      subName: 'turf',
      ownerUserId: 42,
      amountPiconeros: 1_500_000_000n,
      webhookEventId: '555',
      // new owner intents freeze the receiving wallet too
      recipientAccountId: 9,
      recipientAddress: PRIMARY,
      feeType: null
    })
    expect(models.created[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000)
    // integrated address embeds exactly our pid
    expect(leg.integratedAddress).toBeTruthy()
  })

  it('mints distinct payment ids per leg', async () => {
    const models = mockModels()
    const monero = mockMonero()
    const a = await createOwnerFeeLeg(models, monero, { ownerAccount: { address: PRIMARY, ownerUserId: 1 }, subName: 'a', amountPiconeros: 1n, description: 'x' })
    const b = await createOwnerFeeLeg(models, monero, { ownerAccount: { address: PRIMARY, ownerUserId: 1 }, subName: 'a', amountPiconeros: 1n, description: 'x' })
    expect(a.paymentId).not.toBe(b.paymentId)
  })
})

describe('createPlatformFeeLeg', () => {
  const now = new Date('2026-10-24T00:00:00Z')

  it('freezes the platform recipient and the full quote on a classified intent', async () => {
    const models = mockModels()
    const monero = mockMonero()
    const leg = await createPlatformFeeLeg(models, monero, {
      me: { id: 7 }, feeType: 'TERRITORY_BILLING', amountPiconeros: 2_000_000_000n, description: 'renewal', subName: 'turf', now
    })
    // a 106-char integrated destination; the pid rides inside it, not as a URI param
    expect(moneroUriAddress(leg.moneroUri)).toHaveLength(106)
    expect(leg.moneroUri).not.toContain('tx_payment_id')
    expect(moneroUriAmountPiconeros(leg.moneroUri)).toBe(2_000_000_000n)
    expect(monero.hooks[0]).toMatchObject({ address: PLATFORM, paymentId: leg.paymentId })
    expect(models.created[0]).toEqual(expect.objectContaining({
      paymentId: leg.paymentId,
      feeType: 'TERRITORY_BILLING',
      ownerUserId: null,
      subName: 'turf',
      postId: null,
      amountPiconeros: 2_000_000_000n,
      recipientAccountId: 91,
      recipientAddress: PLATFORM,
      webhookEventId: '555',
      expiresAt: new Date(now.getTime() + FEE_PID_TTL_MS)
    }))
  })

  it.each([
    ['no registered account', null],
    ['an INACTIVE account', { id: 91, address: PLATFORM, status: 'INACTIVE' }]
  ])('refuses issuance with %s — no webhook, no intent', async (_, rewardsAccount) => {
    const models = mockModels({ rewardsAccount })
    const monero = mockMonero()
    await expect(createPlatformFeeLeg(models, monero, { me: { id: 7 }, feeType: 'POSTING', amountPiconeros: 1n, description: 'x' })).rejects.toThrow(/platform_rewards/)
    expect(monero.hooks).toHaveLength(0)
    expect(models.created).toHaveLength(0)
  })

  it('refuses a registered account that is not the configured rewards primary', async () => {
    process.env.PLATFORM_REWARDS_ADDRESS = PRIMARY
    const models = mockModels()
    const monero = mockMonero()
    await expect(createPlatformFeeLeg(models, monero, { me: { id: 7 }, feeType: 'POSTING', amountPiconeros: 1n, description: 'x' })).rejects.toThrow(/PLATFORM_REWARDS_ADDRESS/)
    expect(monero.hooks).toHaveLength(0)
  })

  it('exposes no invoice when the webhook or the intent write fails', async () => {
    const failingHook = { addWebhook: async () => { throw new Error('lws down') } }
    const models = mockModels()
    await expect(createPlatformFeeLeg(models, failingHook, { me: { id: 7 }, feeType: 'POSTING', amountPiconeros: 1n, description: 'x' })).rejects.toThrow('lws down')
    expect(models.created).toHaveLength(0)
    const brokenMap = { ...mockModels(), subFeePidMap: { create: async () => { throw new Error('db down') } } }
    await expect(createPlatformFeeLeg(brokenMap, mockMonero(), { me: { id: 7 }, feeType: 'POSTING', amountPiconeros: 1n, description: 'x' })).rejects.toThrow('db down')
  })

  it('shares the per-user fee-issuance throttle with the subaddress pool, before any side effect', async () => {
    const models = mockModels()
    const monero = mockMonero()
    const args = { me: { id: 7 }, feeType: 'POSTING', amountPiconeros: 1n, description: 'x' }
    for (let i = 0; i < FEE_RESERVE_ATTEMPTS_PER_USER; i++) await createPlatformFeeLeg(models, monero, args)
    await expect(createPlatformFeeLeg(models, monero, args)).rejects.toThrow(/too many fee reservations/)
    // owner legs draw from the same budget
    await expect(createOwnerFeeLeg(models, monero, { me: { id: 7 }, ownerAccount: { id: 9, address: PRIMARY, ownerUserId: 42 }, subName: 't', amountPiconeros: 1n, description: 'x' })).rejects.toThrow(/too many fee reservations/)
    expect(monero.hooks).toHaveLength(FEE_RESERVE_ATTEMPTS_PER_USER)
    expect(models.created).toHaveLength(FEE_RESERVE_ATTEMPTS_PER_USER)
  })

  it('is the only caller of resolvePlatformFeeRecipient (one place picks the receiving wallet)', () => {
    const hits = execSync("grep -rln 'resolvePlatformFeeRecipient' api worker pages lib", { encoding: 'utf8' })
      .trim().split('\n').sort()
    expect(hits).toEqual(['api/monero/feePool.js', 'api/monero/ownerFeeLeg.js'])
  })
})

describe('resolveFeeAccount', () => {
  const account = { id: 91, address: PLATFORM, status: 'ACTIVE', viewKey: {}, subaddresses: [] }
  const models = (row) => ({
    moneroAccount: {
      findUnique: jest.fn(async () => row),
      findFirst: jest.fn(async () => ({ id: 5, ownerUserId: 42 }))
    }
  })

  it('verifies against the FROZEN recipient, never a re-resolved wallet', async () => {
    const m = models(account)
    expect(await resolveFeeAccount(m, { recipientAccountId: 91, recipientAddress: PLATFORM, ownerUserId: 42 })).toBe(account)
    expect(m.moneroAccount.findFirst).not.toHaveBeenCalled()
  })

  it('defers (null) when the frozen account no longer matches its address snapshot', async () => {
    expect(await resolveFeeAccount(models({ ...account, address: PRIMARY }), { recipientAccountId: 91, recipientAddress: PLATFORM })).toBeNull()
    expect(await resolveFeeAccount(models(null), { recipientAccountId: 91, recipientAddress: PLATFORM })).toBeNull()
  })

  it('keeps the legacy owner-account resolution for historical owner intents only', async () => {
    const m = models(account)
    expect(await resolveFeeAccount(m, { recipientAccountId: null, recipientAddress: null, ownerUserId: 42 })).toEqual({ id: 5, ownerUserId: 42 })
    expect(m.moneroAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerUserId: 42, status: 'ACTIVE' } }))
  })
})
