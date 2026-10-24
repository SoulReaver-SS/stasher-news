#!/bin/sh
# SeaweedFS backend entrypoint (stashernews media store).
#
# Fail closed on a config that cannot authenticate anything: the file must
# exist, be nonempty, carry at least one credentialed identity, and carry the
# anonymous identity (the store serves public reads by design — a config
# without it is not the intended shape and must not boot silently). The
# renderer (scripts/render-media-config.cjs) produces exactly this shape; the
# gate below is the last line of defense against a hand-made or mangled
# config, demonstrated to otherwise boot "healthy" while denying every
# operation (review finding, 2026-10-24).
#
# The config is staged read-only-mountable source -> private copy (0600,
# owned by the runtime user), because the runtime user cannot read a
# root-owned bind mount and the source mount itself stays untouched.
set -eu

SRC="${CONFIG_SRC:-/run/seaweedfs-src/s3.config.json}"
DST="${CONFIG_DST:-/run/seaweedfs/s3.config.json}"

if [ ! -s "$SRC" ]; then
  echo "seaweedfs: s3 config missing or empty at $SRC (render it with scripts/render-media-config.cjs before up)" >&2
  exit 1
fi

# Shape gate: substring checks, not full JSON parsing (the image has no JSON
# tooling; the renderer's tests own the exact shape). A config with no
# "identities"/"credentials" content would boot into deny-everything; one
# without the "anonymous" identity would silently break public reads.
if ! grep -q '"identities"' "$SRC" || ! grep -q '"credentials"' "$SRC" || ! grep -q '"accessKey"' "$SRC" || ! grep -q '"secretKey"' "$SRC"; then
  echo "seaweedfs: config missing required identities/credentials — refusing to boot" >&2
  exit 1
fi
if ! grep -q '"anonymous"' "$SRC"; then
  echo "seaweedfs: config missing the anonymous identity — refusing to boot" >&2
  exit 1
fi

mkdir -p "$(dirname "$DST")"
install -m 0600 -o seaweed -g seaweed "$SRC" "$DST"

# First start on a fresh volume: give the runtime user its data dir.
chown -R seaweed:seaweed /data

exec /sbin/su-exec seaweed /usr/bin/weed -logtostderr=true server \
  -dir=/data \
  -volume.max=0 \
  -master.volumeSizeLimitMB=1024 \
  -filer \
  -s3 \
  -s3.port=8333 \
  -s3.config="$DST" \
  -s3.iam=false \
  -s3.port.iceberg=0 \
  -s3.port.lance=0 \
  -master.telemetry=false \
  -s3.allowedOrigins=http://localhost:3000,https://stasher.news \
  "$@"
