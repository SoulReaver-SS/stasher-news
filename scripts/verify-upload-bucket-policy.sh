#!/usr/bin/env bash
# Asserts the uploads bucket refuses anonymous listing (ListBucket) while
# still serving objects (GetObject). Usage:
#   ./scripts/verify-upload-bucket-policy.sh [base_url] [existing_key]
# Defaults: http://media:9000  (run inside the compose network, e.g.
#   docker run --rm --network stashernews_default curlimages/curl ...)
set -euo pipefail
BASE="${1:-http://minio:9000}"
BUCKET="${NEXT_PUBLIC_AWS_UPLOAD_BUCKET:-uploads}"

list_code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$BUCKET?max-keys=1")
if [ "$list_code" != "403" ]; then
  echo "FAIL: anonymous listing returned $list_code (expected 403)"
  exit 1
fi
echo "PASS: anonymous listing blocked (403)"

if [ "${2:-}" != "" ]; then
  get_code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$BUCKET/$2")
  if [ "$get_code" != "200" ]; then
    echo "FAIL: anonymous GET of $2 returned $get_code (expected 200)"
    exit 1
  fi
  echo "PASS: anonymous GET served (200)"
fi
