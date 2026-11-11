#!/usr/bin/env bash
# Deploy a tagged OrderGuard release to the VPS staging slot.
# Usage (as root): deploy-release.sh <git-tag-or-sha>
# Rollback: deploy-release.sh <previous-sha>  (release dir is reused if present)
set -euo pipefail

REPO="${ORDERGUARD_REPO:-/root/d-fixer-orderguard}"
BASE="${ORDERGUARD_STAGING_BASE:-/opt/orderguard-staging}"
ENV_FILE="${ORDERGUARD_STAGING_ENV:-/etc/orderguard/staging.env}"
HOST="${ORDERGUARD_STAGING_HOST:-staging-orderguard.202-10-34-141.nip.io}"
NODE_BIN="${ORDERGUARD_NODE_BIN:-/opt/node24/bin}"
REF="${1:-}"
if [ -z "$REF" ]; then
  echo "Usage: $0 <git-tag-or-sha>" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Jalankan sebagai root (sudo)." >&2
  exit 1
fi

SHA=$(runuser -u dfixer-admin -- git -C "$REPO" rev-parse --short "${REF}^{commit}")
REL="$BASE/releases/$SHA"
PREVIOUS=$(readlink -f "$BASE/current" 2>/dev/null || true)
TAG_NAME=$(runuser -u dfixer-admin -- git -C "$REPO" describe --tags --exact-match "$SHA" 2>/dev/null || echo "$REF")
LOG="/var/log/orderguard-staging-deploy.log"

log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

log "deploy start ref=$REF commit=$SHA previous=${PREVIOUS:-none}"

if [ ! -d "$REL" ]; then
  install -d -o orderguard -g orderguard -m 750 "$REL"
  git -C "$REPO" archive "$SHA" | tar -x -C "$REL"
  chown -R orderguard:orderguard "$REL"
  runuser -u orderguard -- env HOME="$BASE" PATH="$NODE_BIN:/usr/bin:/bin" \
    npm --prefix "$REL" ci --omit=dev --no-audit --no-fund >>"$LOG" 2>&1
  chown -R orderguard:orderguard "$REL/node_modules"
  chmod -R g-w,o-rwx "$REL"
else
  log "release dir sudah ada, memakai ulang $REL"
fi

ln -sfn "$REL" "$BASE/current"
chown -h orderguard:orderguard "$BASE/current"
sed -i '/^ORDERGUARD_RELEASE=/d' "$ENV_FILE"
printf 'ORDERGUARD_RELEASE=%s\n' "$TAG_NAME" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"

systemctl restart orderguard-staging.service
READY=0
for _ in $(seq 1 150); do
  if curl -fsS --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/ready" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.2
done

if [ "$READY" -ne 1 ]; then
  log "ERROR readiness gagal untuk $SHA"
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    log "rollback otomatis ke $PREVIOUS"
    ln -sfn "$PREVIOUS" "$BASE/current"
    systemctl restart orderguard-staging.service
  fi
  exit 1
fi

log "deploy success commit=$SHA tag=$TAG_NAME"
curl -fsS --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/health" | tee -a "$LOG"
echo
