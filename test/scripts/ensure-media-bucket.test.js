/* eslint-env jest */

// ensure-media-bucket creates the media bucket on the self-hosted S3 store if
// (and only if) it is missing. Pinned behaviors: create ONLY on a definitive
// NotFound from HeadBucket; fail closed on auth/network errors; always
// re-verify after creating; use the app's dedicated MEDIA_AWS_* credentials
// with the docker endpoint origin (path-style) — never the ambient AWS chain
// (the 2026-09-13 incident: the default chain silently signed with backup
// provider keys).

const { buildClient, ensureBucket, resolveTarget } = require('../../scripts/ensure-media-bucket.cjs')

function fakeClient (headResults, created) {
  const calls = []
  return {
    calls,
    async send (command) {
      calls.push(command.constructor.name)
      if (command.constructor.name === 'HeadBucketCommand') {
        const result = headResults.shift()
        if (result === 200) return { $metadata: { httpStatusCode: 200 } }
        const err = new Error(result === 404 ? 'not found' : 'boom')
        err.name = result === 404 ? 'NotFound' : 'ServiceError'
        err.$metadata = { httpStatusCode: result }
        throw err
      }
      if (command.constructor.name === 'CreateBucketCommand') {
        created.push(command.input.Bucket)
        return { $metadata: { httpStatusCode: 200 } }
      }
      throw new Error('unexpected command')
    }
  }
}

const ENV = {
  MEDIA_URL_DOCKER: 'http://media:9000/uploads',
  MEDIA_AWS_ACCESS_KEY_ID: 'media-root-key',
  MEDIA_AWS_SECRET_ACCESS_KEY: 'media-root-secret',
  NEXT_PUBLIC_AWS_UPLOAD_BUCKET: 'uploads'
}

describe('resolveTarget', () => {
  test('derives origin, bucket and credentials from the app env', () => {
    const t = resolveTarget(ENV)
    expect(t.endpoint).toBe('http://media:9000')
    expect(t.bucket).toBe('uploads')
    expect(t.credentials).toEqual({ accessKeyId: 'media-root-key', secretAccessKey: 'media-root-secret' })
  })

  test('fails closed without dedicated media credentials (no AWS_* fallback)', () => {
    expect(() => resolveTarget({ ...ENV, MEDIA_AWS_ACCESS_KEY_ID: undefined, MEDIA_AWS_SECRET_ACCESS_KEY: undefined, AWS_ACCESS_KEY_ID: 'ambient', AWS_SECRET_ACCESS_KEY: 'ambient' })).toThrow(/MEDIA_AWS_/)
  })

  test('fails without an endpoint (never target real AWS from a provisioning script)', () => {
    expect(() => resolveTarget({ ...ENV, MEDIA_URL_DOCKER: '' })).toThrow(/MEDIA_URL_DOCKER|endpoint/i)
  })
})

describe('ensureBucket', () => {
  test('exists: no create, exit success', async () => {
    const client = fakeClient([200])
    await expect(ensureBucket({ client, bucket: 'uploads' })).resolves.toBe(false)
    expect(client.calls).toEqual(['HeadBucketCommand'])
  })

  test('missing: create once, then re-verify', async () => {
    const created = []
    const client = fakeClient([404, 200], created)
    await expect(ensureBucket({ client, bucket: 'uploads' })).resolves.toBe(true)
    expect(created).toEqual(['uploads'])
    expect(client.calls).toEqual(['HeadBucketCommand', 'CreateBucketCommand', 'HeadBucketCommand'])
  })

  test('auth/network error: fails closed, never creates', async () => {
    const created = []
    const client = fakeClient([403], created)
    await expect(ensureBucket({ client, bucket: 'uploads' })).rejects.toThrow(/403/)
    expect(created).toEqual([])
    expect(client.calls).toEqual(['HeadBucketCommand'])
  })

  test('create-then-verify-fails: surfaces the error instead of reporting success', async () => {
    const created = []
    const client = fakeClient([404, 500], created)
    await expect(ensureBucket({ client, bucket: 'uploads' })).rejects.toThrow(/verify/i)
    expect(created).toEqual(['uploads'])
  })
})

describe('buildClient', () => {
  test('path-style client aimed at the docker endpoint', async () => {
    const client = buildClient({ endpoint: 'http://media:9000', credentials: { accessKeyId: 'k', secretAccessKey: 's' } })
    expect(await client.config.forcePathStyle).toBe(true)
    expect(await client.config.region()).toBe('us-east-1')
    const endpoint = await client.config.endpoint()
    expect(endpoint.hostname).toBe('media')
    expect(endpoint.port).toBe(9000)
  })
})
