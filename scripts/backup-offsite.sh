#!/usr/bin/env bash
# Daily offsite mirror to Backblaze B2 (bucket: stashernews-backups).
#
# VPS-ONLY by construction: refuses to run unless /etc/stashernews/secrets.env
# exists (a path that only exists on the production box) — a dev machine can
# never push to B2, intentionally.
#
# Retention model: every leg uses `rclone copy` (never sync/delete). The
# remote only accumulates, and the bucket's lifecycle rule (delete after 90
# days) is the single retention mechanism. This deliberately avoids ALL
# delete operations, because the bucket has Object Lock (14-day default
# retention) and delete attempts on locked files fail by design.
#
# rclone remotes required (configure once via `rclone config`; see the ops
# ops handoff):
#   b2-stasher — Backblaze B2, application key scoped to stashernews-backups
#   minio      — S3-compatible remote for the `media` endpoint (the name is a
#                legacy label from the MinIO era; the endpoint now serves
#                SeaweedFS behind the media proxy — http://localhost:4566,
#                path style, the machine's MEDIA_AWS_ACCESS_KEY_ID/
#                MEDIA_AWS_SECRET_ACCESS_KEY pair, the same creds the media
#                store's rendered s3.config carries)
#
# Legs:
#   1. GPG-encrypted DB dumps        $BACKUPS_DIR    -> backups/
#   2. GPG-encrypted master-key escrow $MASTERKEY_DIR -> masterkey/
#   3. SOPS-encrypted secrets.env    $SECRETS_FILE   -> secrets/
#   4. user-uploaded media           minio:$MEDIA_BUCKET -> media/
#
# WAL archiving stays on its own hourly job (scripts/backup-wal-offsite.sh).
#
# Recommended cron (root, on the VPS; 03:40 UTC — after the 03:00 dbBackup):
#   40 3 * * * /opt/stashernews/scripts/backup-offsite.sh >> /var/log/offsite-backup.log 2>&1
set -uo pipefail

B2_REMOTE="${B2_REMOTE:-b2-stasher}"
MEDIA_REMOTE="${MEDIA_REMOTE:-minio}"
MEDIA_BUCKET="${MEDIA_BUCKET:-uploads}"
BACKUPS_DIR="${BACKUPS_DIR:-/var/lib/docker/volumes/stashernews_backups/_data}"
MASTERKEY_DIR="${MASTERKEY_DIR:-/var/lib/docker/volumes/stashernews_masterkey_backups/_data}"
SECRETS_FILE="${SECRETS_FILE:-/etc/stashernews/secrets.env}"

BUCKET="${BUCKET:-stashernews-backups}"

fail=0

leg () {
  local label=$1
  shift
  echo "==> offsite: $label"
  if "$@"; then
    echo "==> offsite: $label OK"
  else
    echo "!! offsite: $label FAILED (continuing with remaining legs)" >&2
    fail=1
  fi
}

# --- VPS-only guard ---------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "offsite backup: must run as root (reads docker volume paths + /etc/stashernews)" >&2
  exit 1
fi
if [ ! -f "$SECRETS_FILE" ]; then
  echo "offsite backup: $SECRETS_FILE not found — this looks like a dev machine; refusing to run." >&2
  exit 1
fi

# --- alert wiring ------------------------------------------------------------
# notify() pages via ALERT_WEBHOOK_URL, which lives SOPS-encrypted in
# $SECRETS_FILE (decrypted into the app's env at boot by load-secrets.sh).
# Cron runs as root with an empty environment, so extract just this one key
# here; degrade silently (no sops, decryption failure) — the stderr line still
# lands in the cron log.
if [ -z "${ALERT_WEBHOOK_URL:-}" ] && command -v sops >/dev/null 2>&1; then
  SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/etc/stashernews/keys/age.agekey}"
  export SOPS_AGE_KEY_FILE
  ALERT_WEBHOOK_URL="$(sops -d --extract '["ALERT_WEBHOOK_URL"]' "$SECRETS_FILE" 2>/dev/null || true)"
fi

for remote in "$B2_REMOTE" "$MEDIA_REMOTE"; do
  if ! rclone listremotes 2>/dev/null | grep -q "^${remote}:$"; then
    echo "offsite backup: rclone remote '${remote}:' is not configured (see ops handoff)" >&2
    exit 1
  fi
done

# --- legs (isolated: one failure does not skip the others) ------------------
if [ -d "$BACKUPS_DIR" ]; then
  leg "DB dumps -> ${BUCKET}/backups/" \
    rclone copy "$BACKUPS_DIR" "${B2_REMOTE}:${BUCKET}/backups" --transfers 4
else
  echo "!! offsite: $BACKUPS_DIR missing — skipping DB dumps" >&2
  fail=1
fi

if [ -d "$MASTERKEY_DIR" ]; then
  leg "master-key escrow -> ${BUCKET}/masterkey/" \
    rclone copy "$MASTERKEY_DIR" "${B2_REMOTE}:${BUCKET}/masterkey" --transfers 4
else
  echo "!! offsite: $MASTERKEY_DIR missing — skipping master-key escrow" >&2
  fail=1
fi

leg "secrets.env -> ${BUCKET}/secrets/" \
  rclone copy "$SECRETS_FILE" "${B2_REMOTE}:${BUCKET}/secrets" --transfers 1

leg "media (${MEDIA_REMOTE}:${MEDIA_BUCKET}) -> ${BUCKET}/media/" \
  rclone copy "${MEDIA_REMOTE}:${MEDIA_BUCKET}" "${B2_REMOTE}:${BUCKET}/media" --transfers 4

# --- webhook notify (same Slack-default shape as lib/alert.js) ----------------
notify () {
  local level=$1 title=$2 body=$3
  echo "!! offsite backup: $title — $body" >&2
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -sf -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"[${level}] ${title}\n${body}\"}" \
      "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
}

# --- verification: bit-integrity of what just landed in B2 --------------------
# rclone check compares size + hash (B2 supplies hashes) local <-> remote for
# the backups leg — the small, high-value payload. --one-way: every local file
# must exist remotely and match. Mismatch means the offsite copy is NOT
# restorable as-is: page immediately.
# WARNING: --one-way requires every LOCAL file to exist remotely. Keep
# BACKUP_RETENTION_DAYS <= 90 (the B2 lifecycle) — if local retention ever
# exceeds the remote 90-day lifecycle, expired-remote files make this check
# fail nightly even though nothing is wrong.
if [ -d "$BACKUPS_DIR" ]; then
  if ! rclone check "$BACKUPS_DIR" "${B2_REMOTE}:${BUCKET}/backups" --one-way; then
    notify CRITICAL "offsite backup verification failed" "rclone check mismatch on ${BUCKET}/backups"
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  notify CRITICAL "offsite backup failed" "one or more legs failed — see the cron log for details"
  echo "!! offsite backup: one or more legs FAILED — check output above" >&2
  exit 1
fi
echo "==> offsite backup complete"
