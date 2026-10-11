/* eslint-env jest */

// worker/imgproxyResign.js re-signs stored imgproxy paths after an IMGPROXY_KEY
// rotation. lib/imgproxy reads IMGPROXY_KEY into a const at import time, so the
// env is set at the very top and modules are imported dynamically. Rotation
// cases flip IMGPROXY_KEY and re-import with jest.resetModules() to get a
// fresh signing instance — the pre-rotation import (and any entries it signed)
// keep the old key.

// worker/imgproxyResign.js logs via pino to stdout when the batch pass
// completes, which leaks stray noise into jest output. Mock the logger per
// repo convention (mirrors test/worker/imgproxy.test.js).
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

process.env.NEXT_PUBLIC_IMGPROXY_URL = 'https://imgprxy.test/'
process.env.IMGPROXY_SALT = 'a'.repeat(64)
process.env.IMGPROXY_KEY = 'b'.repeat(64)

let createImgproxyPath
let imgproxyResign
let findSignatureMismatch
let resignImgproxyUrls
let resignXPreview

beforeAll(async () => {
  const lib = await import('@/lib/imgproxy')
  createImgproxyPath = lib.createImgproxyPath
  const worker = await import('@/worker/imgproxyResign')
  imgproxyResign = worker.imgproxyResign
  findSignatureMismatch = worker.findSignatureMismatch
  resignImgproxyUrls = worker.resignImgproxyUrls
  resignXPreview = worker.resignXPreview
})

const makeEntry = (url) => ({
  dimensions: { width: 1, height: 1 },
  '640w': createImgproxyPath({ url, options: '/rs:fit:640:360' })
})

test('resignImgproxyUrls/resignXPreview: no-op on valid maps, same reference returned', () => {
  const map = { 'http://localhost:4566/uploads/1': makeEntry('http://minio:9000/uploads/1') }
  expect(resignImgproxyUrls(map)).toBe(map)
  const xPreview = { image: makeEntry('http://minio:9000/uploads/1') }
  expect(resignXPreview(xPreview)).toBe(xPreview)
})

test('after rotation: map keys and metadata preserved, paths re-signed, new object returned', async () => {
  const map = { 'http://localhost:4566/uploads/1': makeEntry('http://minio:9000/uploads/1') }
  process.env.IMGPROXY_KEY = 'c'.repeat(64)
  jest.resetModules()
  const fresh = await import('@/worker/imgproxyResign')
  const freshLib = await import('@/lib/imgproxy')
  const next = fresh.resignImgproxyUrls(map)
  expect(Object.keys(next)).toEqual(['http://localhost:4566/uploads/1'])
  expect(next['http://localhost:4566/uploads/1'].dimensions).toEqual({ width: 1, height: 1 })
  expect(freshLib.verifyImgproxyPath(next['http://localhost:4566/uploads/1']['640w'])).toBe(true)
})

test('imgproxyResign updates only rows whose JSON changed', async () => {
  const staleEntry = makeEntry('http://minio:9000/uploads/1') // signed with 'b' key above
  process.env.IMGPROXY_KEY = 'c'.repeat(64)
  jest.resetModules()
  const fresh = await import('@/worker/imgproxyResign')
  const freshLib = await import('@/lib/imgproxy')
  const validEntry = { ...staleEntry, '640w': freshLib.createImgproxyPath({ url: 'http://minio:9000/uploads/2', options: '/rs:fit:640:360' }) }
  const updates = []
  const models = {
    item: {
      findMany: async () => [
        { id: 1, imgproxyUrls: { u: staleEntry }, xPreview: null },
        { id: 2, imgproxyUrls: { u2: validEntry }, xPreview: { image: staleEntry } }
      ],
      updateMany: async ({ where, data }) => { updates.push([where.id, data]); return { count: 1 } }
    }
  }
  await fresh.imgproxyResign({ models })
  expect(updates.map(([id]) => id)).toEqual([1, 2]) // row 2 changed via xPreview
  expect(freshLib.verifyImgproxyPath(updates[0][1].imgproxyUrls.u['640w'])).toBe(true)
  expect(freshLib.verifyImgproxyPath(updates[1][1].xPreview.image['640w'])).toBe(true)
})

test('imgproxyResign writes through a compare-and-set and skips a concurrently changed preview', async () => {
  const staleEntry = makeEntry('http://minio:9000/uploads/1')
  process.env.IMGPROXY_KEY = 'c'.repeat(64)
  jest.resetModules()
  const fresh = await import('@/worker/imgproxyResign')
  // by write time an edit cleared/replaced the preview the resign was computed
  // from — the CAS misses and the stale re-signed preview must NOT be restored
  const models = {
    item: {
      findMany: async () => [{ id: 1, imgproxyUrls: {}, xPreview: { image: staleEntry } }],
      updateMany: jest.fn(async () => ({ count: 0 }))
    }
  }
  await fresh.imgproxyResign({ models })
  expect(models.item.updateMany).toHaveBeenCalledTimes(1)
  expect(models.item.updateMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 1, xPreview: { equals: { image: staleEntry } } }
  }))
})

test('imgproxyResign with zero matching rows terminates without updates', async () => {
  const updates = []
  const models = { item: { findMany: async () => [], update: async (a) => { updates.push(a) } } }
  await imgproxyResign({ models })
  expect(updates).toEqual([])
})

test('findSignatureMismatch: false when no stored paths (fresh DB)', async () => {
  const models = { item: { findMany: async () => [{ imgproxyUrls: {}, xPreview: null }] } }
  expect(await findSignatureMismatch(models)).toBe(false)
})

test('findSignatureMismatch: true when ANY sampled path is invalid; samples imgproxyUrls AND xPreview', async () => {
  const stale = makeEntry('http://minio:9000/uploads/1')
  process.env.IMGPROXY_KEY = 'c'.repeat(64)
  jest.resetModules()
  const fresh = await import('@/worker/imgproxyResign')
  const freshLib = await import('@/lib/imgproxy')
  const valid = { '640w': freshLib.createImgproxyPath({ url: 'http://minio:9000/uploads/2', options: '/rs:fit:640:360' }) }
  const models = {
    item: {
      findMany: async () => [
        { imgproxyUrls: { u: valid }, xPreview: null },
        { imgproxyUrls: {}, xPreview: { image: stale } } // mismatch only visible via xPreview
      ]
    }
  }
  expect(await fresh.findSignatureMismatch(models)).toBe(true)
})
