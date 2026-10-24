/* eslint-env jest */

// ITEM_CREATE owner-direct fee routing (Task 6, turf-owner-revenue):
// mock-based unit tests of getInitial's fee branches against the routing
// decision — single non-owned turf + owner wallet + no uploads + env gate
// routes the fee owner-direct via a fee: payment-ID leg; everything else
// keeps the platform rewards-wallet subaddress flow.
//
// The jest.mock preamble mirrors test/engine/payInItemCreate.test.js:37-68
// (mentions ESM stub, item-resolver weight stub, feePool DB stub). Relative
// paths are required in jest.mock because next/jest registers no `@/*`
// moduleNameMapper — see the engine test's preamble comment for details.
// babel-jest hoists these jest.mock calls above the ES imports below, so the
// stubs register before itemCreate.js is evaluated.

import { getInitial } from '@/api/payIn/types/itemCreate'
import { reserveFeeSubaddress } from '@/api/monero/feePool'
import { moneroUriAmountPiconeros } from '@/lib/format'

jest.mock('../../../lib/lexical/server/mentions', () => ({
  __esModule: true, extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../../api/resolvers/item', () => ({ __esModule: true, getItem: jest.fn() }))
// subaddress pool stub. NOTE: the address must be a VALID 95-char base58
// primary — the platform branch builds a monero: URI and buildMoneroUri
// validates the charset — so reuse the stagenet primary from
// payInItemCreate.test.js instead of a placeholder string.
jest.mock('../../../api/monero/feePool', () => ({
  __esModule: true,
  reserveFeeSubaddress: jest.fn(),
  throttleFeeIssuance: jest.fn(),
  // the platform recipient (test-only address, distinct from the owner's)
  resolvePlatformFeeRecipient: jest.fn(async () => ({
    id: 91,
    status: 'ACTIVE',
    address: '53fNxyrnpzq9b7oZQt3SHsGJgyLLXEJGDP2G979eNKNdVjqJPC8xg6hcTNGgFKocCVj1EmSNAyrBf6uHjeeDNhPb9YHQX88'
  }))
}))
// lwsClient stub so createOwnerFeeLeg registers no real webhook.
jest.mock('../../../api/monero/lwsClient', () => ({
  __esModule: true, lwsClient: { addWebhook: jest.fn(async () => ({ event_id: 1 })) }
}))

// stagenet primary (payInItemCreate.test.js / ownerFeeLeg.test.js): valid
// base58+checksum, so makeIntegratedAddress can derive an integrated address.
const PRIMARY = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'

const config = { postingFeeFloorPiconeros: 1_000_000_000n, commentFeePiconeros: 600_000_000n, maxTurfPremiumPiconeros: 10_000_000_000n, freePostThresholdPiconeros: 10_000_000_000n, freePostMinAgeDays: 7, minTipPiconeros: 100_000_000n }

// 'turf' is owned by userId 42 (with optional premiums); 'other' is owned by
// userId 99 with no premiums (the cross-post test's second turf).
function models ({ subOwnerHasWallet = true, premium = {}, parentSubs = null, homeSubRows = null, commenter = null } = {}) {
  const mapCreated = []
  const subRow = name => ({
    name,
    userId: name === 'other' ? 99 : 42,
    postPremiumPiconeros: name === 'turf' ? (premium.post ?? 0n) : 0n,
    commentPremiumPiconeros: name === 'turf' ? (premium.comment ?? 0n) : 0n
  })
  return {
    mapCreated,
    platformFeeConfig: { findUnique: async () => config },
    // $queryRaw serves the three raw shapes itemCreate issues: getSubs' parent
    // thread lookup (Sub rows), getRootPrimarySub's home-turf lookup (the
    // primarySubName COALESCE), and escalatedFeePiconeros' item_spam count.
    $queryRaw: async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join('') : String(strings)
      if (sql.includes('item_spam')) return [{ n: 0 }]
      if (sql.includes('primarySubName')) return homeSubRows ?? []
      return parentSubs ?? []
    },
    sub: {
      // getSubs for posts (subNames path); the quest draw resolver calls
      // findMany without a where (turf list) — return no turfs for that shape.
      findMany: async ({ where } = {}) => where?.name?.in ? where.name.in.map(subRow) : [],
      // resolveOwnerFeeRouteForSub
      findUnique: async ({ where }) => subRow(where.name)
    },
    moneroAccount: {
      findFirst: async ({ where }) => subOwnerHasWallet && where.ownerUserId === 42
        ? { id: 9, ownerUserId: 42, address: PRIMARY }
        : null
    },
    subFeePidMap: { create: async ({ data }) => { mapCreated.push(data); return data } },
    // low-rep author by default: never established, past their 1-post free quota
    // (so post-branch tests exercise fee ROUTING, not the free-post path)
    user: {
      findUnique: async () => commenter ?? ({
        id: 7,
        freeCommentCount: 0,
        freePostCount: 1,
        freeCommentResetAt: new Date(Date.now() + 86_400_000),
        stackedPiconeros: 0n,
        createdAt: new Date()
      })
    }
  }
}

// The fee took the PLATFORM leg: an integrated POSTING invoice frozen to the
// rewards recipient — no subaddress draw, no owner attribution.
function expectPlatformLeg (r, m) {
  expect(r.moneroPaymentId).toMatch(/^[0-9a-f]{16}$/)
  expect(r.moneroSubaddressMajor).toBeUndefined()
  expect(reserveFeeSubaddress).not.toHaveBeenCalled()
  expect(m.mapCreated[0]).toMatchObject({ feeType: 'POSTING', recipientAccountId: 91, ownerUserId: null, subName: null })
}

const subArgs = { subNames: ['turf'], parentId: null }
const lowRepMe = { id: 7 } // never the owner (42) of any mocked turf

beforeEach(() => {
  process.env.TURF_OWNER_FEES = '1'
  jest.clearAllMocks()
})
afterEach(() => { delete process.env.TURF_OWNER_FEES })

describe('ITEM_CREATE getInitial routing', () => {
  it('routes a single-turf post fee owner-direct (pid set, no subaddress)', async () => {
    const m = models({ premium: { post: 500_000_000n } })
    const r = await getInitial(m, { ...subArgs, title: 'x' }, { me: lowRepMe })
    expect(r.moneroPaymentId).toMatch(/^[0-9a-f]{16}$/)
    expect(r.moneroSubaddressMajor).toBeUndefined()
    expect(reserveFeeSubaddress).not.toHaveBeenCalled()
    // quoted amount includes floor + premium
    expect(r.moneroUri).toContain('tx_amount=0.0015')
    // the pid map row attributes the leg to the turf owner for the full amount
    expect(m.mapCreated[0]).toMatchObject({ subName: 'turf', ownerUserId: 42, amountPiconeros: 1_500_000_000n })
  })

  it('falls back to the platform leg when the owner has no wallet', async () => {
    const m = models({ subOwnerHasWallet: false })
    const r = await getInitial(m, { ...subArgs, title: 'x' }, { me: lowRepMe })
    expectPlatformLeg(r, m)
  })

  it('wallet-less owner falls back to the rewards-wallet leg charging FLOOR ONLY (no premium)', async () => {
    const m = models({ subOwnerHasWallet: false, premium: { post: 2_000_000_000n } })
    const r = await getInitial(m, { ...subArgs, title: 'x' }, { me: lowRepMe })
    expectPlatformLeg(r, m)
    // uri quotes floor only — the 0.002 premium is NOT charged when it would
    // land in the platform wallet
    expect(r.moneroUri).toContain('tx_amount=0.001')
    expect(r.moneroUri).not.toContain('0.003')
  })

  it('cross-posts (2 turfs) always route to the platform charging floors only (no premium)', async () => {
    const m = models({ premium: { post: 500_000_000n } })
    // second turf owned by someone else without premium: models.sub rows give
    // 'turf' the configured premium and 'other' none — neither premium may be
    // charged on the platform fallback leg
    const r = await getInitial(m, { subNames: ['turf', 'other'], title: 'x' }, { me: lowRepMe })
    expectPlatformLeg(r, m)
    // 2 floors, no premium — premiums never route to the platform wallet
    expect(r.moneroUri).toContain('tx_amount=0.002')
    expect(r.moneroUri).not.toContain('0.0025')
  })

  it('gate off keeps today’s platform routing', async () => {
    delete process.env.TURF_OWNER_FEES
    const m = models()
    const r = await getInitial(m, { ...subArgs, title: 'x' }, { me: lowRepMe })
    expectPlatformLeg(r, m)
  })

  it('comments route owner-direct with floor + comment premium', async () => {
    const m = models({
      premium: { comment: 200_000_000n },
      parentSubs: [{ name: 'turf', userId: 42, postPremiumPiconeros: 0n, commentPremiumPiconeros: 200_000_000n }]
    })
    // freebies exhausted: user row with exhausted counters
    m.user = { findUnique: async () => ({ id: 7, freeCommentCount: 99, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 0n, createdAt: new Date() }) }
    const r = await getInitial(m, { parentId: '123', subNames: null }, { me: lowRepMe })
    expect(r.moneroPaymentId).toMatch(/^[0-9a-f]{16}$/)
    expect(reserveFeeSubaddress).not.toHaveBeenCalled()
    expect(moneroUriAmountPiconeros(r.moneroUri)).toBe(800_000_000n)
  })

  it('comments fall back to the platform leg charging FLOOR ONLY (no premium)', async () => {
    const m = models({
      subOwnerHasWallet: false,
      premium: { comment: 200_000_000n },
      parentSubs: [{ name: 'turf', userId: 42, postPremiumPiconeros: 0n, commentPremiumPiconeros: 200_000_000n }]
    })
    m.user = { findUnique: async () => ({ id: 7, freeCommentCount: 99, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 0n, createdAt: new Date() }) }
    const r = await getInitial(m, { parentId: '123', subNames: null }, { me: lowRepMe })
    expectPlatformLeg(r, m)
    expect(moneroUriAmountPiconeros(r.moneroUri)).toBe(600_000_000n)
    expect(r.moneroUri).not.toContain('0.0008')
  })
})

describe('ITEM_CREATE getInitial — comment routing on the home turf', () => {
  const homeRow = (premium = 0n) => [{ name: 'turf', userId: 42, postPremiumPiconeros: 0n, commentPremiumPiconeros: premium }]
  const spentCommenter = { id: 7, freeCommentCount: 99, freePostCount: 99, freeCommentResetAt: new Date(Date.now() + 86_400_000), stackedPiconeros: 0n, createdAt: new Date() }

  it('routes a comment fee to the home turf owner even when the root is reposted', async () => {
    const m = models({
      premium: { comment: 200_000_000n },
      homeSubRows: homeRow(200_000_000n),
      parentSubs: [{ name: 'turf', userId: 42 }, { name: 'other', userId: 99 }],
      commenter: spentCommenter
    })
    const r = await getInitial(m, { parentId: '5' }, { me: lowRepMe })
    expect(r.moneroPaymentId).toMatch(/^[0-9a-f]{16}$/)
    expect(r.moneroSubaddressMajor).toBeUndefined()
    expect(r.moneroUri).toContain('tx_amount=0.0008') // 0.0006 floor + 0.0002 comment premium
  })

  it('keeps the legacy all-root-turfs fallback for a grandfathered root (no home turf)', async () => {
    const m = models({
      homeSubRows: [],
      parentSubs: [{ name: 'turf', userId: 42, postPremiumPiconeros: 0n, commentPremiumPiconeros: 500_000_000n }, { name: 'other', userId: 99 }],
      commenter: spentCommenter
    })
    const r = await getInitial(m, { parentId: '5' }, { me: lowRepMe })
    expectPlatformLeg(r, m)
    expect(r.moneroUri).toContain('tx_amount=0.0006') // flat floor, NO premium
  })
})
