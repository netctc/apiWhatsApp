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

## Bounded retry exhaustion

A separate real-infrastructure scenario keeps returning retryable HTTP 503 responses until the configured retry policy is exhausted. With two short test-only retry delays, the suite requires exactly three provider attempts: the initial delivery plus two retries.

After the final retryable failure it requires:

- persisted `FAILED` state;
- error code `RETRY_EXHAUSTED`;
- no provider message ID;
- exactly three `PROCESSING` lifecycle entries;
- publication to the real transactional DLQ;
- no fourth provider attempt after the final retry queue has drained.

This proves retryable provider failures remain bounded and cannot loop indefinitely.

## Duplicate RabbitMQ delivery

The integration gate deliberately publishes a duplicate outbound queue job while the original logical message is already leased by a worker and blocked inside the Meta test double.

The duplicate must not obtain a second processing lease. It is routed through the bounded retry path while the original delivery remains in `PROCESSING`; after the original provider request succeeds, the delayed duplicate is consumed and acknowledged as already submitted.

The suite requires:

- one logical `Message` record;
- one successful processing claim and `attemptCount=1`;
- one `PROCESSING` lifecycle entry;
- exactly one Meta provider request;
- a provider message ID from that single request;
- the duplicate retry queue to drain without another provider call.

This exercises at-least-once RabbitMQ delivery behavior and proves an active processing lease prevents concurrent duplicate provider sends.

## Out-of-order delivery webhooks

Delivery status events are append-only evidence, but the authoritative `Message.status` must progress monotonically. A delayed `sent` event is therefore still stored in `MessageStatusEvent` even when the message is already `delivered` or `read`, while the current message state is not downgraded.

Status progression is decided while holding a PostgreSQL row lock on the target message. The webhook status service locates the message by provider message ID inside the transaction with `FOR UPDATE`, then evaluates the status rank against the state observed after the lock is acquired. This is required for multi-replica deployments: two webhook processors may claim independent webhook events concurrently even though each individual processor handles its own batch serially.

The real-database integration coverage uses independent Prisma clients to exercise sequential and concurrent `read` plus delayed `sent` transitions. It requires:

- the final authoritative state to remain `READ`;
- the provider `readAt` timestamp to remain authoritative;
- both `SENT` and `READ` status events to be retained as history;
- repeated concurrent transition pairs to remain monotonic across independent database clients.

This closes the race where both processors could previously read the same pre-transition status before entering their separate transactions and a slower `sent` transaction could overwrite a committed `read` state.

## RabbitMQ outage during outbox publication

The transactional outbox gate deliberately starts the API with the configured RabbitMQ endpoint replaced by an unreachable loopback port. The HTTP message request must still return `202` because the `Message` and `OutboxEvent` are committed atomically in PostgreSQL before publication is attempted.

While RabbitMQ is unavailable the suite requires:

- the accepted message to remain durably `QUEUED`;
- no provider message ID and no Meta provider call;
- the outbox event to remain `publishedAt = null`;
- the outbox processing lease to be released after the failed publish attempt;
- the connection failure to be retained in `lastError`;
- `nextAttemptAt` to move forward according to the bounded outbox backoff policy.

The test then restores the real CI RabbitMQ URL and starts the real outbound worker. Without rewriting the message or outbox row, the normal outbox poller must retry publication, receive publisher confirmation, clear the previous error, mark the event published, and allow the worker to submit the original logical message exactly once to the Meta test double.

This proves temporary RabbitMQ unavailability does not lose accepted work and does not require application-level client replay after the HTTP request has already committed.

## Redis outage during outbound rate limiting

The rate-limiter recovery gate places a local TCP fault proxy between the outbound worker and the real CI Redis service. The proxy initially rejects Redis connections while PostgreSQL and RabbitMQ remain healthy, so the normal outbox path can publish and the worker can claim the message before failing at the distributed sender-capacity reservation step.

During the Redis outage the suite requires:

- the worker to release the message processing lease and return the message to `QUEUED`;
- persisted error code `RATE_LIMITER_UNAVAILABLE`;
- exactly one failed processing claim before recovery;
- zero Meta provider calls while sender capacity cannot be reserved;
- the failure to enter the normal bounded RabbitMQ retry path.

The proxy is then switched to forward TCP traffic to the real Redis service. The same persistent ioredis client must reconnect through the proxy before the queued retry fires. The retry must claim the same logical message, reserve sender capacity, submit it once to the Meta test double, clear the transient error fields, and finish at `SUBMITTED`.

This proves a temporary Redis outage blocks provider traffic safely, preserves the logical message for retry, and recovers without restarting the worker or duplicating a Meta submission.

## API restart before outbox publication

The process-recovery gate starts an API instance with a deliberately long outbox polling interval, lets its initial empty bootstrap flush finish, and then accepts a message. The HTTP response is returned only after PostgreSQL has atomically committed the `Message` and `OutboxEvent`, but the test stops that API instance before its next outbox poll.

Before the accepting instance stops, the suite requires:

- the message to be durably `QUEUED`;
- the associated outbox event to exist with `publishedAt = null`;
- `attempts = 0`, proving publication has not started;
- no outbox processing lease;
- zero Meta provider calls.

A fresh API instance is then started against the same database with the normal fast test polling interval, together with the real worker. Its bootstrap outbox flush must discover and publish the pre-existing event, after which the normal RabbitMQ -> Redis -> Meta path submits the original logical message exactly once.

The final state requires one outbox publication attempt, `SUBMITTED`, one provider message ID, and exactly one Meta call. This proves accepted work survives the lifetime of the API process even when the process stops in the post-commit/pre-publish window.

## Stale worker processing lease recovery

The worker-recovery gate reproduces the durable state left by a worker interruption after a message has been claimed but before its RabbitMQ delivery is acknowledged: the message is persisted as `PROCESSING`, has an active `processingLeaseUntil`, and the corresponding queue job is available for redelivery.

The test first lets the normal outbox publisher place the job on real RabbitMQ without starting a worker. It then records a simulated crashed-worker claim in PostgreSQL with `attemptCount=1` and a bounded active lease before starting a replacement worker.

The replacement worker must consume the redelivered job but fail closed while the previous processing lease is still active. It schedules the same logical job through the configured retry queue and must not call Meta. The retry delay is intentionally longer than the simulated stale lease, so the next delivery occurs only after the lease is reclaimable.

The suite requires:

- the first replacement-worker delivery to leave the message at `PROCESSING` with `attemptCount=1`;
- the real RabbitMQ retry queue to contain the deferred job while the stale lease is active;
- zero Meta provider requests before lease expiry;
- the later delivery to reclaim the same logical message and increment `attemptCount` to 2;
- the recovered message to reach `SUBMITTED` with the processing lease cleared;
- exactly one Meta provider request across the simulated crash and recovery path.

This CI scenario validates the persisted crash-recovery invariant without terminating a Jest-owned process mid-request. Deployment-level chaos testing should still include a real container or process kill to validate supervisor and RabbitMQ connection behavior around the same durable lease contract.

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

The gate now proves the normal durable path, Meta transient/permanent handling, bounded retry exhaustion, duplicate RabbitMQ delivery protection, monotonic delayed/out-of-order delivery status handling, recovery from RabbitMQ unavailability during outbox publication, Redis rate-limiter recovery, recovery across the API post-commit/pre-publish restart window, and the stale processing-lease recovery invariant. The remaining CI resilience scenario is:

- webhook burst while campaigns are running.

A literal worker/container kill should additionally be exercised in deployment-level chaos testing, outside the in-process Jest harness.

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
