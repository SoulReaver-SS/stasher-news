/* eslint-env jest */

// StasherNews: turf descriptions cannot carry >10MB media — there is no
// upload-fee path for turfs, so every desc-bearing territory getInitial rejects
// oversized uploads before any fee subaddress is drawn. Real-DB integration
// test (Upload/Sub rows), mirrors test/engine/payInItemUpdate.test.js:
//   docker exec -u apprunner app npx jest test/engine/payInTerritoryUploadCap.test.js

import { PrismaClient } from '@prisma/client'
import { getInitial as getUpdateInitial } from '@/api/payIn/types/territoryUpdate'
import { getInitial as getUnarchiveInitial } from '@/api/payIn/types/territoryUnarchive'
import { getInitial as getCreateInitial } from '@/api/payIn/types/territoryCreate'

// Fee legs register an lws webhook at issuance; never reach the real lws.
jest.mock('../../api/monero/lwsClient', () => ({
  __esModule: true, lwsClient: { addWebhook: jest.fn(async () => ({ event_id: 'test-fee-hook' })) }
}))

// The cap must reject BEFORE any draw; a call here is a bug.
jest.mock('../../api/monero/feePool', () => ({
  __esModule: true,
  throttleFeeIssuance: jest.fn(),
  resolvePlatformFeeRecipient: jest.fn(models => require('../../test/helpers/platformFeeRecipient').testPlatformFeeRecipient(models)),
  reserveFeeSubaddress: jest.fn(async () => {
    throw new Error('reserveFeeSubaddress must not be called for oversized uploads')
  })
}))

const prisma = new PrismaClient()
const created = { users: [], uploads: [], subs: [] }

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(rows[0].id)
  return rows[0].id
}

async function createUpload (userId, { size }) {
  const upload = await prisma.upload.create({ data: { userId, size, type: 'image/png' } })
  created.uploads.push(upload.id)
  return upload.id
}

async function createSub (userId) {
  const name = '_terrcap_' + Date.now() + '_' + Math.floor(Math.random() * 1000)
  const sub = await prisma.sub.create({
    data: { name, userId, rankingType: 'WOT', billingCost: 0, billingType: 'MONTHLY' }
  })
  created.subs.push(name)
  return sub
}

afterAll(async () => {
  await prisma.upload.deleteMany({ where: { id: { in: created.uploads } } }).catch(() => {})
  for (const name of created.subs) await prisma.sub.deleteMany({ where: { name } }).catch(() => {})
  for (const id of created.users) await prisma.user.deleteMany({ where: { id } }).catch(() => {})
  await prisma.$disconnect()
})

test('territory update rejects an upload over 10MB', async () => {
  const userId = await createUser()
  const sub = await createSub(userId)
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })

  await expect(
    getUpdateInitial(prisma, { oldName: sub.name, billingType: 'MONTHLY', uploadIds: [uploadId] }, { me: { id: userId } })
  ).rejects.toThrow(/over 10 megabytes/)
})

test('territory update allows a ≤10MB upload and quotes no upload fee', async () => {
  const userId = await createUser()
  const sub = await createSub(userId)
  const uploadId = await createUpload(userId, { size: 5 * 1024 * 1024 })

  const result = await getUpdateInitial(
    prisma,
    { oldName: sub.name, billingType: 'MONTHLY', uploadIds: [uploadId] },
    { me: { id: userId } }
  )
  expect(result.piconeros).toBe(0n)
  expect(result.moneroUri).toBeUndefined()
  expect(result.beneficiaries).toBeUndefined()
})

test('territory unarchive rejects an upload over 10MB', async () => {
  const userId = await createUser()
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })

  await expect(
    getUnarchiveInitial(prisma, { billingType: 'MONTHLY', uploadIds: [uploadId] }, { me: { id: userId } })
  ).rejects.toThrow(/over 10 megabytes/)
})

test('territory create rejects an upload over 10MB', async () => {
  const userId = await createUser()
  const uploadId = await createUpload(userId, { size: 11 * 1024 * 1024 })

  await expect(
    getCreateInitial(prisma, { billingType: 'MONTHLY', name: 'irrelevant', uploadIds: [uploadId] }, { me: { id: userId } })
  ).rejects.toThrow(/over 10 megabytes/)
})

test('a non-existent upload id is rejected with the expired error on all three paths', async () => {
  const userId = await createUser()
  const sub = await createSub(userId)
  const expiredId = 999999999

  await expect(
    getUpdateInitial(prisma, { oldName: sub.name, billingType: 'MONTHLY', uploadIds: [expiredId] }, { me: { id: userId } })
  ).rejects.toThrow(/expired, consider reuploading/)

  await expect(
    getUnarchiveInitial(prisma, { billingType: 'MONTHLY', uploadIds: [expiredId] }, { me: { id: userId } })
  ).rejects.toThrow(/expired, consider reuploading/)

  await expect(
    getCreateInitial(prisma, { billingType: 'MONTHLY', name: 'irrelevant', uploadIds: [expiredId] }, { me: { id: userId } })
  ).rejects.toThrow(/expired, consider reuploading/)
})
