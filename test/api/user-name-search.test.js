/* eslint-env jest */
// Real-DB regression for the missing public.search_users_by_name(text, real,
// integer) helper (Finding 4). Both resolver call sites — userSuggestions
// (api/resolvers/user.js) and searchUsers — invoke this exact signature; with
// the function absent they raise
// "function search_users_by_name(text, real, integer) does not exist".
// The helper is restored by
// prisma/migrations/20261012100000_restore_user_name_search/migration.sql.
//
//   docker exec -u apprunner app npx jest test/api/user-name-search.test.js
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Unique-per-run fixtures. Ids are captured from the inserts, never assumed
// serials (the dev DB's max users.id is far above the reserved range).
const prefix = randomUUID().replaceAll('-', '').slice(0, 10)
const fixtureName = `search${prefix}a`
const fixtureNameB = `search${prefix}b`
const fixtureBase = `search${prefix}`
const dissimilarQuery = `unrelated${prefix}`

const created = []
let fixtureUserId
let fixtureUserIdB

beforeAll(async () => {
  const first = await prisma.user.create({ data: { name: fixtureName } })
  const second = await prisma.user.create({ data: { name: fixtureNameB } })
  created.push(first.id, second.id)
  fixtureUserId = first.id
  fixtureUserIdB = second.id
})

afterAll(async () => {
  if (created.length) {
    await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {})
  }
  await prisma.$disconnect()
})

test('the user-search signature used by both resolvers exists', async () => {
  const [row] = await prisma.$queryRaw`
    SELECT to_regprocedure('public.search_users_by_name(text,real,integer)')::text AS signature`
  expect(row.signature).not.toBeNull()
})

test('name lookup returns the fixture and respects result_limit', async () => {
  const rows = await prisma.$queryRaw`
    SELECT id, name FROM search_users_by_name(${fixtureName}::text, 0.1::real, 1::integer)`
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBe(fixtureUserId)
})

test('SELECT * returns the full user row shape', async () => {
  const [row] = await prisma.$queryRaw`
    SELECT * FROM search_users_by_name(${fixtureName}::text, 0.5::real, 1::integer)`
  expect(row.id).toBe(fixtureUserId)
  expect(row.name).toBe(fixtureName)
  expect(row.created_at).toBeInstanceOf(Date)
})

test('matching is case-insensitive', async () => {
  const rows = await prisma.$queryRaw`
    SELECT id, name FROM search_users_by_name(${fixtureName.toUpperCase()}::text, 0.5::real, 1::integer)`
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBe(fixtureUserId)
})

test('a search does not leak its threshold into the calling transaction', async () => {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('pg_trgm.similarity_threshold', '0.3', true)`
    await tx.$queryRaw`SELECT id FROM search_users_by_name(${fixtureName}::text, 0.1::real, 5::integer)`
    const [row] = await tx.$queryRaw`SELECT current_setting('pg_trgm.similarity_threshold') AS threshold`
    expect(Number(row.threshold)).toBe(0.3)

    // 0.3 is also the function's own default, so a second value distinct from
    // both it and the call's 0.1 proves the caller's value is restored rather
    // than the function default being re-applied.
    await tx.$queryRaw`SELECT set_config('pg_trgm.similarity_threshold', '0.55', true)`
    await tx.$queryRaw`SELECT id FROM search_users_by_name(${fixtureName}::text, 0.1::real, 5::integer)`
    const [after] = await tx.$queryRaw`SELECT current_setting('pg_trgm.similarity_threshold') AS threshold`
    expect(Number(after.threshold)).toBe(0.55)
  })
})

test('result_limit of zero yields no rows', async () => {
  const rows = await prisma.$queryRaw`
    SELECT id FROM search_users_by_name(${fixtureName}::text, 0.1::real, 0::integer)`
  expect(rows).toHaveLength(0)
})

test('a dissimilar query yields no rows', async () => {
  const rows = await prisma.$queryRaw`
    SELECT id FROM search_users_by_name(${dissimilarQuery}::text, 0.9::real, 5::integer)`
  expect(rows).toHaveLength(0)
})

test('equally similar fixtures are ordered alphabetically by name', async () => {
  const rows = await prisma.$queryRaw`
    SELECT id, name FROM search_users_by_name(${fixtureBase}::text, 0.5::real, 5::integer)`
  expect(rows.map(row => row.id)).toEqual([fixtureUserId, fixtureUserIdB])
})

test('the eligibility predicate is preserved and admits the seeded anon account', async () => {
  const [fn] = await prisma.$queryRaw`
    SELECT pg_get_functiondef('public.search_users_by_name(text,real,integer)'::regprocedure) AS definition`
  expect(fn.definition).toMatch(/id\s*>\s*615\s+OR\s+u\.id\s+IN\s*\(27,\s*106\)/)
  // The FULL eligibility clause, not only the id fragment: name search must
  // admit every sufficient match and is FORBIDDEN from applying the
  // top-users visibility filter used elsewhere (`hideFromTopUsers`), which
  // would silently hide real users from search/autocomplete. Both halves of
  // the current predicate and the absence of the forbidden filter are pinned.
  expect(fn.definition).toMatch(
    /WHERE\s+\(u\.id\s*>\s*615\s+OR\s+u\.id\s+IN\s*\(27,\s*106\)\)\s+AND\s+u\.name\s+%\s+search_q/
  )
  expect(fn.definition).not.toMatch(/hideFromTopUsers/i)

  const rows = await prisma.$queryRaw`
    SELECT id, name FROM search_users_by_name('anon'::text, 0.5::real, 5::integer)`
  expect(rows.some(row => Number(row.id) === 27)).toBe(true)
})
