#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-}"
EXPECTED_VERSION="${2:-}"
EXPECTED_REVISION="${3:-}"
EXPECTED_SOURCE="${4:-}"

if [[ -z "$IMAGE" || -z "$EXPECTED_VERSION" || -z "$EXPECTED_REVISION" || -z "$EXPECTED_SOURCE" ]]; then
  echo "usage: $0 <image> <version> <revision> <source-url>" >&2
  exit 2
fi

if [[ ! "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "expected revision must be a full lowercase 40-character Git SHA" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

DB_SECRET_MARKER="db-password-marker-never-log"
REDIS_SECRET_MARKER="redis-password-marker-never-log"
RABBIT_SECRET_MARKER="rabbit-password-marker-never-log"
API_KEY_SECRET_MARKER="api-key-secret-marker-never-log"
WEBHOOK_SECRET_MARKER="webhook-secret-marker-never-log"
META_SECRET_MARKER="meta-secret-marker-never-log"
METRICS_SECRET_MARKER="metrics-secret-marker-never-log"

SENSITIVE_MARKERS=(
  "$DB_SECRET_MARKER"
  "$REDIS_SECRET_MARKER"
  "$RABBIT_SECRET_MARKER"
  "$API_KEY_SECRET_MARKER"
  "$WEBHOOK_SECRET_MARKER"
  "$META_SECRET_MARKER"
  "$METRICS_SECRET_MARKER"
)

fail() {
  echo "[docker-production-config-smoke] $1" >&2
  exit 1
}

print_sanitized_log() {
  local log_file="$1"
  local sanitized="$TMP_DIR/sanitized.log"
  cp "$log_file" "$sanitized"
  local marker
  for marker in "${SENSITIVE_MARKERS[@]}"; do
    sed -i "s/${marker}/[REDACTED_TEST_MARKER]/g" "$sanitized"
  done
  echo "[docker-production-config-smoke] sanitized container output follows:" >&2
  tail -n 80 "$sanitized" >&2
}

assert_no_sensitive_markers() {
  local log_file="$1"
  local marker
  for marker in "${SENSITIVE_MARKERS[@]}"; do
    if grep -Fq "$marker" "$log_file"; then
      fail "captured container output leaked a deterministic sensitive marker"
    fi
  done
}

assert_image_identity() {
  local actual_version actual_revision actual_source baked_revision
  actual_version="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$IMAGE")"
  actual_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$IMAGE")"
  actual_source="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "$IMAGE")"
  baked_revision="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" | sed -n 's/^APP_REVISION=//p' | tail -n 1)"

  [[ "$actual_version" == "$EXPECTED_VERSION" ]] || fail "OCI version label does not match the expected application version"
  [[ "$actual_revision" == "$EXPECTED_REVISION" ]] || fail "OCI revision label does not match the exact CI commit"
  [[ "$actual_source" == "$EXPECTED_SOURCE" ]] || fail "OCI source label does not match the repository URL"
  [[ "$baked_revision" == "$EXPECTED_REVISION" ]] || fail "baked APP_REVISION does not match the exact CI commit"
}

run_expected_validation_failure() {
  local profile="$1"
  local expected_variable="$2"
  local log_file="$3"
  shift 3

  local command=()
  if [[ "$profile" == "worker" ]]; then
    command=(node dist/worker.js)
  fi

  set +e
  timeout --kill-after=2s 15s docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --env NO_COLOR=1 \
    --env FORCE_COLOR=0 \
    "$@" \
    "$IMAGE" \
    "${command[@]}" >"$log_file" 2>&1
  local status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    print_sanitized_log "$log_file"
    fail "$profile container unexpectedly started successfully"
  fi
  if [[ $status -eq 124 || $status -eq 137 ]]; then
    print_sanitized_log "$log_file"
    fail "$profile container timed out instead of failing during configuration bootstrap"
  fi

  assert_no_sensitive_markers "$log_file"

  if ! grep -Fq "Production configuration validation failed (${profile})" "$log_file"; then
    print_sanitized_log "$log_file"
    fail "$profile container did not fail through production configuration validation"
  fi
  if ! grep -Fq "${expected_variable}:" "$log_file"; then
    print_sanitized_log "$log_file"
    fail "$profile container validation did not identify ${expected_variable}"
  fi
}

assert_image_identity

COMMON_ENV=(
  --env "NODE_ENV=production"
  --env "DATABASE_URL=postgresql://api:${DB_SECRET_MARKER}@database.invalid:5432/api_whatsapp"
  --env "REDIS_URL=redis://:${REDIS_SECRET_MARKER}@redis.invalid:6379"
  --env "RABBITMQ_URL=amqp://api:${RABBIT_SECRET_MARKER}@rabbit.invalid:5672"
  --env "META_GRAPH_API_VERSION=v24.0"
)

run_expected_validation_failure \
  "api" \
  "METRICS_BEARER_TOKEN" \
  "$TMP_DIR/api.log" \
  "${COMMON_ENV[@]}" \
  --env "API_KEY_HASH_SECRET=${API_KEY_SECRET_MARKER}-0123456789abcdef0123456789" \
  --env "META_WEBHOOK_VERIFY_TOKEN=${WEBHOOK_SECRET_MARKER}-0123456789" \
  --env "META_APP_SECRET=${META_SECRET_MARKER}-0123456789" \
  --env "METRICS_BEARER_TOKEN=${METRICS_SECRET_MARKER}" \
  --env "MEDIA_BINARY_STORAGE_MODE=disabled" \
  --env "MEDIA_MALWARE_SCAN_MODE=disabled"

run_expected_validation_failure \
  "worker" \
  "APP_REVISION" \
  "$TMP_DIR/worker.log" \
  "${COMMON_ENV[@]}" \
  --env "APP_REVISION=invalid-release-revision"

echo "[docker-production-config-smoke] image identity and API/worker fail-closed checks passed"
