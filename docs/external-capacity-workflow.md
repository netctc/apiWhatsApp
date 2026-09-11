# External capacity GitHub workflow

The `External Capacity Profile` workflow runs the standalone HTTP capacity generator against an already deployed, isolated test environment. It is intended for Profile C and paced soak runs that are too long or too environment-specific for the repository-local Jest capacity harness.

The workflow does not deploy the API and does not connect directly to PostgreSQL, Redis, or RabbitMQ. It only calls the public application endpoints used by `scripts/external-capacity-runner.mjs`.

## Safety model

The workflow is manual (`workflow_dispatch`) and requires all of the following before it can send traffic:

1. a GitHub Environment name, normally `capacity-test`;
2. `confirm_isolated_test_env=true` selected explicitly for the run;
3. the required Environment secrets described below;
4. a tenant that starts with no pending outbox work and no messages in `CREATED`, `QUEUED`, or `PROCESSING`.

The workflow serializes runs by GitHub Environment name with `cancel-in-progress: false`. Two capacity runs therefore cannot intentionally execute at the same time against the same named environment through this workflow.

Do not configure a production customer environment or production customer tenant as the target.

## GitHub Environment configuration

Create a GitHub Environment such as `capacity-test`. Configure protection/approval rules appropriate to the repository and store these Environment secrets:

```text
EXTERNAL_CAPACITY_BASE_URL
EXTERNAL_CAPACITY_API_KEY
EXTERNAL_CAPACITY_RECIPIENTS
EXTERNAL_CAPACITY_SENDER_ID   # optional
```

Requirements:

- `EXTERNAL_CAPACITY_BASE_URL` is the deployed API origin, for example `https://capacity-api.example.test`;
- `EXTERNAL_CAPACITY_API_KEY` belongs to the isolated capacity tenant and needs `messages:write` plus `operations:read`;
- `EXTERNAL_CAPACITY_RECIPIENTS` is a comma-separated list of consented/safe E.164 test recipients;
- `EXTERNAL_CAPACITY_SENDER_ID` is optional; when absent, the tenant default sender is used.

The workflow never writes these values into its metadata artifact. GitHub masks secret values in runner logs, and the external capacity report deliberately excludes them.

## Profile C

Run **Actions → External Capacity Profile → Run workflow** with approximately:

```text
environment_name=capacity-test
confirm_isolated_test_env=true
profile_name=profile-c
messages=100000
concurrency=500
target_rps=0
accept_p95_ms=3000
accept_p99_ms=5000
max_error_rate=0
drain_max_ms=1800000
request_timeout_ms=10000
snapshot_interval_ms=5000
```

These latency values are starting engineering gates, not production SLOs. Replace them with the approved target-environment objectives once production-like SLOs have been agreed.

The workflow job allows up to six hours so the load generator itself does not recreate the 20-minute GitHub/Jest boundary that motivated the external runner. The target deployment should remain independently observable throughout the run.

## Paced soak example

For the documented 50 RPS / roughly 30-minute shape:

```text
environment_name=capacity-test
confirm_isolated_test_env=true
profile_name=soak-50rps-30m
messages=90000
concurrency=100
target_rps=50
accept_p95_ms=3000
accept_p99_ms=5000
max_error_rate=0.001
drain_max_ms=300000
request_timeout_ms=10000
snapshot_interval_ms=5000
```

Longer soak tests can increase message count up to the external runner limit of 1,000,000 attempts, provided the six-hour GitHub job ceiling and the target environment's approved test window are respected. For tests beyond that window, execute `npm run test:capacity:external` from a dedicated long-lived load-generator host instead.

## Artifacts

Every workflow run attempts to upload an artifact named:

```text
external-capacity-<github-run-id>
```

The artifact can contain:

```text
external-capacity.log
external-capacity.json
external-capacity-environment.json
```

`external-capacity.json` is produced only when the runner reaches its bounded report output. `external-capacity-environment.json` records non-secret execution metadata such as commit SHA, run ID, runner characteristics, workload shape, and configured gates.

The final workflow step fails the job when the external capacity runner exits non-zero, after artifact upload has had a chance to preserve the evidence.

## Interpreting a pass

A green workflow means the external runner's configured gates passed for that isolated tenant and target deployment. It does not by itself certify production capacity.

For a production-like capacity decision, correlate the workflow artifact with at least:

- API/worker replica CPU and memory;
- PostgreSQL CPU, IO, connections, locks, and pool saturation;
- RabbitMQ queue depth, oldest age, memory/disk alarms, and publish-confirm latency;
- Redis latency/errors/memory;
- provider latency, retry/rate-limit responses, and provider-side quotas;
- application Prometheus metrics and OTLP traces from the same time window.

A run with acceptable HTTP p95/p99 but continuously growing queue age or saturated infrastructure is not a capacity pass.
