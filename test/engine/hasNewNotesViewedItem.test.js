/* eslint-env jest */

// Opening an item directly (push or chat notification, bookmark) never visits
// /notifications, so checkedNotesAt never moves and the bell stays lit for the
// item already on screen. hasNewNotes(viewedItemId) leaves the viewed item's
// subtree out of the item checks and, when nothing else is new, bumps
// checkedNotesAt so the bell clears. Runs the real resolver against the dev DB:
//   docker exec -u apprunner app npx jest test/engine/hasNewNotesViewedItem.test.js

import { PrismaClient } from '@prisma/client'
import userResolvers from '@/api/resolvers/user'

jest.mock('../../components/editor', () => ({ __esModule: true, SNEditor: 'textarea' }))
jest.mock('../../api/payIn', () => ({ __esModule: true, default: {} }))
jest.mock('../../lib/lexical/server/html', () => ({ __esModule: true, lexicalHTMLGenerator: async () => '' }))

const { Query: { hasNewNotes } } = userResolvers
const prisma = new PrismaClient()
const stamp = Date.now()

const created = { users: [], items: [], payIns: [] }
let viewer, poster, replier

async function mkUser (name) {
  const user = await prisma.user.create({ data: { name: `${name}${stamp}`.slice(0, 32) } })
  created.users.push(user.id)
  return user
}

// a post as itemCreate leaves it: Item + PAID ITEM_CREATE PayIn linked by ItemPayIn
async function mkPost (userId, createdAt, title) {
  const item = await prisma.item.create({ data: { userId, title, text: 'fixture', createdAt } })
  created.items.push(item.id)
  const payIn = await prisma.payIn.create({
    data: { userId, payInType: 'ITEM_CREATE', payInState: 'PAID', piconeros: 0n, createdAt }
  })
  created.payIns.push(payIn.id)
  await prisma.itemPayIn.create({ data: { itemId: item.id, payInId: payIn.id } })
  return item
}

async function mkReply (parent, userId, createdAt) {
  const item = await prisma.item.create({
    data: { userId, parentId: parent.id, rootId: parent.id, text: 'fixture reply', createdAt }
  })
  created.items.push(item.id)
  await prisma.reply.create({
    data: {
      ancestorId: parent.id,
      ancestorUserId: parent.userId,
      itemId: item.id,
      userId,
      level: 1,
      createdAt
    }
  })
  return item
}

// the bell is lit: notes were found after the last /notifications visit
async function lightBell (userId, lastChecked) {
  await prisma.user.update({
    where: { id: userId },
    data: { checkedNotesAt: lastChecked, foundNotesAt: new Date(lastChecked.getTime() + 1000) }
  })
}

function ctxFor (userId) {
  return {
    me: { id: userId },
    models: prisma,
    userLoader: { load: id => prisma.user.findUnique({ where: { id } }) },
    subLoader: { load: async () => null }
  }
}

// the checkedNotesAt bump is fire and forget, so poll for it
async function checkedNotesAt (userId, { movedFrom, timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { checkedNotesAt } = await prisma.user.findUnique({ where: { id: userId } })
    if (!movedFrom || checkedNotesAt > movedFrom || Date.now() > deadline) return checkedNotesAt
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

beforeAll(async () => {
  viewer = await mkUser('notesViewer')
  poster = await mkUser('notesPoster')
  replier = await mkUser('notesReplier')
  await prisma.userSubscription.create({
    data: { followerId: viewer.id, followeeId: poster.id, postsSubscribedAt: new Date(stamp - 60 * 60 * 1000) }
  })
})

afterEach(async () => {
  await prisma.reply.deleteMany({ where: { itemId: { in: created.items } } })
  await prisma.threadSubscription.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.itemPayIn.deleteMany({ where: { itemId: { in: created.items } } })
  await prisma.payIn.deleteMany({ where: { id: { in: created.payIns } } })
  // children first: replies reference their parent
  await prisma.item.deleteMany({ where: { id: { in: created.items }, parentId: { not: null } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  created.items = []
  created.payIns = []
})

afterAll(async () => {
  await prisma.userSubscription.deleteMany({ where: { followerId: { in: created.users } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

test('opening the followed post the bell is lit for clears it', async () => {
  const lastChecked = new Date(Date.now() - 10_000)
  const post = await mkPost(poster.id, new Date(lastChecked.getTime() + 500), 'new from followee')
  await lightBell(viewer.id, lastChecked)

  await expect(hasNewNotes(null, {}, ctxFor(viewer.id))).resolves.toBe(true)
  await expect(hasNewNotes(null, { viewedItemId: String(post.id) }, ctxFor(viewer.id))).resolves.toBe(false)

  const after = await checkedNotesAt(viewer.id, { movedFrom: lastChecked })
  expect(after > post.createdAt).toBe(true)
  // and the plain bell query agrees afterwards
  await expect(hasNewNotes(null, {}, ctxFor(viewer.id))).resolves.toBe(false)
})

test('a second unseen post keeps the bell lit', async () => {
  const lastChecked = new Date(Date.now() - 10_000)
  const viewed = await mkPost(poster.id, new Date(lastChecked.getTime() + 500), 'viewed')
  await mkPost(poster.id, new Date(lastChecked.getTime() + 600), 'not viewed')
  await lightBell(viewer.id, lastChecked)

  await expect(hasNewNotes(null, { viewedItemId: String(viewed.id) }, ctxFor(viewer.id))).resolves.toBe(true)
  const after = await checkedNotesAt(viewer.id)
  expect(after.getTime()).toBe(lastChecked.getTime())
})

test('opening an unrelated item keeps the bell lit', async () => {
  const lastChecked = new Date(Date.now() - 10_000)
  const unrelated = await mkPost(replier.id, new Date(lastChecked.getTime() - 60 * 1000), 'old and unrelated')
  await mkPost(poster.id, new Date(lastChecked.getTime() + 500), 'new from followee')
  await lightBell(viewer.id, lastChecked)

  await expect(hasNewNotes(null, { viewedItemId: String(unrelated.id) }, ctxFor(viewer.id))).resolves.toBe(true)
})

test('a reply in a subscribed thread clears when that thread is opened', async () => {
  const lastChecked = new Date(Date.now() - 10_000)
  const own = await mkPost(viewer.id, new Date(lastChecked.getTime() - 60 * 1000), 'my post')
  await prisma.threadSubscription.create({ data: { userId: viewer.id, itemId: own.id } })
  await mkReply(own, replier.id, new Date(lastChecked.getTime() + 500))
  await lightBell(viewer.id, lastChecked)

  await expect(hasNewNotes(null, {}, ctxFor(viewer.id))).resolves.toBe(true)
  await expect(hasNewNotes(null, { viewedItemId: String(own.id) }, ctxFor(viewer.id))).resolves.toBe(false)
  const after = await checkedNotesAt(viewer.id, { movedFrom: lastChecked })
  expect(after > lastChecked).toBe(true)
})

test('an unknown item id falls back to the normal bell check', async () => {
  const lastChecked = new Date(Date.now() - 10_000)
  await mkPost(poster.id, new Date(lastChecked.getTime() + 500), 'new from followee')
  await lightBell(viewer.id, lastChecked)

  await expect(hasNewNotes(null, { viewedItemId: '2147483000' }, ctxFor(viewer.id))).resolves.toBe(true)
  await expect(hasNewNotes(null, { viewedItemId: 'not-an-id' }, ctxFor(viewer.id))).resolves.toBe(true)
})
