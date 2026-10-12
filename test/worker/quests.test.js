/* eslint-env jest */
import { PrismaClient } from '@prisma/client'
import { sweepQuestCompletions } from '@/worker/quests'
import { advanceQuestStreak } from '@/worker/streak'
import { resolveDraw } from '@/api/quests/draw'
import { notifyFlameAdvanced, notifyQuestCompleted } from '@/lib/webPush'
import { BOOST_QUEST_LAST_DAY, drawFor, utcDay, QUEST } from '@/lib/quests'

jest.mock('../../lib/webPush', () => ({
  notifyQuestCompleted: jest.fn(() => Promise.resolve()),
  notifyFlameAdvanced: jest.fn(() => Promise.resolve())
}))

const prisma = new PrismaClient()
const created = { users: [], items: [], accounts: [], tips: [] }

// BOOST days only exist in the pre-cutover era (lib/quests.js day-keyed pool),
// so scan backward from the last BOOST day: these fixtures keep finding one
// forever, where a forward scan from today would run dry past the cutover.
function lastBoostDayFor (userId) {
  const last = new Date(`${BOOST_QUEST_LAST_DAY}T00:00:00Z`)
  for (let i = 0; i < 30; i++) {
    const d = utcDay(new Date(last.getTime() - i * 86_400_000))
    if (drawFor(userId, d).drawn === QUEST.BOOST) return d
  }
  return null
}

async function mkUser () {
  const [row] = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  created.users.push(row.id)
  return row.id
}

afterAll(async () => {
  await prisma.streakReward.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.questCompletion.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.observedTip.deleteMany({ where: { txHash: { startsWith: 'qsweep-' } } })
  // before the payIn delete (FK): M4 requires the sweep's BOOST seeds to carry
  // an observation, and the observation references the payIn
  await prisma.feeObservation.deleteMany({ where: { txHash: { startsWith: 'qsweep-boost-' } } })
  await prisma.payIn.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.streak.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  await prisma.$disconnect()
})

test('the sweep records each completion once and notifies once', async () => {
  const userId = await mkUser()
  // Force an upvote completion: seed a fresh tip (sweep looks back ~10 minutes).
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qsweep${userId}${Date.now()}`.slice(0, 95), label: 'q', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep post', now()) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qsweep-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qsweep-pid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED' } })

  await sweepQuestCompletions({ models: prisma, userIds: created.users })
  const draw = await resolveDraw(prisma, userId, new Date().toISOString().slice(0, 10))
  const rows = await prisma.questCompletion.findMany({ where: { userId } })
  expect(rows.length).toBeGreaterThanOrEqual(1)
  expect(rows.some(r => r.quest === draw.upvote)).toBe(true)

  notifyQuestCompleted.mockClear()
  await sweepQuestCompletions({ models: prisma, userIds: created.users }) // second run: no new rows, no new pushes
  expect(notifyQuestCompleted).not.toHaveBeenCalled()
})

test('the first sweep after midnight records completions from the previous UTC day', async () => {
  const userId = await mkUser()
  // The tick at 00:02 looks back across the boundary: an action at 23:58 must
  // still be recorded for the 9th (the streak job evaluates the just-ended day).
  const now = new Date('2026-06-10T00:02:00.000Z')
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qsweepb${userId}${Date.now()}`.slice(0, 95), label: 'q', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep boundary post', now()) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qsweep-boundary-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qsweep-bpid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date('2026-06-09T23:58:00.000Z') } })

  await sweepQuestCompletions({ models: prisma, now, userIds: created.users })

  const rows = await prisma.questCompletion.findMany({ where: { userId, day: new Date('2026-06-09T00:00:00.000Z') } })
  expect(rows.some(r => r.quest === 'UPVOTE')).toBe(true)
})

test('the sweep lights the flame as soon as a day is cleared, exactly once', async () => {
  const userId = await mkUser()
  const today = utcDay(new Date())
  const dayDate = new Date(`${today}T00:00:00.000Z`)
  // Both completions are on record (e.g. recorded by an earlier tick, or before
  // a worker restart) — the advance is driven by the rows, not the lookback.
  await prisma.questCompletion.createMany({
    data: [
      { userId, day: dayDate, quest: QUEST.UPVOTE },
      { userId, day: dayDate, quest: QUEST.BOOST }
    ]
  })

  notifyFlameAdvanced.mockClear()
  await sweepQuestCompletions({ models: prisma, userIds: created.users })
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(1)
  const [streak] = await prisma.streak.findMany({ where: { userId } })
  expect(streak.lastEvaluatedDay).toEqual(dayDate)
  expect(notifyFlameAdvanced.mock.calls.filter(([id]) => id === userId)).toHaveLength(1)

  // A later tick neither re-advances nor re-notifies.
  await sweepQuestCompletions({ models: prisma, userIds: created.users })
  const [after] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(after.streak).toBe(1)
  expect(notifyFlameAdvanced.mock.calls.filter(([id]) => id === userId)).toHaveLength(1)
})

test('a run\'s first day banks the day 1 rung plus both quest credits', async () => {
  const userId = await mkUser()
  // No streak rows and no prior completions: today is the run's first day, so
  // no active FLAME row exists until the sweep's own advance creates it.
  // Pick a day whose drawn slot is BOOST so both quests are tip/payIn-driven.
  const day = lastBoostDayFor(userId)
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qsweepd${userId}${Date.now()}`.slice(0, 95), label: 'q', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep first-day post', now()) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qsweep-firstday-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qsweep-fd-pid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(now.getTime() - 5 * 60 * 1000) } })
  // M4: the sweep's BOOST leg requires an observed payment — a bare born-PAID
  // payIn no longer completes the quest (that's the abandoned-dialog bug).
  const boostPayIn = await prisma.payIn.create({ data: { userId, payInType: 'BOOST', payInState: 'PAID', piconeros: 100000000n, createdAt: new Date(now.getTime() - 4 * 60 * 1000) } })
  await prisma.feeObservation.create({ data: { txHash: `qsweep-boost-${boostPayIn.id}-${Date.now()}`, payInId: boostPayIn.id, feeType: 'BOOST', recipientMajor: 5, recipientMinor: 77, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(now.getTime() - 3 * 60 * 1000) } })

  await sweepQuestCompletions({ models: prisma, now, userIds: created.users })

  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`) } })).toBe(2)
  // The advance created the run on this first cleared day.
  const [streak] = await prisma.streak.findMany({ where: { userId, type: 'FLAME' } })
  expect(streak).toBeDefined()
  expect(streak.startedAt).toEqual(new Date(`${day}T00:00:00.000Z`))
  expect(streak.lastEvaluatedDay).toEqual(new Date(`${day}T00:00:00.000Z`))
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(1)
  // Day 1's rung banks a reply too (rev 4), on top of one credit per quest:
  // three total; only the ladder rung needs the run created after banking.
  const credits = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY' } })
  expect(credits).toHaveLength(3)
  expect(credits.filter(c => c.streakId === streak.id)).toHaveLength(1)
  expect(credits.filter(c => c.streakId === null)).toHaveLength(2)
  expect(credits.every(c => c.consumedAt === null)).toBe(true)

  await sweepQuestCompletions({ models: prisma, now, userIds: created.users }) // re-run: nothing new banks
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(3)
})

test('a quest completion banks one reply credit, once', async () => {
  const userId = await mkUser()
  // An active flame whose previous day is still pending: the sweep's advance
  // defers, so every credit below comes from the per-quest banking.
  await prisma.streak.create({ data: { userId, type: 'FLAME', startedAt: new Date(Date.now() - 86_400_000) } })
  // Pick a day whose drawn slot is BOOST so both quests are tip/payIn-driven.
  const day = lastBoostDayFor(userId)
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qsweepc${userId}${Date.now()}`.slice(0, 95), label: 'q', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep bank post', now()) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qsweep-bank-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qsweep-bank-pid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(now.getTime() - 5 * 60 * 1000) } })
  // M4: an observed BOOST payment (see the first-day test above).
  const boostPayIn = await prisma.payIn.create({ data: { userId, payInType: 'BOOST', payInState: 'PAID', piconeros: 100000000n, createdAt: new Date(now.getTime() - 4 * 60 * 1000) } })
  await prisma.feeObservation.create({ data: { txHash: `qsweep-boost-${boostPayIn.id}-${Date.now()}`, payInId: boostPayIn.id, feeType: 'BOOST', recipientMajor: 5, recipientMinor: 77, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(now.getTime() - 3 * 60 * 1000) } })

  await sweepQuestCompletions({ models: prisma, now, userIds: created.users })
  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`) } })).toBe(2)
  const credits = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY' } })
  expect(credits).toHaveLength(2) // one per quest

  await sweepQuestCompletions({ models: prisma, now, userIds: created.users }) // re-run: nothing new banks
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(2)
})

// Quest credits are flame-independent (product clarification 2026-10-06):
// completing a quest banks its reply on the tick it is recorded, with no
// streak row at all, and the two completions bank independently even when
// they land in different sweep ticks (the old flame-gated banking silently
// dropped the earlier tick's credit once the day later cleared).
test('quest completions bank with no flame at all, across separate ticks', async () => {
  const userId = await mkUser() // no streak row, users.streak stays null
  let day = null
  for (let i = 0; i < 30 && !day; i++) {
    const d = utcDay(new Date(Date.now() + i * 86_400_000))
    if (drawFor(userId, d).drawn === QUEST.FIRST_RESPONDER) day = d
  }
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)

  // Tick 1: the first-responder action alone (the upvote slot stays undone,
  // so the day does not clear and no run is created).
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep nf root', ${now}) RETURNING id::int AS id`
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'qsweep nf reply', ${now}) RETURNING id::int AS id`
  created.items.push(root.id, comment.id)

  await sweepQuestCompletions({ models: prisma, now, userIds: created.users })

  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`), quest: QUEST.FIRST_RESPONDER } })).toBe(1)
  expect(await prisma.streak.count({ where: { userId, type: 'FLAME' } })).toBe(0)
  const first = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY' } })
  expect(first).toHaveLength(1) // banks with no flame, on its own tick
  expect(first[0].streakId).toBeNull()

  // Tick 2: the upvote completes the day. Its credit banks on THIS tick even
  // though no flame existed when the first-responder credit banked; the clear
  // also starts the run, whose day-1 rung adds one more reply.
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qsweepnf${userId}${Date.now()}`.slice(0, 95), label: 'q', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep nf tip post', ${now}) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qsweep-nf-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qsweep-nf-pid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(now.getTime() - 5 * 60 * 1000) } })

  await sweepQuestCompletions({ models: prisma, now, userIds: created.users })

  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`) } })).toBe(2)
  const [streak] = await prisma.streak.findMany({ where: { userId, type: 'FLAME' } })
  expect(streak).toBeDefined() // the cleared day starts the run
  const all = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY' }, orderBy: { id: 'asc' } })
  expect(all).toHaveLength(3) // first responder + upvote + day-1 ladder rung
  expect(all[0].streakId).toBeNull() // banked before any run existed
  expect(all[1].streakId).toBeNull() // upvote commits before the first run exists
  expect(all[2].streakId).toBe(streak.id) // day-1 rung
})

test('a first responder completion banks one reply credit', async () => {
  const userId = await mkUser()
  let day = null
  for (let i = 0; i < 30 && !day; i++) {
    const d = utcDay(new Date(Date.now() + i * 86_400_000))
    if (drawFor(userId, d).drawn === QUEST.FIRST_RESPONDER) day = d
  }
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  // An active run whose day-1 rung is already granted and whose today is
  // already counted, so the only new credit comes from the flat quest
  // reward (the upvote slot stays undone, so the day never clears).
  await prisma.streak.create({ data: { userId, type: 'FLAME', rewardLevel: 1, startedAt: new Date(`${day}T00:00:00.000Z`), lastEvaluatedDay: new Date(`${day}T00:00:00.000Z`) } })
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep fr4 root', ${now}) RETURNING id::int AS id`
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'qsweep fr4 reply', ${now}) RETURNING id::int AS id`
  created.items.push(root.id, comment.id)

  await sweepQuestCompletions({ models: prisma, now, userIds: created.users })

  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`), quest: QUEST.FIRST_RESPONDER } })).toBe(1)
  const credits = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY' } })
  expect(credits).toHaveLength(1)
})

test('reply banking failure rolls back its quest completion, so a retry cannot lose the grant', async () => {
  const userId = await mkUser()
  let day = null
  for (let i = 0; i < 30 && !day; i++) {
    const candidate = utcDay(new Date(Date.now() + i * 86_400_000))
    if (drawFor(userId, candidate).drawn === QUEST.FIRST_RESPONDER) day = candidate
  }
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00Z`)
  const dayDate = new Date(`${day}T00:00:00Z`)
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'rollback root', ${now}) RETURNING id::int AS id`
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'rollback reply', ${now}) RETURNING id::int AS id`
  created.items.push(root.id, comment.id)
  const faulty = prisma.$extends({
    query: {
      async $queryRaw ({ args, query }) {
        const sql = args?.strings?.join('') ?? String(args?.sql ?? args?.[0])
        if (sql.includes('INSERT INTO "StreakReward"')) throw new Error('banking interrupted')
        return query(args)
      }
    }
  })
  notifyQuestCompleted.mockClear()
  await expect(sweepQuestCompletions({ models: faulty, now, userIds: [userId] })).rejects.toThrow('banking interrupted')
  expect(await prisma.questCompletion.count({ where: { userId, day: dayDate } })).toBe(0)
  expect(await prisma.streakReward.count({ where: { userId } })).toBe(0)
  expect(notifyQuestCompleted.mock.calls.filter(([id]) => id === userId)).toHaveLength(0)
  await sweepQuestCompletions({ models: prisma, now, userIds: [userId] })
  await sweepQuestCompletions({ models: prisma, now, userIds: [userId] })
  expect(await prisma.questCompletion.count({ where: { userId, day: dayDate } })).toBe(1)
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(1)
})

test('nine held replies bank one more and stop exactly at the cap of ten', async () => {
  const userId = await mkUser()
  let day = null
  for (let i = 0; i < 30 && !day; i++) {
    const d = utcDay(new Date(Date.now() + i * 86_400_000))
    if (drawFor(userId, d).drawn === QUEST.FIRST_RESPONDER) day = d
  }
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  await prisma.streak.create({ data: { userId, type: 'FLAME', rewardLevel: 1, startedAt: new Date(`${day}T00:00:00.000Z`), lastEvaluatedDay: new Date(`${day}T00:00:00.000Z`) } })
  await prisma.streakReward.createMany({
    data: Array.from({ length: 9 }, () => ({ userId, type: 'REPLY', expiresAt: new Date(Date.now() + 86_400_000) }))
  })
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep cap9 root', ${now}) RETURNING id::int AS id`
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'qsweep cap9 reply', ${now}) RETURNING id::int AS id`
  created.items.push(root.id, comment.id)

  await sweepQuestCompletions({ models: prisma, now, userIds: created.users })

  // 9 held + the flat +1 grant lands exactly on the cap of ten and never crosses.
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: null } })).toBe(10)
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(10)
})

test('twelve held replies are grandfathered above the cap and banking resumes after spend-down', async () => {
  const userId = await mkUser()
  let day = null
  for (let i = 0; i < 30 && !day; i++) {
    const d = utcDay(new Date(Date.now() + i * 86_400_000))
    if (drawFor(userId, d).drawn === QUEST.FIRST_RESPONDER) day = d
  }
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  await prisma.streak.create({ data: { userId, type: 'FLAME', rewardLevel: 1, startedAt: new Date(`${day}T00:00:00.000Z`), lastEvaluatedDay: new Date(`${day}T00:00:00.000Z`) } })
  await prisma.streakReward.createMany({
    data: Array.from({ length: 12 }, () => ({ userId, type: 'REPLY', expiresAt: new Date(Date.now() + 86_400_000) }))
  })
  const [root] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep cap12 root', ${now}) RETURNING id::int AS id`
  const [comment] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at) VALUES (${userId}::int, ${root.id}::int, ${root.id}::int, 'qsweep cap12 reply', ${now}) RETURNING id::int AS id`
  created.items.push(root.id, comment.id)

  // 12 held is above the new cap of ten: the sweep neither grants nor claws
  // back — the surplus stays spendable (grandfathered) until consumed or expired.
  await sweepQuestCompletions({ models: prisma, now, userIds: created.users })
  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`), quest: QUEST.FIRST_RESPONDER } })).toBe(1)
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: null } })).toBe(12)

  // Spend three rows down (consumed, never deleted)...
  const held = await prisma.streakReward.findMany({ where: { userId, type: 'REPLY', consumedAt: null }, take: 3 })
  await prisma.streakReward.updateMany({ where: { id: { in: held.map(r => r.id) } }, data: { consumedAt: new Date() } })

  // ...then a different future drawn FIRST_RESPONDER day: a fresh root and
  // first reply, swept in that fresh day (the original day's completion stays
  // in place — freshness comes from the new day's own recorded completion,
  // which is what re-opens banking).
  let day1 = null
  for (let i = 1; i <= 60 && !day1; i++) {
    const d = utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + i * 86_400_000))
    if (drawFor(userId, d).drawn === QUEST.FIRST_RESPONDER) day1 = d
  }
  expect(day1).not.toBeNull()
  expect(day1).not.toBe(day)
  const now1 = new Date(`${day1}T12:00:00.000Z`)
  const [root1] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep cap12 second root', ${now1}) RETURNING id::int AS id`
  const [comment1] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", "parentId", "rootId", text, created_at) VALUES (${userId}::int, ${root1.id}::int, ${root1.id}::int, 'qsweep cap12 second reply', ${now1}) RETURNING id::int AS id`
  created.items.push(root1.id, comment1.id)

  await sweepQuestCompletions({ models: prisma, now: now1, userIds: created.users })

  // Nine held + one fresh grant refills to exactly ten; the three consumed
  // rows stay in the ledger, so the lifetime count is 13.
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: null } })).toBe(10)
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY' } })).toBe(13)
})

// The sweep and a same-day advance both write StreakReward rows; without the
// user-row lock their count predicates interleave and a 9-held bank can grow
// past the cap of ten. The lock serializes every cap check (task 3).
test('a concurrent day-3 rung and completion banking never cross the reply cap', async () => {
  const userId = await mkUser()
  // An active run whose previous day is unsettled: the sweep's own advance
  // defers, so the racing direct advance is the only one that counts the day
  // and can grant the day-3 reply rung.
  await prisma.streak.create({ data: { userId, type: 'FLAME', startedAt: new Date(Date.now() - 86_400_000), rewardLevel: 2 } })
  await prisma.$executeRaw`UPDATE users SET streak = 2 WHERE id = ${userId}::int`
  await prisma.streakReward.createMany({
    data: Array.from({ length: 9 }, () => ({ userId, type: 'REPLY', expiresAt: new Date(Date.now() + 86_400_000) }))
  })
  // Pick a day whose drawn slot is BOOST so both quest legs are tip/payIn-driven.
  const day = lastBoostDayFor(userId)
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  const account = await prisma.moneroAccount.create({ data: { ownerUserId: null, address: `qsweeprace${userId}${Date.now()}`.slice(0, 95), label: 'q', network: 'STAGENET', status: 'ACTIVE' } })
  created.accounts.push(account.id)
  const [post] = await prisma.$queryRaw`INSERT INTO "Item" ("userId", title, created_at) VALUES (${userId}::int, 'qsweep race post', ${now}) RETURNING id::int AS id`
  created.items.push(post.id)
  await prisma.observedTip.create({ data: { txHash: `qsweep-race-${Date.now()}`, postId: post.id, tipperId: userId, recipientAccountId: account.id, paymentId: `qsweep-race-pid-${Date.now()}`, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(now.getTime() - 5 * 60 * 1000) } })
  const boostPayIn = await prisma.payIn.create({ data: { userId, payInType: 'BOOST', payInState: 'PAID', piconeros: 100000000n, createdAt: new Date(now.getTime() - 4 * 60 * 1000) } })
  await prisma.feeObservation.create({ data: { txHash: `qsweep-boost-${boostPayIn.id}-${Date.now()}`, payInId: boostPayIn.id, feeType: 'BOOST', recipientMajor: 5, recipientMinor: 77, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(now.getTime() - 3 * 60 * 1000) } })

  await Promise.all([
    sweepQuestCompletions({ models: prisma, now, userIds: [userId] }),
    advanceQuestStreak({ models: prisma, userId, day })
  ])

  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`) } })).toBe(2)
  // 9 held + the two count-gated banks (sweep) and the count-gated day-3 rung
  // (advance): whichever order the lock hands out, the bank lands on ten and
  // never crosses it.
  expect(await prisma.streakReward.count({ where: { userId, type: 'REPLY', consumedAt: null } })).toBe(10)
  // exactly one advance counted the day (the sweep's own advance defers)
  const [user] = await prisma.$queryRaw`SELECT streak FROM users WHERE id = ${userId}::int`
  expect(user.streak).toBe(3)
})

// M4 residual (2026-09-26 review): candidacy is keyed on the PayIn CREATION
// inside the 10-minute lookback, but a boost paid later than that (wallet sync
// delay, paying from the URI after closing the dialog) never re-enters the
// sweep and nothing re-derives the day — the quest and its reply credit are
// lost despite the payment landing. The rescue keys candidacy on the
// OBSERVATION instead.
test('a boost observed after its initiation left the lookback window still completes', async () => {
  const userId = await mkUser()
  const day = lastBoostDayFor(userId)
  expect(day).not.toBeNull()
  const now = new Date(`${day}T12:00:00.000Z`)
  // Initiated 20 minutes ago (outside the lookback), observed 2 minutes ago:
  // the creation-keyed candidate leg has already lost this PayIn.
  const boostPayIn = await prisma.payIn.create({ data: { userId, payInType: 'BOOST', payInState: 'PAID', piconeros: 100000000n, createdAt: new Date(now.getTime() - 20 * 60 * 1000) } })
  await prisma.feeObservation.create({ data: { txHash: `qsweep-boost-${boostPayIn.id}-${Date.now()}`, payInId: boostPayIn.id, feeType: 'BOOST', recipientMajor: 5, recipientMinor: 77, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(now.getTime() - 2 * 60 * 1000) } })

  await sweepQuestCompletions({ models: prisma, now, userIds: created.users })

  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`), quest: QUEST.BOOST } })).toBe(1)
})

// The cross-midnight flavor: the initiation belongs to the just-ended day, so
// the rescue must sweep the day the PayIn was CREATED in — a tick whose
// straddle days no longer include it must still record it.
test('a boost initiated before midnight and observed after still completes for the initiation day', async () => {
  const userId = await mkUser()
  const day = lastBoostDayFor(userId)
  expect(day).not.toBeNull()
  const initiatedAt = new Date(`${day}T23:40:00.000Z`)
  const tick = new Date(initiatedAt.getTime() + 28 * 60 * 1000) // 00:08 next day: straddle days are [day, next]
  const boostPayIn = await prisma.payIn.create({ data: { userId, payInType: 'BOOST', payInState: 'PAID', piconeros: 100000000n, createdAt: initiatedAt } })
  await prisma.feeObservation.create({ data: { txHash: `qsweep-boost-${boostPayIn.id}-${Date.now()}`, payInId: boostPayIn.id, feeType: 'BOOST', recipientMajor: 5, recipientMinor: 77, piconeros: 100000000n, state: 'DETECTED', detectedAt: new Date(initiatedAt.getTime() + 27 * 60 * 1000) } })

  await sweepQuestCompletions({ models: prisma, now: tick, userIds: created.users })

  expect(await prisma.questCompletion.count({ where: { userId, day: new Date(`${day}T00:00:00.000Z`), quest: QUEST.BOOST } })).toBe(1)
})
