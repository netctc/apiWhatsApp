# Capacity and soak testing

This repository includes an end-to-end capacity harness for measuring the synchronous API acceptance path and the asynchronous outbound drain path separately.

The harness is a repeatable engineering gate. It is **not** a production throughput certification: results depend on runner CPU, PostgreSQL, Redis, RabbitMQ, network topology, Meta latency/rate limits, replica counts, connection-pool sizing, and deployment-specific quotas.

## What the harness exercises

`test/integration/capacity-profile.integration.ts` runs the real application components against real PostgreSQL, Redis, and RabbitMQ plus a controlled Meta HTTP seam:

```text
concurrent/paced HTTP message accepts
  -> validation + tenant/contact/sender policy
  -> Message + OutboxEvent PostgreSQL transaction
  -> bounded acceptance latency measurement
  -> outbox publisher
  -> RabbitMQ
  -> outbound worker
  -> Redis rate limiter
  -> Meta HTTP seam
  -> SUBMITTED drain completion
```

The test measures two different phases:

1. **acceptance** — how quickly the API durably accepts work;
2. **drain** — how long accepted work takes to reach `SUBMITTED` after the acceptance phase completes.

These must not be collapsed into one latency number. A healthy asynchronous system can accept quickly while accumulating a provider/worker backlog, so both gates are required.

## CI baseline

The normal pull-request integration workflow keeps the historical 50-message all-at-once smoke and additionally runs the dedicated capacity profile with:

```text
CAPACITY_MESSAGES=40
CAPACITY_CONCURRENCY=10
CAPACITY_TARGET_RPS=0
CAPACITY_ACCEPT_P95_MS=3000
CAPACITY_ACCEPT_P99_MS=5000
CAPACITY_MAX_ERROR_RATE=0
CAPACITY_DRAIN_MAX_MS=45000
```

This deliberately small profile is a regression gate suitable for shared CI. It is not a sizing benchmark.

## Dedicated command

When PostgreSQL, Redis, and RabbitMQ are already available and `DATABASE_URL`, `REDIS_URL`, and `RABBITMQ_URL` point to the intended isolated test environment:

```bash
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run test:capacity
```

For the repository-local development stack:

```bash
cp .env.example .env
docker compose up -d postgres redis rabbitmq
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run test:capacity
```

Do not run large profiles against a shared developer database or shared RabbitMQ namespace. Use dedicated infrastructure with production-like resource limits.

## Configuration

### Workload shape

```text
CAPACITY_MESSAGES
```

Total HTTP message-creation attempts. Test-enforced range: `1..100000`.

```text
CAPACITY_CONCURRENCY
```

Maximum number of HTTP acceptance requests in flight at once. Range: `1..CAPACITY_MESSAGES`.

This is intentionally independent from total volume. A 100,000-message run at concurrency 50 is a different workload from 100,000 requests launched simultaneously.

```text
CAPACITY_TARGET_RPS
```

Optional target request-start rate. Range: `0..10000` requests/second.

`0` disables pacing: each worker starts its next request as soon as its previous request finishes. A positive value schedules starts at approximately `1 / RPS` intervals while still enforcing the concurrency ceiling.

Pacing is useful for sustained/soak-style runs. If the system cannot keep up with the configured rate, concurrency remains the safety bound rather than allowing an unbounded local request queue.

### Acceptance gates

```text
CAPACITY_ACCEPT_P95_MS
CAPACITY_ACCEPT_P99_MS
```

Maximum nearest-rank p95 and p99 HTTP attempt latency. The harness also reports min, p50, and max but does not gate them separately.

```text
CAPACITY_MAX_ERROR_RATE
```

Maximum fraction of attempts that may fail transport or not return an accepted message (`HTTP 202` plus internal message ID). Range: `0..1`.

The CI baseline uses `0`.

### Drain gate

```text
CAPACITY_DRAIN_MAX_MS
```

Maximum time, measured after the acceptance phase finishes, for every accepted message ID to reach `SUBMITTED`. Range: `1000..600000` milliseconds.

If the deadline expires, the test reports the durable message-status distribution rather than request payloads or customer identifiers.

## Capacity report

Every successful profile writes one bounded JSON line:

```text
[capacity-profile] { ... }
```

Fields include:

```text
total
concurrency
targetRatePerSecond
accepted
errors
errorRate
acceptanceWallMs
latencyMs.min
latencyMs.p50
latencyMs.p95
latencyMs.p99
latencyMs.max
drainMs
acceptanceThroughputPerSecond
endToEndThroughputPerSecond
```

The report deliberately excludes tenant IDs, phone numbers, message IDs, idempotency keys, payload text, sender IDs, provider IDs, tokens, and raw errors.

Archive this single line together with deployment/resource metadata when comparing capacity runs.

## Suggested staged profiles

These are starting shapes for a dedicated test environment, not universal pass/fail promises. Keep thresholds appropriate to the hardware and target service-level objectives.

### Profile A — bounded burst

Purpose: establish a repeatable single-node or small-cluster baseline.

```bash
CAPACITY_MESSAGES=5000 \
CAPACITY_CONCURRENCY=100 \
CAPACITY_TARGET_RPS=0 \
CAPACITY_MAX_ERROR_RATE=0 \
npm run test:capacity
```

Record API CPU/RSS, PostgreSQL connections/CPU/IO, RabbitMQ queue depth, Redis latency, acceptance p95/p99, and drain time.

### Profile B — high-concurrency burst

Purpose: expose connection-pool, broker-channel, lock-contention, and event-loop limits.

```bash
CAPACITY_MESSAGES=25000 \
CAPACITY_CONCURRENCY=250 \
CAPACITY_TARGET_RPS=0 \
CAPACITY_MAX_ERROR_RATE=0 \
npm run test:capacity
```

Do not advance to the next profile if p99, error rate, queue age, memory, or database saturation is already outside the intended operating envelope.

### Profile C — large finite burst

Purpose: validate backlog behavior and recovery after a much larger accepted workload.

```bash
CAPACITY_MESSAGES=100000 \
CAPACITY_CONCURRENCY=500 \
CAPACITY_TARGET_RPS=0 \
CAPACITY_DRAIN_MAX_MS=600000 \
npm run test:capacity
```

`CAPACITY_MESSAGES` is hard-capped at 100,000 by the repository-local harness. Larger production-like Profile C runs should use the external runner, where `EXTERNAL_CAPACITY_MAX_MESSAGES` provides a separate explicit safety ceiling.

### Duration-bounded soak run

Purpose: find memory growth, connection leaks, queue-age drift, retries, sustained downstream bottlenecks, and load-generator saturation.

Short local soak-style runs can still use `CAPACITY_MESSAGES` plus `CAPACITY_TARGET_RPS`, but long certification-oriented runs should use the external duration mode against a deployed isolated environment:

```bash
EXTERNAL_CAPACITY_CONFIRM_ISOLATED_TEST_ENV=true \
EXTERNAL_CAPACITY_DURATION_SECONDS=1800 \
EXTERNAL_CAPACITY_MAX_MESSAGES=100000 \
EXTERNAL_CAPACITY_CONCURRENCY=100 \
EXTERNAL_CAPACITY_TARGET_RPS=50 \
EXTERNAL_CAPACITY_MIN_START_RATE_RATIO=0.95 \
EXTERNAL_CAPACITY_MAX_OUTBOX_PENDING=5000 \
EXTERNAL_CAPACITY_MAX_OUTBOX_OLDEST_AGE_SECONDS=120 \
EXTERNAL_CAPACITY_MAX_ERROR_RATE=0.001 \
EXTERNAL_CAPACITY_DRAIN_MAX_MS=300000 \
npm run test:capacity:external
```

The external runner stops scheduling at the wall-clock deadline, never catches up missed start slots with a recovery burst, and reports the achieved/requested start-rate ratio. This makes runner saturation visible instead of disguising it as target-system capacity.

Duration mode is capped at six hours and one million attempts. `EXTERNAL_CAPACITY_MAX_MESSAGES` is a hard preflight ceiling in both fixed and duration modes. Optional outbox pending and oldest-age gates make sustained backlog growth an explicit failure condition instead of merely evidence to inspect later.

See `docs/external-capacity-runner.md` and `docs/external-capacity-workflow.md` for the deployed-run contract and manual GitHub workflow.

## How to choose thresholds

Do not copy CI thresholds blindly into production SLOs. Establish thresholds from the target architecture and business requirement, then keep them stable enough to detect regression.

At minimum define:

- acceptance p95 and p99 objective;
- maximum acceptable HTTP error rate;
- maximum queue/outbox oldest-age during the run;
- maximum post-burst drain time;
- target provider submissions/second;
- minimum achieved request-start rate for paced soak tests;
- CPU/memory saturation ceiling per API and worker replica;
- PostgreSQL connection, lock, CPU, and IO ceilings;
- RabbitMQ queue depth/age and publish-confirm latency ceilings;
- Redis latency/error ceilings.

A capacity result is meaningful only with the infrastructure dimensions recorded beside it.

## Failure-injection follow-up

After a clean baseline, repeat the same workload while deliberately introducing one failure at a time in a controlled environment:

- pause/restart RabbitMQ during accepted backlog;
- restart one API replica while requests continue;
- restart one worker replica with leased messages in flight;
- temporarily make Redis unavailable;
- delay/return retryable failures from the Meta seam;
- introduce PostgreSQL connection pressure;
- reduce worker/provider capacity and verify queue age/drain recovery.

For each experiment verify durable work is recovered, duplicates remain bounded by the provider/idempotency contract, telemetry does not become a business dependency, and the backlog drains after the dependency recovers.

Do not perform destructive failure injection against production customer traffic.

## Interpreting results

A passing HTTP p95 with an ever-growing outbox/RabbitMQ backlog is **not** a passing capacity result. Likewise, a fast provider drain does not compensate for an API acceptance path that violates latency/error objectives.

Use together:

- the capacity JSON report;
- `/api/metrics` request latency and durable outbox gauges;
- `/api/v1/operations/snapshot` for tenant-scoped operational evidence;
- RabbitMQ queue metrics;
- PostgreSQL/Redis infrastructure metrics;
- OTLP traces when enabled.

The engineering objective is a stable operating envelope with headroom, not the largest number that can be reached once.
