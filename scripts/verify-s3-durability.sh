#!/usr/bin/env bash
#
# Verify the media S3 backend survives container restarts.
#
# Regression test for the 2026-08-16 incident class: localstack community
# edition stores S3 objects in container-ephemeral storage (persistence is a
# paid-tier feature), so every `aws` container restart silently wiped ALL
# user uploads. The S3 backend is SeaweedFS (since 2026-10-24; previously
# MinIO) with its data dir on an external docker volume, which must survive
# `docker compose restart` and recreation.
#
# Phases:
#   1. presigned-POST upload through the same AWS SDK code path the app uses
#      (in the app container, so SDK + env are the real ones)
#   2. anonymous GET of the object (public-read contract for <img> tags)
#   3. restart the S3 backend container
#   4. GET again — the object must still exist
#
# Usage: ./scripts/verify-s3-durability.sh [service-name]
#   service-name defaults to `media` (the media stack): the DURABLE component
#   is the `seaweedfs` backend, so that is what gets restarted — restarting
#   only the stateless `media` proxy would false-PASS phase 4 without ever
#   testing persistence. Pass `aws` to test the old localstack backend
#   (expected to FAIL phase 4).

set -euo pipefail

SERVICE="${1:-media}"
case "$SERVICE" in
  media)    RESTART_TARGET="seaweedfs" ;;
  aws)      RESTART_TARGET="aws" ;;
  *) echo "FAIL: unknown service '$SERVICE' (expected 'media' or 'aws')" >&2; exit 1 ;;
esac
KEY="durability-probe-$(date +%s)"
PROBE_FILE="$(mktemp)"
trap 'rm -f "$PROBE_FILE"' EXIT
echo "durability probe ${KEY}" > "$PROBE_FILE"
SIZE=$(wc -c < "$PROBE_FILE")

if ! docker ps --format '{{.Names}}' | grep -q '^app$'; then
  echo "FAIL: app container is not running (start the stack first)" >&2
  exit 1
fi

presign_and_post() {
  # Runs inside the app container: presign with the same client shape as
  # api/s3/index.js (path-style, docker-internal endpoint, MEDIA_AWS_* media
  # credentials with legacy AWS_* fallback — never the default chain),
  # POST the multipart form exactly like the browser does, then print the
  # presigned URL used. Exit code non-zero on any failure.
  docker exec -i -u apprunner -w /app app node - "$KEY" "$SIZE" <<'EOF'
const fs = require('fs')
const { S3Client } = require('@aws-sdk/client-s3')
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post')

const key = process.argv[2]
const size = parseInt(process.argv[3], 10)

const endpoint = new URL(process.env.MEDIA_URL_DOCKER).origin
const Bucket = process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET || 'uploads'
const accessKeyId = process.env.MEDIA_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID
const secretAccessKey = process.env.MEDIA_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY
if (!accessKeyId || !secretAccessKey) {
  throw new Error('missing media S3 credentials: set MEDIA_AWS_ACCESS_KEY_ID/MEDIA_AWS_SECRET_ACCESS_KEY (or the legacy AWS_* pair)')
}
const client = new S3Client({
  region: 'us-east-1',
  forcePathStyle: true,
  endpoint,
  credentials: { accessKeyId, secretAccessKey }
})

async function main () {
  const signed = await createPresignedPost(client, {
    Bucket,
    Key: key,
    Expires: 300,
    Conditions: [
      { 'Content-Type': 'text/plain' },
      { 'Cache-Control': 'max-age=31536000' },
      { acl: 'public-read' },
      ['content-length-range', size, size]
    ],
    Fields: { key }
  })
  const form = new FormData()
  for (const [k, v] of Object.entries(signed.fields)) form.append(k, v)
  form.append('Content-Type', 'text/plain')
  form.append('Cache-Control', 'max-age=31536000')
  form.append('acl', 'public-read')
  form.append('file', new Blob([`durability probe ${key}\n`], { type: 'text/plain' }))
  const res = await fetch(signed.url, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`POST failed: ${res.status} ${await res.text()}`)
  console.log(`presign+POST ok -> ${signed.url}`)
}

main().catch(err => { console.error(err); process.exit(1) })
EOF
}

anon_get() {
  # Anonymous GET via the docker-internal path (imgproxy/capture contract).
  # Prints "ok <bytes>" or exits non-zero.
  docker exec -i -u apprunner -w /app app node - "$KEY" <<'EOF'
const key = process.argv[2]
const url = `${process.env.MEDIA_URL_DOCKER}/${key}`
fetch(url).then(async res => {
  const body = res.ok ? await res.text() : ''
  if (!res.ok || !body.includes('durability probe')) {
    throw new Error(`GET ${url} failed: ${res.status} ${body.slice(0, 120)}`)
  }
  console.log(`anon GET ok (${body.trim().length} bytes)`)
}).catch(err => { console.error(err); process.exit(1) })
EOF
}

echo "== phase 1: presigned POST through the app's SDK path =="
presign_and_post

echo "== phase 2: anonymous GET (public-read contract) =="
anon_get

echo "== phase 3: restarting ${SERVICE} (durable component: ${RESTART_TARGET}) =="
docker compose -p stashernews restart "$RESTART_TARGET" >/dev/null

echo "== phase 4: anonymous GET after restart (durability contract) =="
# Bounded readiness wait: the media backend can take well over the old fixed
# 8s to come back (SeaweedFS master raft re-election measured ~60s after an
# unclean stop). Success requires the REAL object GET, not just a listener.
ready=0
for _ in $(seq 1 60); do
  if anon_get; then ready=1; break; fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: ${SERVICE} (restarted: ${RESTART_TARGET}) did not serve the object within 120s" >&2
  exit 1
fi

echo
echo "PASS: ${SERVICE} preserves S3 objects across a container restart"
