/* eslint-env jest */

// Real-DB end-to-end tests for the quest-system quotas (spec
// 2026-09-23-daily-quests, rev 3): getInitial must treat the flat one-tier
// quotas and banked/expired StreakReward POST/REPLY rows exactly as the quota
// helpers compute them.

import { PrismaClient } from '@prisma/client'
import { getInitial } from '@/api/payIn/types/itemCreate'
import { moneroUriAmountPiconeros } from '@/lib/format'

// Fee legs register an lws webhook at issuance; never reach the real lws.
jest.mock('../../api/monero/lwsClient', () => ({
  __esModule: true, lwsClient: { addWebhook: jest.fn(async () => ({ event_id: 'test-fee-hook' })) }
}))

jest.mock('../../lib/lexical/server/mentions', () => ({
  __esModule: true,
  extractMentions: () => ({ userNames: [], itemIds: [] })
}))
jest.mock('../../api/resolvers/item', () => ({ __esModule: true, getItem: jest.fn() }))
jest.mock('../../api/monero/feePool', () => ({
  __esModule: true,
  throttleFeeIssuance: jest.fn(),
  resolvePlatformFeeRecipient: jest.fn(models => require('../../test/helpers/platformFeeRecipient').testPlatformFeeRecipient(models)),
  reserveFeeSubaddress: jest.fn(async () => ({ id: 1, major: 1, minor: 1, address: 'A'.repeat(95) }))
}))

const prisma = new PrismaClient()
const DAY = 86_400_000
const created = { users: [], items: [], accounts: [] }

async function createUser () {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  return row.id
}

async function seedReward (userId, { type = 'POST', expiresAt }) {
  return prisma.streakReward.create({
    data: { userId, type, expiresAt, grantedAt: new Date(Date.now() - DAY) }
  })
}

afterAll(async () => {
  for (const id of created.items) {
    await prisma.itemUserAgg.deleteMany({ where: { itemId: id } })
    await prisma.item.deleteMany({ where: { id } })
  }
  for (const id of created.accounts) await prisma.moneroAccount.deleteMany({ where: { id } })
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } })
  await prisma.$disconnect()
})

async function ensureFeeConfig () {
  if (!await prisma.platformFeeConfig.findUnique({ where: { id: 1 } })) {
    await prisma.platformFeeConfig.create({ data: { id: 1 } })
  }
}

test('a banked REPLY credit keeps a comment free past the used base', async () => {
  await ensureFeeConfig()
  const userId = await createUser()
  // the flat daily base is 1 and already used today
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1 WHERE id = ${userId}::int`
  await seedReward(userId, { type: 'REPLY', expiresAt: new Date(Date.now() + 20 * DAY) })
  const result = await getInitial(prisma, { parentId: '999999' }, { me: { id: userId } })
  expect(result).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })
})

test('the flame streak alone no longer extends the reply quota (banking replaces it)', async () => {
  const userId = await createUser()
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1, streak = 3 WHERE id = ${userId}::int`
  const result = await getInitial(prisma, { parentId: '999999' }, { me: { id: userId } })
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(600_000_000n)
})

test('with the base used and no banked credits, the comment fee returns', async () => {
  const userId = await createUser()
  await prisma.$executeRaw`UPDATE users SET "freeCommentCount" = 1 WHERE id = ${userId}::int`
  const result = await getInitial(prisma, { parentId: '999999' }, { me: { id: userId } })
  expect(result.moneroUri).toMatch(/^monero:/)
  expect(moneroUriAmountPiconeros(result.moneroUri)).toBe(600_000_000n)
})

test('a banked POST reward keeps a post free past the exhausted monthly base; an expired one does not', async () => {
  const userId = await createUser()
  await prisma.$executeRaw`
    UPDATE users SET "stackedPiconeros" = 10000000000, "created_at" = now() - interval '8 days', "freePostCount" = 1
    WHERE id = ${userId}::int`
  await seedReward(userId, { expiresAt: new Date(Date.now() + 20 * DAY) })
  const free = await getInitial(prisma, {}, { me: { id: userId } })
  expect(free).toEqual({ payInType: 'ITEM_CREATE', userId, piconeros: 0n })

  const other = await createUser()
  await prisma.$executeRaw`
    UPDATE users SET "stackedPiconeros" = 10000000000, "created_at" = now() - interval '8 days', "freePostCount" = 1
    WHERE id = ${other}::int`
  await seedReward(other, { expiresAt: new Date(Date.now() - DAY) }) // already expired
  const paid = await getInitial(prisma, {}, { me: { id: other } })
  expect(paid.moneroUri).toMatch(/^monero:/)
  expect(paid.moneroUri).toContain('tx_amount=0.001')
})
