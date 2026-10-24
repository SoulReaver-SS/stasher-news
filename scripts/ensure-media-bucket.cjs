#!/usr/bin/env node
// Create the media uploads bucket on the self-hosted S3 store if it is
// missing. Idempotent, fail-closed, no MinIO client image:
//
//   docker exec -w /app app node scripts/ensure-media-bucket.cjs
//
// (on the VPS, run it loader-wrapped so MEDIA_* env is present). Reads the
// same env the app's media client uses — MEDIA_URL_DOCKER origin and the
// dedicated MEDIA_AWS_* credentials — and never the ambient AWS chain.

'use strict'

const { S3Client, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3')

function resolveTarget (env) {
  const accessKeyId = env.MEDIA_AWS_ACCESS_KEY_ID
  const secretAccessKey = env.MEDIA_AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('ensure-media-bucket: MEDIA_AWS_ACCESS_KEY_ID and MEDIA_AWS_SECRET_ACCESS_KEY must both be set (ambient AWS_* credentials are deliberately not used)')
  }
  const raw = env.MEDIA_URL_DOCKER
  if (!raw) {
    throw new Error('ensure-media-bucket: MEDIA_URL_DOCKER must be set (refusing to provision against real AWS S3)')
  }
  const endpoint = new URL(raw).origin
  const bucket = env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET || 'uploads'
  return { endpoint, bucket, credentials: { accessKeyId, secretAccessKey } }
}

function buildClient ({ endpoint, credentials }) {
  return new S3Client({
    region: 'us-east-1',
    forcePathStyle: true,
    endpoint,
    credentials
  })
}

// Resolves true when the bucket was created, false when it already existed.
async function ensureBucket ({ client, bucket }) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    return false
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode
    const isMissing = status === 404 || err.name === 'NotFound'
    if (!isMissing) {
      throw new Error(`ensure-media-bucket: cannot confirm bucket state (HTTP ${status || 'error'}); refusing to create — ${err.message}`)
    }
  }

  await client.send(new CreateBucketCommand({ Bucket: bucket }))

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (err) {
    throw new Error(`ensure-media-bucket: bucket did not verify after create — ${err.message}`)
  }
  return true
}

module.exports = { resolveTarget, buildClient, ensureBucket }

if (require.main === module) {
  try {
    const target = resolveTarget(process.env)
    const client = buildClient(target)
    ensureBucket({ client, bucket: target.bucket })
      .then(created => {
        console.log(created ? `media bucket '${target.bucket}' created` : `media bucket '${target.bucket}' already exists`)
        process.exit(0)
      })
      .catch(err => {
        console.error(err instanceof Error ? err.message : 'ensure-media-bucket: failed')
        process.exit(1)
      })
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'ensure-media-bucket: failed')
    process.exit(1)
  }
}
