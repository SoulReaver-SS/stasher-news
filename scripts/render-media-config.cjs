#!/usr/bin/env node
// Render the SeaweedFS s3.config.json for this deployment from the app's
// dedicated media credentials (MEDIA_AWS_*). Core Node only; no network, no DB.
//
// Usage: node scripts/render-media-config.cjs <destination>
//   MEDIA_AWS_ACCESS_KEY_ID / MEDIA_AWS_SECRET_ACCESS_KEY — admin identity
//   NEXT_PUBLIC_AWS_UPLOAD_BUCKET                          — bucket to scope anonymous reads
//
// The destination directory must be private (mode 0700); the file is written
// owner-only (0600) via a same-directory temp file + atomic rename, so a
// concurrent reader never observes a partial file. Errors are generic by
// design: they name the offending field, never its value.

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

function buildConfig (env) {
  const accessKeyId = env.MEDIA_AWS_ACCESS_KEY_ID
  const secretAccessKey = env.MEDIA_AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('media config: MEDIA_AWS_ACCESS_KEY_ID and MEDIA_AWS_SECRET_ACCESS_KEY must both be set')
  }
  const bucket = env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET
  if (!bucket || !BUCKET_PATTERN.test(bucket)) {
    throw new Error('media config: NEXT_PUBLIC_AWS_UPLOAD_BUCKET is missing or not a valid S3 bucket name')
  }

  return {
    identities: [
      {
        name: 'admin',
        credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }],
        actions: ['Admin', 'Read', 'Write', 'List', 'Tagging']
      },
      {
        name: 'anonymous',
        actions: [`Read:${bucket}`]
      }
    ]
  }
}

function assertProtectedDir (dir) {
  let mode
  try {
    mode = fs.statSync(dir).mode & 0o777
  } catch {
    throw new Error('media config: destination directory must exist and be private (0700)')
  }
  if ((mode & 0o077) !== 0) {
    throw new Error('media config: destination directory must be private (0700)')
  }
}

function writeConfig (destination, config) {
  const dir = path.dirname(destination)
  assertProtectedDir(dir)

  const serialized = JSON.stringify(config, (key, value) => {
    if (typeof value === 'bigint') throw new Error('media config: config contains a non-serializable value')
    return value
  }, 2)

  const temp = path.join(dir, `.${path.basename(destination)}.tmp`)
  try {
    const fd = fs.openSync(temp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, serialized + '\n')
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, destination)
  } catch (err) {
    try { fs.unlinkSync(temp) } catch {}
    throw err
  }
}

module.exports = { buildConfig, writeConfig }

if (require.main === module) {
  const destination = process.argv[2]
  if (!destination) {
    console.error('media config: usage: render-media-config.cjs <destination>')
    process.exit(1)
  }
  try {
    writeConfig(destination, buildConfig(process.env))
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'media config: failed')
    process.exit(1)
  }
}
