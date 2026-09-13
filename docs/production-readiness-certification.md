# Production readiness certification

The production-readiness certification workflow provides a repeatable, read-only release gate for a deployed production-like apiWhatsApp environment. It does not deploy infrastructure, run migrations, send WhatsApp messages, or generate customer traffic.

## What it verifies

A certification run checks the deployed API in this order:

1. `GET /api/health/live`
   - HTTP 200;
   - `status=ok`;
   - exact application semantic version;
   - optional exact deployment revision.
2. `GET /api/health/ready`
   - HTTP 200;
   - `status=ready`;
   - PostgreSQL, Redis, RabbitMQ, and configured media storage report `up`;
   - total readiness request latency stays below the configured ceiling.
3. `GET /api/v1/operations/snapshot`
   - authenticated with a tenant API key carrying `operations:read`;
   - outbox pending, due, error-bearing rows, and oldest-pending age stay within configured ceilings;
   - optional inbox response-SLA backlog gates are satisfied.

The runner emits one bounded JSON report prefixed with `[production-certification]`. Target URLs and API keys are intentionally excluded.

## Build identity

`/api/health/live` preserves its existing liveness fields and also returns the application version:

```json
{
  "status": "ok",
  "version": "0.18.0",
  "revision": "fc15a222",
  "uptimeSeconds": 120,
  "timestamp": "2026-09-13T00:00:00.000Z"
}
```

`revision` is optional. Set `APP_REVISION` at deployment time to a stable image, Git commit, or release identifier. Only values matching `[A-Za-z0-9._-]{1,64}` are exposed. Unsafe values are ignored rather than reflected through the public liveness endpoint.

The version always comes from `package.json` and is the same value used by Swagger and the application user agent.

## Runner configuration

Required environment variables:

```text
CERTIFICATION_CONFIRM_PRODUCTION_LIKE_ENV=true
CERTIFICATION_BASE_URL=https://staging.example.com
CERTIFICATION_API_KEY=<tenant key with operations:read>
```

The explicit confirmation is evaluated before any target request is made.

Optional identity controls:

```text
CERTIFICATION_EXPECTED_VERSION=0.18.0
CERTIFICATION_EXPECTED_REVISION=fc15a222
```

When `CERTIFICATION_EXPECTED_VERSION` is blank or unset, the runner uses the repository `package.json` version. The revision gate is disabled when its value is blank.

Transport and latency controls:

```text
CERTIFICATION_REQUIRE_HTTPS=true
CERTIFICATION_REQUEST_TIMEOUT_MS=5000
CERTIFICATION_MAX_READY_MS=3000
```

HTTPS is required by default. `CERTIFICATION_REQUIRE_HTTPS=false` exists for local/integration test targets only.

Queue-health controls:

```text
CERTIFICATION_MAX_OUTBOX_PENDING=0
CERTIFICATION_MAX_OUTBOX_DUE=0
CERTIFICATION_MAX_OUTBOX_WITH_ERRORS=0
CERTIFICATION_MAX_OUTBOX_OLDEST_AGE_SECONDS=60
```

Optional inbox response-SLA gates:

```text
CERTIFICATION_MAX_INBOX_OVERDUE_UNESCALATED=
CERTIFICATION_MAX_INBOX_ESCALATED_UNRESOLVED=
```

Blank values disable those optional gates. For a release freeze window, set them to the operational ceiling approved for the target tenant.

## Local invocation

The runner is pure Node.js and does not require dependency installation:

```bash
CERTIFICATION_CONFIRM_PRODUCTION_LIKE_ENV=true \
CERTIFICATION_BASE_URL=https://staging.example.com \
CERTIFICATION_API_KEY='...' \
CERTIFICATION_EXPECTED_VERSION=0.18.0 \
CERTIFICATION_EXPECTED_REVISION=fc15a222 \
npm run certify:production
```

A passing run exits `0`; any failed gate or invalid configuration exits `1`.

## Manual GitHub workflow

Run **Production Readiness Certification** from GitHub Actions. Select a GitHub Environment that contains these secrets:

```text
CERTIFICATION_BASE_URL
CERTIFICATION_API_KEY
```

The workflow requires the `confirm_production_like_env` checkbox. It exposes only non-secret thresholds and identity expectations as workflow inputs.

The artifact `production-readiness-certification-<run id>` contains:

- `certification.json`: sanitized runner result and individual gate decisions;
- `environment.json`: repository commit, GitHub run id, selected environment name, expected identity, and configured non-secret ceilings.

The target URL and API key are not written to either artifact. Evidence retention is 90 days.

## Recommended release-candidate sequence

Use certification after the candidate image has been deployed to an isolated staging or production-like environment:

1. Deploy the exact candidate image with `APP_REVISION` set to the immutable image/revision identifier.
2. Apply migrations through the normal deployment process; certification never mutates the database.
3. Wait for the API and workers to become stable.
4. Run Production Readiness Certification with exact version and revision gates.
5. Run the external duration-bounded capacity/soak workflow against an isolated non-customer tenant when load certification is required.
6. Review Prometheus alerts, traces, queue depth, PostgreSQL capacity, Redis/RabbitMQ health, and provider-side limits.
7. Preserve certification and soak artifacts with the release record.
8. Promote only when release-owner operational checks and rollback readiness are also approved.

A green certification run proves the deployed build identity, dependency readiness, and configured tenant backlog gates at the time of the check. It is not a substitute for infrastructure sizing, cost validation, Meta account/throughput verification, backup/restore testing, alert routing, or rollback drills.

## Security properties

- The runner performs GET requests only.
- Confirmation is fail-closed before network access.
- HTTPS is fail-closed by default.
- API keys are used only in the `X-API-Key` request header for the operations snapshot.
- Target URL, API key, payloads, message IDs, and customer identifiers are not included in certification reports.
- The public liveness endpoint exposes only semantic version and an optional bounded revision identifier.
