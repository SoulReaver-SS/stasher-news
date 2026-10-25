/* eslint-env jest */

// isMediaURL (worker/imgproxy.js) must accept self-hosted upload URLs in prod
// mode. Regression: in prod the MEDIA_URL_DOCKER rewrite makes the fetch URL
// http:// (killed by the https-only exclude) and, without a rewrite, the public
// upload URL lives on the stasher.news host (killed by the host exclude) — so
// uploads never made it past the gate and imgproxyUrls stayed empty.
//
// The module reads IMGPROXY_URL into a const at import time, so it is imported
// dynamically after the env is set in beforeAll.

// worker/imgproxy.js transitively imports @/lib/md, whose mdast chain
// (mdast-util-gfm, mdast-util-from-markdown, micromark-extension-gfm) is
// ESM-only and next/jest does not transform node_modules — the module cannot
// even load otherwise. Only extractUrls is consumed by createImgproxyUrls, so
// stub it with a regex extractor for the single-link inputs used here.
// Relative path per the repo convention (next/jest registers no `@/*`
// moduleNameMapper for jest.mock's first argument).
jest.mock('../../lib/md', () => ({
  __esModule: true,
  extractUrls: (md) => [...md.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1])
}))

// worker/imgproxy.js logs via pino to stdout on every call (logInfo in
// createImgproxyUrls), which leaks stray noise into jest output. Mock the
// logger per repo convention (mirrors test/worker/opsSweep.test.js).
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

beforeAll(() => {
  process.env.NEXT_PUBLIC_MEDIA_URL = 'https://stasher.news/uploads'
  process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
  // pin the media-check endpoint so isMediaURL's media-check branch is fully
  // determined by the fetch mock below, independent of the runner's env
  process.env.MEDIA_CHECK_URL_DOCKER = 'https://capture.test/media'
  process.env.NEXT_PUBLIC_IMGPROXY_URL = 'https://imgprxy.test/'
  process.env.IMGPROXY_SALT = 'a'.repeat(64)
  process.env.IMGPROXY_KEY = 'b'.repeat(64)
})

afterAll(() => {
  jest.restoreAllMocks()
})

// fake models.upload for the Upload-row video/image lookup (B1 fix)
const uploadModels = rows => ({
  upload: {
    findUnique: async ({ where: { id } }) => (rows[id] ? { type: rows[id] } : null)
  }
})

it('passes the public upload URL and probes the docker-rewritten origin', async () => {
  const { createImgproxyUrls } = await import('@/worker/imgproxy')
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
    json: async () => ({ width: 640, height: 360, format: 'jpeg', video_streams: [] })
  })

  const result = await createImgproxyUrls(1, '![img](https://stasher.news/uploads/123)', {})

  // the URL key is the public URL as written in the post
  expect(result['https://stasher.news/uploads/123'].dimensions).toEqual({ width: 640, height: 360 })
  // metadata was fetched from the docker-rewritten origin (minio), not the public host.
  // getMetadata fetches imgproxy's /info endpoint, whose last path segment is the
  // base64url-encoded source URL — decode it to prove the rewrite won.
  const [fetched] = fetchMock.mock.calls[0]
  expect(Buffer.from(fetched.slice(fetched.lastIndexOf('/') + 1), 'base64url').toString())
    .toBe('http://minio:9000/uploads/123')
  // full resolution ladder is produced
  for (const res of ['640w', '960w', '1280w', '1600w', '1920w', '2560w']) {
    expect(result['https://stasher.news/uploads/123'][res]).toMatch(/^\//)
  }
})

it('passes a docker-origin upload URL directly (no rewrite case)', async () => {
  const { createImgproxyUrls } = await import('@/worker/imgproxy')
  jest.spyOn(global, 'fetch').mockResolvedValue({
    json: async () => ({ width: 100, height: 50, format: 'png', video_streams: [] })
  })

  const result = await createImgproxyUrls(2, '![img](http://minio:9000/uploads/45)', {})

  expect(result['http://minio:9000/uploads/45']['640w']).toMatch(/^\//)
})

it('keeps excluding non-upload URLs on the site host', async () => {
  const { createImgproxyUrls } = await import('@/worker/imgproxy')

  const result = await createImgproxyUrls(3, '[link](https://stasher.news/items/266838)', {})

  expect(result).toEqual({})
})

it('does not trust sibling paths under the media origin', async () => {
  const { createImgproxyUrls } = await import('@/worker/imgproxy')
  // the docker-rewrite substring match maps this URL onto the minio origin, so
  // the short-circuit must NOT trust it. It falls through to the media-check
  // branch, which the fetch mock below answers not-media — that definitive
  // false returns before the snFetch fallback (which uses crossFetch, not
  // global.fetch) is ever reached, so no real call leaves this test.
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ isImage: false, isVideo: false })
  })

  const result = await createImgproxyUrls(4, '![img](https://stasher.news/uploads2/123)', {})

  expect(result).toEqual({})
})

it('keeps excluding external non-media hosts', async () => {
  const { createImgproxyUrls } = await import('@/worker/imgproxy')

  const result = await createImgproxyUrls(5, '[link](https://twitter.com/foo)', {})

  expect(result).toEqual({})
})

it('still passes known image hosts without a probe', async () => {
  const { createImgproxyUrls } = await import('@/worker/imgproxy')
  // getMetadata probes imgproxy for dimensions — mock fetch here so this test
  // is hermetic and order-independent (does not rely on an earlier test's
  // fetch spy persisting, which would otherwise hit the real imgproxy).
  jest.spyOn(global, 'fetch').mockResolvedValue({
    json: async () => ({ width: 100, height: 50, format: 'png', video_streams: [] })
  })

  const result = await createImgproxyUrls(6, '![img](https://i.imgur.com/abc.png)', {})

  expect(result['https://i.imgur.com/abc.png']['640w']).toMatch(/^\//)
})

it('flags video uploads as { video: true } without probing imgproxy or writing derivative keys', async () => {
  const { createImgproxyUrls } = await import('@/worker/imgproxy')
  const fetchMock = jest.spyOn(global, 'fetch')
  fetchMock.mockClear()

  const result = await createImgproxyUrls(7, '![v](https://stasher.news/uploads/4078)', {
    models: uploadModels({ 4078: 'video/mp4' })
  })

  // exact shape: no dimensions, no format, no Nw derivative keys
  expect(result['https://stasher.news/uploads/4078']).toEqual({ video: true })
  // neither the /info probe nor a media-check happened
  expect(fetchMock).not.toHaveBeenCalled()
})

// Stored content embeds raw MEDIA_URL_DOCKER values: http://minio:9000/uploads
// (long-standing, restored 2026-10-25) and http://media:9000/uploads (dev only,
// 2026-10-24..25). Both origins must keep classifying as internal whatever the
// current MEDIA_URL_DOCKER is — otherwise video uploads lose the video-flag
// skip and re-renders produce permanent-422 imgproxy derivatives.
it.each([
  ['http://media:9000/uploads', 'http://minio:9000/uploads/4079'],
  ['http://minio:9000/uploads', 'http://media:9000/uploads/4079']
])('with MEDIA_URL_DOCKER=%s still classifies stored %s as internal', async (mediaUrlDocker, storedUrl) => {
  process.env.MEDIA_URL_DOCKER = mediaUrlDocker
  try {
    const { createImgproxyUrls } = await import('@/worker/imgproxy')
    const fetchMock = jest.spyOn(global, 'fetch')
    fetchMock.mockClear()

    const result = await createImgproxyUrls(8, `![v](${storedUrl})`, {
      models: uploadModels({ 4079: 'video/mp4' })
    })

    expect(result[storedUrl]).toEqual({ video: true })
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
  }
})

it('still builds the full derivative ladder for image uploads', async () => {
  const { createImgproxyUrls } = await import('@/worker/imgproxy')
  jest.spyOn(global, 'fetch').mockResolvedValue({
    json: async () => ({ width: 640, height: 360, format: 'jpeg', video_streams: [] })
  })

  const result = await createImgproxyUrls(8, '![img](https://stasher.news/uploads/123)', {
    models: uploadModels({ 123: 'image/jpeg' })
  })

  expect(result['https://stasher.news/uploads/123'].dimensions).toEqual({ width: 640, height: 360 })
  for (const res of ['640w', '960w', '1280w', '1600w', '1920w', '2560w']) {
    expect(result['https://stasher.news/uploads/123'][res]).toMatch(/^\//)
  }
})

it('falls through to the probe pipeline when the upload row is missing', async () => {
  const { createImgproxyUrls } = await import('@/worker/imgproxy')
  jest.spyOn(global, 'fetch').mockResolvedValue({
    json: async () => ({ width: 100, height: 50, format: 'png', video_streams: [] })
  })

  const result = await createImgproxyUrls(9, '![img](https://stasher.news/uploads/9999)', {
    models: uploadModels({}) // row deleted (deleteUnusedImages sweep)
  })

  expect(result['https://stasher.news/uploads/9999']['640w']).toMatch(/^\//)
})
