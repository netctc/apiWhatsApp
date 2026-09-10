# Capacity baseline records

This document records repeatable engineering measurements produced by the repository capacity harness. These results are **not production throughput certifications**. GitHub-hosted runners have shared, variable infrastructure and the controlled Meta seam has materially different latency and rate limits from Meta Cloud API.

Use `docs/capacity-testing.md` for workload semantics, threshold selection and production-like test guidance.

## Profile A — GitHub-hosted baseline 001

Run identity:

```text
workflow: Capacity Profile
workflow run: 34532964416
workflow run number: 1
commit: e0e3a1f246a815870c02f7a0a838e1e33ef6c862
environment class: github-hosted-baseline
runner image: Ubuntu 24.04 / ubuntu-24.04 20260907.300.1
Node.js: 24.20.0
PostgreSQL: 17.11
Redis: 7.4.11
RabbitMQ: 4.3.5
artifact: capacity-profile-a-34532964416
artifact id: 10174308038
```

Workload:

```text
CAPACITY_MESSAGES=5000
CAPACITY_CONCURRENCY=100
CAPACITY_TARGET_RPS=0
CAPACITY_ACCEPT_P95_MS=3000
CAPACITY_ACCEPT_P99_MS=5000
CAPACITY_MAX_ERROR_RATE=0
CAPACITY_DRAIN_MAX_MS=300000
```

The current capacity integration fixture sends all attempts through the real Nest API, PostgreSQL Message + Outbox transaction, RabbitMQ, worker, Redis sender limiter and controlled local Meta HTTP seam. The fixture intentionally uses one tenant, one sender and one contact, so this run also exercises a hot sender/contact conversation path rather than distributing the 5,000 accepts across independent contacts.

Measured result:

```json
{
  "total": 5000,
  "concurrency": 100,
  "targetRatePerSecond": 0,
  "accepted": 5000,
  "errors": 0,
  "errorRate": 0,
  "acceptanceWallMs": 33390,
  "latencyMs": {
    "min": 155,
    "p50": 634,
    "p95": 868,
    "p99": 1038,
    "max": 1348
  },
  "drainMs": 43410,
  "acceptanceThroughputPerSecond": 149.74,
  "endToEndThroughputPerSecond": 65.09
}
```

Result: **PASS**.

Interpretation:

- all 5,000 requests were durably accepted with zero acceptance errors;
- p95 and p99 remained below the configured engineering gates;
- every accepted message drained to `SUBMITTED` within 43.41 seconds after the acceptance phase;
- provider call count matched accepted message count, so this run did not observe lost or duplicated provider submissions;
- the acceptance path sustained about 149.74 accepted requests/second on this runner for this workload shape;
- the complete acceptance + asynchronous drain path averaged about 65.09 submitted messages/second.

## Profile B — GitHub-hosted baseline 002

Run identity:

```text
workflow: Capacity Profile
workflow run: 34533728707
workflow run number: 2
commit: b47eb123faddc60bfec10d7301638ddf04e0f3f3
environment class: github-hosted-baseline
runner image: Ubuntu 24.04 / ubuntu-24.04 20260907.300.1
Node.js: 24.20.0
PostgreSQL: 17.11
Redis: 7.4.11
RabbitMQ: 4.3.5
artifact: capacity-profile-b-34533728707
artifact id: 10174734890
artifact digest: sha256:604455b585b6ba224783abb78efc5573fa4d0ac8e22d379f272aa3f60144ab26
```

Workload:

```text
CAPACITY_MESSAGES=25000
CAPACITY_CONCURRENCY=250
CAPACITY_TARGET_RPS=0
CAPACITY_ACCEPT_P95_MS=3000
CAPACITY_ACCEPT_P99_MS=5000
CAPACITY_MAX_ERROR_RATE=0
CAPACITY_DRAIN_MAX_MS=600000
```

Measured result:

```json
{
  "total": 25000,
  "concurrency": 250,
  "targetRatePerSecond": 0,
  "accepted": 25000,
  "errors": 0,
  "errorRate": 0,
  "acceptanceWallMs": 112372,
  "latencyMs": {
    "min": 147,
    "p50": 1088,
    "p95": 1323,
    "p99": 1521,
    "max": 2136
  },
  "drainMs": 192713,
  "acceptanceThroughputPerSecond": 222.48,
  "endToEndThroughputPerSecond": 81.93
}
```

Result: **PASS**.

Interpretation:

- all 25,000 requests were durably accepted with zero acceptance errors;
- p95 and p99 stayed well below the unchanged 3 s / 5 s engineering gates at 2.5x the Profile A concurrency;
- all accepted messages drained to `SUBMITTED` within 192.713 seconds after acceptance completed;
- provider call count again matched accepted message count;
- acceptance throughput increased from 149.74/s in Profile A to 222.48/s in Profile B;
- end-to-end throughput increased from 65.09/s to 81.93/s;
- p95 increased from 868 ms to 1,323 ms and p99 from 1,038 ms to 1,521 ms, remaining bounded rather than exhibiting an error/latency collapse.

The Redis service performed normal background persistence during this larger run; no capacity assertion or application error was triggered by it.

## Profile C execution boundary

The repository documents Profile C as 100,000 attempts at concurrency 500. It should not be treated as the next automatic GitHub-hosted baseline with the current in-process Jest harness.

Profile B required about 305 seconds inside the capacity test and achieved 81.93 messages/second end-to-end. A simple throughput projection at that measured rate puts 100,000 messages at roughly 1,220 seconds of end-to-end processing before setup/cleanup. The current capacity Jest test timeout is 660,000 ms, and the manual GitHub workflow timeout is 20 minutes.

Those limits mean a 100,000-message hosted run would be dominated by harness/runner timeout risk rather than being a clean capacity experiment. Profile C should therefore run on dedicated production-like infrastructure with an external or appropriately long-lived load generator, or the test harness must first be redesigned for long-running capacity experiments. Do not simply raise an assertion threshold and present a hosted run as production certification.

## Production interpretation boundary

Do not transpose Profile A or B throughput numbers directly into a production SLO. A production-like run must record API/worker replica sizing, PostgreSQL resources and pool limits, Redis and RabbitMQ topology, network latency, Meta latency/rate limits and the intended recipient/sender distribution.

Both recorded hosted baselines use one tenant, one sender and one contact. This deliberately exercises a hot sender/contact/conversation path, but it does not characterize throughput across many independent senders/recipients or Meta production quotas.

## Reproducible workflow

`.github/workflows/capacity-profile.yml` provides a manually dispatched capacity run. Profile A values are its defaults; the same bounded inputs can be used for Profile B and paced soak shapes. Profile C should follow the execution boundary above rather than being launched casually on shared hosted infrastructure.

Each run uploads:

```text
capacity-profile.log
capacity-profile.json
capacity-environment.json
```

The environment metadata labels GitHub-hosted executions as `github-hosted-baseline` to prevent them from being mistaken for production certification evidence.
