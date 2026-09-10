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

Do not transpose these throughput numbers directly into a production SLO. A production-like run must record API/worker replica sizing, PostgreSQL resources and pool limits, Redis and RabbitMQ topology, network latency, Meta latency/rate limits and the intended recipient/sender distribution.

## Reproducible workflow

`.github/workflows/capacity-profile.yml` provides a manually dispatched capacity run. Profile A values are its defaults, while the same workflow inputs can be used for the documented Profile B, Profile C and paced soak shapes.

Each run uploads:

```text
capacity-profile.log
capacity-profile.json
capacity-environment.json
```

The environment metadata labels GitHub-hosted executions as `github-hosted-baseline` to prevent them from being mistaken for production certification evidence.
