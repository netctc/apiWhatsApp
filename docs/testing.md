# Testing runbook

Release 0.14.0 adds a reproducible real-infrastructure integration gate in addition to the existing unit, security, and Docker gates.

## Test layers

### Unit tests

```bash
npm test
```

Unit tests are isolated from external infrastructure and remain the fastest feedback loop for domain rules, authorization, retry decisions, routing, campaign lifecycle, metrics, and trace correlation.

### Integration and load smoke

```bash
npm run test:integration
```

The integration suite requires real:

- PostgreSQL;
- Redis;
- RabbitMQ.

It starts the Nest API and outbound worker in the same test process and starts local controlled HTTP Meta Cloud API mocks on ephemeral loopback ports.

The integration test applies the real production Prisma migration history to the configured database before the suite is executed in CI.

## CI infrastructure

The `integration` GitHub Actions job starts service containers:

```text
PostgreSQL 17
Redis 7
RabbitMQ 4
```

The job then runs:

```bash
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run test:integration
```

Docker image construction does not run unless build/unit, runtime-security, and integration all pass.

## Meta test seam

Normal runtime behavior continues to use:

```text
https://graph.facebook.com
```

For controlled tests, the clients also understand:

```text
META_GRAPH_API_BASE_URL
```

Security constraints:

- an HTTP override is accepted only under `NODE_ENV=test`;
- production/non-test environments require HTTPS;
- embedded URL credentials are rejected;
- query strings and fragments in the configured base URL are rejected;
- leaving the variable unset always uses the official Graph host.

The integration suites use HTTP servers bound to `127.0.0.1` and therefore never contact Meta externally.

## Core end-to-end scenario

The primary integration test validates:

```text
authenticated HTTP POST /messages
  -> contact/service-window policy
  -> sender resolution
  -> Message + OutboxEvent transaction
  -> outbox poller
  -> RabbitMQ traffic queue
  -> outbound worker
  -> Redis sender limiter
  -> HTTP request to local Meta mock
  -> persisted provider message ID
  -> Message SUBMITTED
```

It also repeats the same HTTP request with the same `Idempotency-Key` and requires:

- the same internal message ID;
- a single logical Message record;
- exactly one Meta mock delivery;
- the original trace/request carrier preserved in the outbox event.

## Concurrent load smoke

CI sends a concurrent burst after the single-message scenario.

Defaults:

```text
INTEGRATION_BURST_MESSAGES=50
INTEGRATION_ACCEPT_P95_MS=3000
```

The test requires:

- zero transport errors;
- every request returns HTTP 202;
- every accepted message has a unique internal ID;
- p95 HTTP acceptance latency remains below the configured smoke threshold;
- every accepted message eventually reaches `SUBMITTED`;
- Meta mock call count exactly equals the number of accepted logical messages.

The API test server is explicitly bound once before concurrent Supertest requests. Every burst request is awaited to completion even when one fails, preventing test-harness socket races or teardown races from being mistaken for application defects.

## Meta provider failure injection

The real-infrastructure gate also runs deterministic provider-failure scenarios through the production API, transactional outbox, RabbitMQ topology, outbound worker, Redis rate limiter, PostgreSQL persistence, and Meta HTTP client. Only the external Meta endpoint is replaced by the controlled loopback seam.

The transient scenario injects:

```text
HTTP 429 -> retry queue -> HTTP 503 -> retry queue -> HTTP 200
```

It requires the logical message to reach `SUBMITTED`, records three provider attempts, verifies three `PROCESSING` lifecycle entries, and proves that the real RabbitMQ retry queues redeliver the same logical message before eventual success. Retry delays are shortened only inside this integration suite so CI remains fast.

The permanent-error scenario injects a non-retryable Meta HTTP 400 response and requires:

- one provider attempt only;
- persisted `FAILED` state and Meta error code;
- no provider message ID;
- publication to the real transactional dead-letter queue;
- a DLQ payload containing the expected message ID, traffic class, failure reason, and failure timestamp.

These tests verify the runtime retry/DLQ contract rather than only testing retry classification in isolation.

## What the CI smoke test is not

The 50-message burst is a regression/smoke gate, **not a production capacity certification**.

Do not use the CI p95 result to claim a production throughput SLA. GitHub-hosted runners have variable CPU/network scheduling and run all dependencies on one runner VM.

For release/capacity certification use a dedicated environment with:

- production-equivalent managed PostgreSQL/Redis/RabbitMQ or the intended cloud services;
- separate API and worker replicas;
- the intended ingress/load balancer;
- production-equivalent database connection limits;
- realistic sender/rate-limit configuration;
- a controlled Meta-compatible HTTP test double or approved sandbox;
- Prometheus scraping and resource monitoring.

Recommended staged profiles:

```text
Profile A: 100 concurrent accepts / 5,000 messages
Profile B: 250 concurrent accepts / 25,000 messages
Profile C: 500 concurrent accepts / 100,000 messages
Soak:      sustained workload for 2-4 hours
```

Measure at minimum:

- API p50/p95/p99 acceptance latency;
- HTTP error rate;
- outbox pending/due/oldest age;
- RabbitMQ queue depth and redeliveries;
- worker throughput by traffic class;
- Redis rate-limit latency/errors;
- PostgreSQL CPU/connections/locks/query latency;
- time from `QUEUED` to `SUBMITTED`;
- duplicate logical sends;
- process memory/CPU;
- webhook processing lag under concurrent outbound load.

## Remaining failure-injection scenarios

The gate now proves both the normal durable path and Meta transient/permanent failure handling. Further failure-injection suites should be added incrementally for:

- RabbitMQ unavailable during outbox publication;
- Redis unavailable during outbound rate limiting;
- worker termination while a processing lease is active;
- API termination after DB commit but before outbox publish;
- duplicated RabbitMQ deliveries;
- delayed/out-of-order delivery webhooks;
- webhook burst while campaigns are running.

## Local execution example

Start infrastructure:

```bash
docker compose up -d postgres redis rabbitmq
```

Use a disposable integration database instead of your normal development database, then set:

```text
NODE_ENV=test
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/api_whatsapp_integration?schema=public
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://guest:guest@localhost:5672
```

Create the integration database if needed, apply migrations, and run:

```bash
npm run prisma:generate
npm run prisma:deploy
npm run test:integration
```

Do not point integration tests at a database containing valuable development or production data. The suite creates and removes its own tenant-scoped fixtures but is intended for a disposable test database.
