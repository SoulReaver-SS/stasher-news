/* eslint-env jest */

// Engine-level regression for the StasherNews payIn engine (Tasks 1-4).
//
// TERRITORY_CREATE is an piconeros:0 fee payIn: getInitial builds a rewards-wallet
// fee URI (no custodial sats), begin() -> payInCreate() yields payInState=PAID,
// then onBegin() creates the territory Sub (billingStatus=PENDING_FEE) and
// onPaid() runs the ghost-free streak/module path. This test drives the full
// `pay('TERRITORY_CREATE', ...)` cycle end-to-end against a real migrated
// database and asserts it reaches PAID without touching the stripped custodial /
// bolt11 / pessimistic relations.
//
// Mirrors the real-DB integration style of test/worker/rewardsDistributor.test.js
// (live database, FK-safe teardown tracked in a `created` object). Run via:
//   docker exec -u apprunner app npx jest test/engine/payInTerritoryCreate.test.js

import { expectPlatformFeeLeg } from '../../test/helpers/platformFeeRecipient'
import { PrismaClient } from '@prisma/client'
import pay from '@/api/payIn/index'
import { sweepFakeRewardsWallets } from '../helpers/sweepRewardsWallets'

// Integrated platform fee legs: a real test recipient row (FK), throttle and
// subaddress pool untouched.
jest.mock('../../api/monero/feePool', () => ({
  __esModule: true,
  ...jest.requireActual('../../api/monero/feePool'),
  resolvePlatformFeeRecipient: jest.fn(models => require('../../test/helpers/platformFeeRecipient').testPlatformFeeRecipient(models))
}))
// Fee legs register an lws webhook at issuance; never reach the real lws.
jest.mock('../../api/monero/lwsClient', () => ({
  __esModule: true, lwsClient: { addWebhook: jest.fn(async () => ({ event_id: 'test-fee-hook' })) }
}))

// `pay()` and `./lib/is` both import the `api/payIn/types` barrel, which pulls
// `itemCreate`/`itemUpdate` -> `lib/lexical/server/mentions` -> the ESM-only
// `mdast-util-from-markdown`. next/jest does not transform that node_modules
// ESM, so the barrel is mocked to expose ONLY the real TERRITORY_CREATE module
// (which has no ESM-only dependencies). The path is relative because next/jest
// registers no `@/*` moduleNameMapper, so jest.mock — unlike import — cannot
// resolve the `@/` alias. `jest.requireActual` loads the real module through the
// same babel transform, so named exports (getInitial/onBegin/...) are preserved.
jest.mock('../../api/payIn/types', () => {
  const territoryCreate = jest.requireActual('../../api/payIn/types/territoryCreate')
  return { __esModule: true, default: { TERRITORY_CREATE: territoryCreate } }
})

const prisma = new PrismaClient()

// Active Monero network — must match getRewardsWalletId's lookup (feePool.js) so
// the platform_rewards account we seed/reset is the one the engine queries.
const NETWORK = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()

// 95-char-looking Monero address placeholder, made unique per call via a counter.
let addrSeq = 0
function makeAddress () {
  addrSeq += 1
  const seq = String(addrSeq).replace(/0/g, '1')
  return '5' + seq.padStart(4, '1') + 'A'.repeat(90)
}

// FK-safe teardown tracking. The pay() flow creates a PayIn and a Sub (the Sub
// cascades SubPayIn / SubSubscription / UserSubTrust) and flips one SubaddressIndex
// to ASSIGNED. reserveFeeSubaddress runs as an autocommit (outside begin()'s
// transaction), so the draw is NOT rolled back if pay() throws later — therefore
// teardown detects the drawn row by diffing the ASSIGNED set before/after the call
// (robust to a pay() failure, e.g. if a future change regresses the engine).
const created = {
  user: null,
  payInId: null,
  subName: null,
  rewardsAccountId: null,
  rewardsAccountCreated: false,
  seededSubaddressId: null,
  assignedBeforeIds: [],
  drawnMajor: null,
  drawnMinor: null
}

let result

beforeAll(async () => {
  // sweep our deterministic leaked placeholder (makeAddress seq 1 — the only
  // seq that ever becomes an account row) from crashed prior runs
  await sweepFakeRewardsWallets(['5' + '1111' + 'A'.repeat(90)])
  // 1. Test user (unique name so re-runs never collide on users.name_unique).
  const user = await prisma.user.create({ data: { name: 'payInEngineUser' + Date.now() } })
  created.user = user.id

  // 2. PlatformFeeConfig singleton — territoryFeePiconeros reads it in getInitial.
  //    Idempotent upsert (all columns have schema defaults); left in place, like
  //    rewardsDistributor.test.js does.
  await prisma.platformFeeConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })

  // 3. platform_rewards wallet for the active network (getRewardsWalletId lookup).
  //    The dev env already has this (seeded with the monero profile); find-or-create
  //    so the test also works against a fresh DB, and only tear down what we created.
  //    orderBy id asc mirrors getRewardsWalletId's resolution — a bare findFirst
  //    can land on a residue platform_rewards row (e.g. an interrupted
  //    boost.test.js run leaks a higher-id one) that the engine never draws
  //    from, and the drawn-coords assertions below query the wrong account.
  let account = await prisma.moneroAccount.findFirst({
    where: { label: 'platform_rewards', network: NETWORK },
    orderBy: { id: 'asc' }
  })
  if (!account) {
    account = await prisma.moneroAccount.create({
      data: { address: makeAddress(), label: 'platform_rewards', network: NETWORK, status: 'ACTIVE' }
    })
    created.rewardsAccountCreated = true
  }
  created.rewardsAccountId = account.id

  // 4. Guarantee at least one AVAILABLE major-2 (territory) subaddress for
  //    reserveFeeSubaddress to draw. Purely additive and tracked — safe even when
  //    the shared dev pool already has rows; ensures the test isn't flaky if the
  //    pool happens to be exhausted by other runs.
  const seeded = await prisma.subaddressIndex.create({
    data: {
      accountId: created.rewardsAccountId,
      majorIndex: 2,
      minorIndex: 1_000_000 + (Date.now() % 1_000_000) + Math.floor(Math.random() * 100),
      address: makeAddress(),
      state: 'AVAILABLE'
    }
  })
  created.seededSubaddressId = seeded.id

  // Snapshot the major-2 subaddresses already ASSIGNED before the call, so teardown
  // can detect exactly which row reserveFeeSubaddress drew (it autocommits outside
  // begin()'s tx) and reset only that one — robust even if pay() throws afterwards.
  const assignedBefore = await prisma.subaddressIndex.findMany({
    where: { accountId: created.rewardsAccountId, majorIndex: 2, state: 'ASSIGNED' },
    select: { id: true }
  })
  created.assignedBeforeIds = assignedBefore.map(r => r.id)

  // 5. Drive the full engine: getInitial -> begin -> payInCreate (mcost0 -> PAID)
  //    -> onBegin (creates Sub PENDING_FEE) -> onPaid (ghost-free streak queue).
  result = await pay(
    'TERRITORY_CREATE',
    { billingType: 'MONTHLY', name: 'payInEngineTerritory' + Date.now() },
    { me: { id: created.user } }
  )

  // Capture created rows + the drawn subaddress coords (used by the assertions).
  created.payInId = result.id
  created.subName = result.result?.name
  created.drawnMajor = result.moneroSubaddressMajor
  created.drawnMinor = result.moneroSubaddressMinor
})

afterAll(async () => {
  // FK-safe teardown (children before parents). Sub.billingPayInId -> PayIn is a
  // restrict FK, so the Sub must be deleted before the PayIn; deleting the Sub
  // cascades its SubPayIn / SubSubscription / UserSubTrust. The drawn
  // SubaddressIndex is detected by diffing the ASSIGNED set against the pre-call
  // snapshot and reset to AVAILABLE, so the test leaves the shared pool exactly as
  // it found it — even if pay() threw before the result was captured.
  if (created.subName) {
    await prisma.sub.deleteMany({ where: { name: created.subName } })
  }
  if (created.payInId) {
    await prisma.payIn.deleteMany({ where: { id: created.payInId } })
  }
  if (created.rewardsAccountId != null) {
    const drawn = await prisma.subaddressIndex.findMany({
      where: {
        accountId: created.rewardsAccountId,
        majorIndex: 2,
        state: 'ASSIGNED',
        id: { notIn: created.assignedBeforeIds }
      },
      select: { id: true }
    })
    if (drawn.length > 0) {
      await prisma.subaddressIndex.updateMany({
        where: { id: { in: drawn.map(r => r.id) } },
        data: { state: 'AVAILABLE' }
      })
    }
  }
  if (created.seededSubaddressId) {
    await prisma.subaddressIndex.deleteMany({ where: { id: created.seededSubaddressId } })
  }
  await sweepFakeRewardsWallets(['5' + '1111' + 'A'.repeat(90)])
  if (created.rewardsAccountCreated) {
    await prisma.moneroAccount.deleteMany({ where: { id: created.rewardsAccountId } })
  }
  if (created.user) {
    await prisma.user.deleteMany({ where: { id: created.user } })
  }
  await prisma.$disconnect()
})

test('TERRITORY_CREATE completes with payInState PAID', () => {
  expect(result.payInState).toBe('PAID')
  expect(result.payInType).toBe('TERRITORY_CREATE')
})

test('the territory Sub was created with billingStatus PENDING_FEE and linked to the PayIn', async () => {
  expect(created.subName).toBeTruthy()
  const sub = await prisma.sub.findUnique({
    where: { name: created.subName },
    select: { billingStatus: true, billingPayInId: true, billingType: true }
  })
  expect(sub.billingStatus).toBe('PENDING_FEE')
  expect(sub.billingType).toBe('MONTHLY')
  expect(sub.billingPayInId).toBe(created.payInId)
})

test('no rewards-wallet fee subaddress is drawn for a new turf invoice', async () => {
  expect(created.drawnMajor ?? null).toBeNull()
  const assignedNow = await prisma.subaddressIndex.findMany({
    where: { accountId: created.rewardsAccountId, majorIndex: 2, state: 'ASSIGNED' },
    select: { id: true }
  })
  expect(assignedNow.map(r => r.id).sort()).toEqual([...created.assignedBeforeIds].sort())
})

test('the returned PayIn carries an integrated-address TERRITORY_CREATE invoice frozen to the platform recipient', async () => {
  expect(result.moneroUri).toMatch(/^monero:/)
  const feeMap = await expectPlatformFeeLeg(prisma, result, 'TERRITORY_CREATE')
  expect(feeMap.subName).toBe(created.subName)
})
