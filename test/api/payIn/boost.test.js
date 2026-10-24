/* eslint-env jest */
import { expectPlatformFeeLeg } from '../../../test/helpers/platformFeeRecipient'
import { PrismaClient } from '@prisma/client'
import pay from '@/api/payIn'

// Integrated platform fee legs: a real test recipient row (FK), throttle and
// subaddress pool untouched.
jest.mock('../../../api/monero/feePool', () => ({
  __esModule: true,
  ...jest.requireActual('../../../api/monero/feePool'),
  resolvePlatformFeeRecipient: jest.fn(models => require('../../../test/helpers/platformFeeRecipient').testPlatformFeeRecipient(models))
}))
// Fee legs register an lws webhook at issuance; never reach the real lws.
jest.mock('../../../api/monero/lwsClient', () => ({
  __esModule: true, lwsClient: { addWebhook: jest.fn(async () => ({ event_id: 'test-fee-hook' })) }
}))

// `pay` imports the full payIn type barrel, which pulls in itemCreate →
// @/lib/lexical/server/mentions (ESM-only mdast-util-from-markdown, not
// transformed by next/jest) and @/api/resolvers/item (heavy lexical/html
// chain). Neither is exercised by the BOOST flow, so both are stubbed — same
// technique as test/engine/pollVote.test.js. (babel-jest hoists these
// jest.mock calls above the imports at runtime. Paths are relative because
// jest.mock cannot resolve the @/ alias.)
jest.mock('../../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../../api/resolvers/item', () => ({
  __esModule: true,
  getItem: jest.fn()
}))

const prisma = new PrismaClient()
let user
let post
let reply
const created = { accounts: [], subaddrs: [] }

// The BOOST payIn reserves a major-5 subaddress from the platform_rewards
// wallet's SubaddressIndex pool — the test seeds both (the dev stack usually
// has them, but tests must not depend on that). getRewardsWalletId uses
// findFirst (no order), so a stale platform_rewards wallet from another suite
// could shadow the one seeded here — seed every STAGENET platform_rewards
// wallet so the pool draw always finds a major-5 subaddress.
async function seedRewardsWallet () {
  const [account] = await prisma.$queryRaw`
    INSERT INTO "MoneroAccount" ("address", label, network, status)
    VALUES ('5' || repeat('A', 94), 'platform_rewards', 'STAGENET'::"Network", 'ACTIVE'::"LwsAccountStatus")
    ON CONFLICT ("address", network) DO NOTHING
    RETURNING id::int AS id`
  if (account?.id) created.accounts.push(account.id)
  const accounts = await prisma.$queryRaw`
    SELECT id::int AS id FROM "MoneroAccount"
    WHERE label = 'platform_rewards' AND network = 'STAGENET'`
  for (const { id } of accounts) {
    // each pay('BOOST') draw reserves one subaddress (AVAILABLE -> ASSIGNED),
    // so seed a small pool per wallet (minor 1..5)
    for (const minor of [1, 2, 3, 4, 5]) {
      const [sub] = await prisma.$queryRaw`
        INSERT INTO "SubaddressIndex" ("accountId", "majorIndex", "minorIndex", address, state)
        VALUES (${id}::int, 5, ${minor}, '5' || repeat('B', 94), 'AVAILABLE'::"SubaddressState")
        ON CONFLICT ("accountId", "majorIndex", "minorIndex") DO NOTHING
        RETURNING id::int AS id`
      if (sub?.id) created.subaddrs.push(sub.id)
    }
  }
}

beforeAll(async () => {
  await seedRewardsWallet()
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  user = rows[0].id
  const items = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", title, "created_at")
    VALUES (${user}::int, 'boost test', now()) RETURNING id::int AS id`
  post = items[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${String(post)}::ltree WHERE id = ${post}::int`
  const replies = await prisma.$queryRaw`
    INSERT INTO "Item" ("userId", "parentId", title, "created_at")
    VALUES (${user}::int, ${post}::int, 'boost test reply', now()) RETURNING id::int AS id`
  reply = replies[0].id
  await prisma.$executeRaw`UPDATE "Item" SET path = ${`${post}.${reply}`}::ltree WHERE id = ${reply}::int`
})

afterAll(async () => {
  await prisma.item.deleteMany({ where: { id: { in: [post, reply] } } })
  await prisma.user.deleteMany({ where: { id: user } })
  await prisma.subaddressIndex.deleteMany({ where: { id: { in: created.subaddrs } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.$disconnect()
})

test('BOOST payIn returns an integrated-address platform invoice bound to the boosted item', async () => {
  const payIn = await pay('BOOST', { id: post, piconeros: 1_000_000_000n }, { me: { id: user } })
  expect(payIn.moneroUri).toMatch(/^monero:/)
  expect(payIn.payInType).toBe('BOOST')
  expect(payIn.piconeros).toBe(0n)
  const feeMap = await expectPlatformFeeLeg(prisma, payIn, 'BOOST')
  expect(feeMap.postId).toBe(post)
})

// regression: onBegin must read Item.path via getItemResult (raw SQL +
// ltree2text) — tx.item.findUnique silently drops the Unsupported("ltree")
// column, so the response's path was undefined -> null over GraphQL and the
// client's ancestor walk crashed on null.split('.') with "Cannot read
// properties of null (reading 'split')" in the boost modal.
test('the boost result carries the real ltree path so the client can walk ancestors', async () => {
  const rootPayIn = await pay('BOOST', { id: post, piconeros: 1_000_000_000n }, { me: { id: user } })
  expect(rootPayIn.result.path).toBe(String(post))

  const replyPayIn = await pay('BOOST', { id: reply, piconeros: 1_000_000_000n }, { me: { id: user } })
  expect(replyPayIn.result.path).toBe(`${post}.${reply}`)
})
