# External capacity runner

The external capacity runner drives a deployed API over HTTP without starting NestJS, the worker, PostgreSQL, Redis, or RabbitMQ inside the load-generator process. It is intended for Profile C, paced soak runs, and production-like capacity environments where a single Jest process or a GitHub-hosted job would become the test limitation.

It is still an engineering test tool, not a production-traffic tool. Use a dedicated test tenant, safe provider seam or consented test recipients, and production-like infrastructure that can be observed independently.

## Command

```bash
npm run test:capacity:external
```

The command runs `scripts/external-capacity-runner.mjs` directly with Node.js. No build step and no database credentials are required on the load-generator host.

## Required target preparation

Before running external load, prepare an isolated tenant with:

- an API key containing `messages:write` and `operations:read`;
- one or more active WhatsApp senders with valid credentials for the intended test provider;
- each configured recipient represented by a tenant contact whose free-form service window is open;
- no pending outbox work and no messages currently in `CREATED`, `QUEUED`, or `PROCESSING`;
- no unrelated inbound or outbound traffic for the tenant during the run.

The runner takes a tenant-scoped `/api/v1/operations/snapshot` baseline and refuses to start when pending outbox work or in-flight messages already exist. At completion, the tenant message-count delta must exactly match the number of accepted messages. Extra tenant traffic therefore fails the isolation gate instead of silently contaminating the result.

`EXTERNAL_CAPACITY_CONFIRM_ISOLATED_TEST_ENV=true` is mandatory. The runner will not generate traffic without this explicit confirmation.

Do not point the runner at a live customer tenant or arbitrary real phone numbers. Capacity traffic can result in real WhatsApp sends when the target deployment uses Meta Cloud API rather than a controlled provider seam.

## Required environment

```text
EXTERNAL_CAPACITY_CONFIRM_ISOLATED_TEST_ENV=true
EXTERNAL_CAPACITY_BASE_URL=https://capacity-api.example.test
EXTERNAL_CAPACITY_API_KEY=<test-tenant-api-key>
EXTERNAL_CAPACITY_RECIPIENTS=+15550000001,+15550000002
```

`EXTERNAL_CAPACITY_BASE_URL` is the service origin. The runner calls:

```text
POST /api/v1/messages
GET  /api/v1/operations/snapshot
```

`EXTERNAL_CAPACITY_RECIPIENTS` is a comma-separated list of E.164 recipients. Requests are distributed round-robin across the list. Recipient values, API keys, sender IDs, payload bodies, message IDs, and idempotency keys are not written to the result report.

An explicit sender can be selected with:

```text
EXTERNAL_CAPACITY_SENDER_ID=<tenant-scoped-sender-uuid>
```

When omitted, the API's active default sender is used.

## Workload configuration

```text
EXTERNAL_CAPACITY_PROFILE_NAME                  default: profile-c-external
EXTERNAL_CAPACITY_MESSAGES                      default: 100000, range: 1..1000000
EXTERNAL_CAPACITY_DURATION_SECONDS              default: 0, range: 0..21600
EXTERNAL_CAPACITY_MAX_MESSAGES                  default: 1000000, range: 1..1000000
EXTERNAL_CAPACITY_CONCURRENCY                   default: 500, range: 1..active attempt ceiling
EXTERNAL_CAPACITY_TARGET_RPS                    default: 0, range: 0..10000
EXTERNAL_CAPACITY_MIN_START_RATE_RATIO          default: 0.95, range: 0..1
EXTERNAL_CAPACITY_MAX_OUTBOX_PENDING            optional non-negative integer
EXTERNAL_CAPACITY_MAX_OUTBOX_OLDEST_AGE_SECONDS optional non-negative integer
EXTERNAL_CAPACITY_ACCEPT_P95_MS                 default: 3000
EXTERNAL_CAPACITY_ACCEPT_P99_MS                 default: 5000
EXTERNAL_CAPACITY_MAX_ERROR_RATE                default: 0
EXTERNAL_CAPACITY_DRAIN_MAX_MS                  default: 1800000, maximum: 24 hours
EXTERNAL_CAPACITY_SNAPSHOT_INTERVAL_MS          default: 5000, range: 250..60000
EXTERNAL_CAPACITY_REQUEST_TIMEOUT_MS            default: 10000, range: 100..120000
```

`EXTERNAL_CAPACITY_DURATION_SECONDS=0` keeps the historical fixed-message contract. In fixed mode the runner attempts exactly `EXTERNAL_CAPACITY_MESSAGES`, subject to the hard safety rule that `EXTERNAL_CAPACITY_MESSAGES <= EXTERNAL_CAPACITY_MAX_MESSAGES`.

A positive duration enables duration-bounded soak mode. Duration mode requires `EXTERNAL_CAPACITY_TARGET_RPS > 0`, stops scheduling new requests at the configured deadline, and lets already-started requests finish. The maximum number of attempts is always capped by `EXTERNAL_CAPACITY_MAX_MESSAGES`.

The runner validates the requested duration, target rate, minimum start-rate ratio, and message ceiling before contacting the target. A configuration whose safety ceiling cannot possibly satisfy the requested minimum start-rate ratio is rejected before the baseline snapshot.

### Monotonic no-catch-up pacing

Positive target rates use a serialized monotonic start gate. Each next allowed start is derived from the previous actual start. If the load generator pauses or becomes CPU-starved, missed pacing slots are discarded rather than recovered as a burst. Concurrency remains the hard in-flight ceiling.

This differs intentionally from absolute-slot scheduling. A delayed runner therefore reports an achieved start-rate shortfall instead of hiding the load-generator bottleneck behind catch-up traffic.

### Start-rate gate

Duration mode reports:

```text
attempted
achievedStartRatePerSecond
achievedStartRateRatio
```

The ratio is:

```text
actual attempts / (duration seconds * requested target RPS)
```

The run fails when `achievedStartRateRatio < EXTERNAL_CAPACITY_MIN_START_RATE_RATIO`. The default minimum is `0.95`.

### Optional queue-health gates

When configured, the runner also fails if any sampled operations snapshot exceeds:

```text
EXTERNAL_CAPACITY_MAX_OUTBOX_PENDING
EXTERNAL_CAPACITY_MAX_OUTBOX_OLDEST_AGE_SECONDS
```

These gates apply to the maximum observed values over acceptance and drain. Unset variables disable the corresponding gate.

## Profile C example

Profile C remains a fixed-message run and should execute from a host independent from the API/worker replicas.

```bash
EXTERNAL_CAPACITY_CONFIRM_ISOLATED_TEST_ENV=true \
EXTERNAL_CAPACITY_PROFILE_NAME=profile-c \
EXTERNAL_CAPACITY_BASE_URL=https://capacity-api.example.test \
EXTERNAL_CAPACITY_API_KEY="$CAPACITY_API_KEY" \
EXTERNAL_CAPACITY_RECIPIENTS=+15550000001 \
EXTERNAL_CAPACITY_MESSAGES=100000 \
EXTERNAL_CAPACITY_MAX_MESSAGES=100000 \
EXTERNAL_CAPACITY_CONCURRENCY=500 \
EXTERNAL_CAPACITY_TARGET_RPS=0 \
EXTERNAL_CAPACITY_ACCEPT_P95_MS=3000 \
EXTERNAL_CAPACITY_ACCEPT_P99_MS=5000 \
EXTERNAL_CAPACITY_MAX_ERROR_RATE=0 \
EXTERNAL_CAPACITY_DRAIN_MAX_MS=1800000 \
npm run test:capacity:external | tee external-profile-c.log
```

Do not reuse the GitHub-hosted Profile A/B numbers as Profile C pass criteria. Establish the target environment's CPU, memory, connection, queue-age, and provider-rate ceilings before the run.

## Duration-bounded soak example

The documented 50 RPS / 30-minute shape no longer needs the operator to precompute an exact message count:

```bash
EXTERNAL_CAPACITY_CONFIRM_ISOLATED_TEST_ENV=true \
EXTERNAL_CAPACITY_PROFILE_NAME=soak-50rps-30m \
EXTERNAL_CAPACITY_BASE_URL=https://capacity-api.example.test \
EXTERNAL_CAPACITY_API_KEY="$CAPACITY_API_KEY" \
EXTERNAL_CAPACITY_RECIPIENTS=+15550000001,+15550000002 \
EXTERNAL_CAPACITY_DURATION_SECONDS=1800 \
EXTERNAL_CAPACITY_MAX_MESSAGES=100000 \
EXTERNAL_CAPACITY_CONCURRENCY=100 \
EXTERNAL_CAPACITY_TARGET_RPS=50 \
EXTERNAL_CAPACITY_MIN_START_RATE_RATIO=0.95 \
EXTERNAL_CAPACITY_MAX_OUTBOX_PENDING=5000 \
EXTERNAL_CAPACITY_MAX_OUTBOX_OLDEST_AGE_SECONDS=120 \
EXTERNAL_CAPACITY_ACCEPT_P95_MS=3000 \
EXTERNAL_CAPACITY_ACCEPT_P99_MS=5000 \
EXTERNAL_CAPACITY_MAX_ERROR_RATE=0.001 \
EXTERNAL_CAPACITY_DRAIN_MAX_MS=300000 \
npm run test:capacity:external | tee external-soak-50rps-30m.log
```

For multi-hour tests the duration can be increased up to six hours (`21600` seconds), while the explicit maximum-message ceiling remains mandatory protection against an unexpectedly large request budget.

## What is measured

The runner records the synchronous HTTP acceptance phase separately from asynchronous drain:

- configured execution mode and safety ceiling;
- actual attempt count;
- achieved start rate and start-rate ratio for duration runs;
- accepted count and acceptance error rate;
- HTTP status distribution and transport-error count;
- accepted message-ID uniqueness without logging the IDs;
- acceptance min, p50, p95, p99, and max latency;
- acceptance and end-to-end throughput;
- maximum observed tenant outbox pending, due, leased, and oldest-pending age;
- configured optional outbox health ceilings;
- final tenant message-status deltas;
- snapshot sampling errors;
- post-acceptance drain duration.

A message is considered successfully drained when it is in `SUBMITTED`, `SENT`, `DELIVERED`, or `READ`. Treating those states as one successful set prevents delivery webhooks from making an already-submitted message appear to move backward during a long external run.

Drain succeeds only when:

1. the tenant message-count delta equals the accepted-message count;
2. the successful-status delta equals the accepted-message count;
3. no new `FAILED`, `CANCELLED`, or `EXPIRED` messages remain from the run;
4. no run messages remain `CREATED`, `QUEUED`, or `PROCESSING`;
5. the tenant outbox returns to zero pending work.

If unrelated tenant traffic causes the total message delta to exceed the accepted count, the isolation gate fails immediately.

## Result format

A completed run writes one bounded JSON line:

```text
[external-capacity] { ... }
```

The process exits with status `1` when any configured gate fails. Redirect or `tee` the line into the capacity evidence bundle together with deployment and infrastructure telemetry.

The report intentionally excludes secrets and business identifiers. Never add raw API keys, access tokens, phone numbers, message bodies, message IDs, idempotency keys, or provider payloads to capacity artifacts.

## Infrastructure evidence

For Profile C and soak evidence, record at minimum:

- API and worker replica counts, CPU/memory requests and limits;
- PostgreSQL instance size, connection-pool limits, CPU, IO, lock waits, and storage latency;
- RabbitMQ topology, queue depth/age, memory/disk alarms, and publish-confirm latency;
- Redis topology, latency, errors, memory, and persistence mode;
- Meta/provider latency, rate limits, retry responses, and test-account constraints;
- network path and load-generator host characteristics;
- application metrics, operations snapshots, and OTLP traces for the same time window.

A passing runner report with infrastructure saturation or continuously increasing queue age is not a production-capacity pass.
