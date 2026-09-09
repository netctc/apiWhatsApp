# Observability runbook

Release 0.13.0 adds Prometheus-compatible metrics and W3C trace correlation without adding an observability SDK to the runtime dependency graph.

## Scope

Implemented in this release:

- HTTP request correlation with W3C `traceparent`;
- bounded `x-request-id` generation/propagation;
- trace carrier persistence in the transactional outbox;
- trace propagation through RabbitMQ publish, retry, and dead-letter payloads;
- trace restoration with a new worker span before outbound dispatch;
- Prometheus text metrics;
- durable backlog/status gauges sourced from PostgreSQL;
- baseline Prometheus alert rules.

Not implemented yet:

- OpenTelemetry span export;
- distributed trace sampling/export to Jaeger, Tempo, Honeycomb, Datadog, or another backend;
- automated alert delivery configuration for Alertmanager/PagerDuty/Slack/etc.

The W3C correlation model in this release is intentionally compatible with adding an OpenTelemetry exporter later without changing public trace headers or queue-carrier semantics.

## Trace correlation

### Incoming HTTP

A valid incoming header such as:

```http
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
x-request-id: crm-request-123
```

continues the same trace ID while generating a new server span ID.

Responses include:

```http
traceparent: 00-<same-trace-id>-<new-server-span-id>-<flags>
x-request-id: <accepted-or-generated-request-id>
```

Invalid/all-zero W3C trace IDs or span IDs are rejected as correlation inputs and replaced by a new local trace root.

`x-request-id` is accepted only when it is bounded and contains a safe technical character set. Unsafe values are replaced with a generated UUID.

### Outbound asynchronous path

For newly-created outbound messages, the current trace carrier is stored in the existing outbox JSON payload. No database migration is required.

```text
HTTP request
  -> Message + OutboxEvent transaction
  -> outbox publisher
  -> RabbitMQ traffic-class queue
  -> retry queue(s), if required
  -> outbound worker
  -> Meta Cloud API
```

The carrier contains only:

```json
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "parentSpanId": "00f067aa0ba902b7",
  "traceFlags": "01",
  "requestId": "crm-request-123"
}
```

It does not contain tenant IDs, contact IDs, phone numbers, campaign IDs, message bodies, provider payloads, or credentials.

Legacy outbox and RabbitMQ jobs without trace metadata continue to process normally. Invalid optional trace metadata is ignored rather than allowed to block message delivery.

## Metrics endpoint

```text
GET /api/metrics
```

This endpoint is intentionally separate from tenant API-key authentication because the metrics are process/global operational telemetry.

Configure a dedicated secret:

```text
METRICS_BEARER_TOKEN=<random-secret-at-least-32-characters>
```

When the variable is missing or shorter than 32 characters, the endpoint fails closed with `503 Service Unavailable`.

Scrapes require:

```http
Authorization: Bearer <METRICS_BEARER_TOKEN>
```

Do not reuse:

- tenant API keys;
- Meta access tokens;
- webhook verification tokens;
- application secrets.

The response uses Prometheus text exposition:

```text
text/plain; version=0.0.4; charset=utf-8
```

and is marked `Cache-Control: no-store`.

## Prometheus scrape example

Prefer a credentials file or secret injection rather than embedding the monitoring token directly in source-controlled Prometheus configuration.

```yaml
scrape_configs:
  - job_name: api-whatsapp
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/api-whatsapp-metrics-token
    static_configs:
      - targets:
          - api-whatsapp:3000
```

## Exported metrics

### Process

```text
api_whatsapp_process_start_time_seconds
api_whatsapp_process_uptime_seconds
api_whatsapp_process_resident_memory_bytes
api_whatsapp_process_heap_used_bytes
```

### HTTP

```text
api_whatsapp_http_requests_total
api_whatsapp_http_request_duration_seconds
```

HTTP labels are deliberately bounded to:

```text
method
controller
handler
status_code
```

The implementation does not use raw URLs as metric labels. Therefore UUIDs, phone numbers, tenant slugs, message IDs, campaign IDs, query strings, and other unbounded request data do not create Prometheus series.

Duration histogram buckets (seconds):

```text
0.005
0.01
0.025
0.05
0.1
0.25
0.5
1
2.5
5
+Inf
```

### Durable business/worker state

```text
api_whatsapp_messages{status="..."}
api_whatsapp_campaigns{status="..."}
api_whatsapp_campaign_recipients{status="..."}
```

These are global status counts. They contain enum status labels only and no tenant/customer labels.

### Transactional outbox

```text
api_whatsapp_outbox_pending
api_whatsapp_outbox_due
api_whatsapp_outbox_leased
api_whatsapp_outbox_oldest_pending_age_seconds
```

### Durable webhook processor

```text
api_whatsapp_webhook_pending
api_whatsapp_webhook_due
api_whatsapp_webhook_leased
api_whatsapp_webhook_oldest_pending_age_seconds
```

The durable metrics are read from PostgreSQL at scrape time. This means they represent recoverable platform state rather than per-process counters that disappear when a replica restarts.

## Cardinality and data-handling policy

Never add any of the following as Prometheus labels:

- tenant ID / tenant slug;
- contact ID;
- phone number;
- message ID / provider message ID;
- campaign ID;
- template ID;
- API key ID;
- request path containing dynamic IDs;
- error message text;
- user-provided strings.

High-cardinality investigation should use application logs, database queries, and trace/request correlation—not metric labels.

## Alert rules

Baseline rules are stored at:

```text
ops/prometheus-alerts.yml
```

They include:

- metrics target down;
- transactional outbox stalled for more than five minutes;
- durable webhook processing stalled for more than five minutes;
- sustained HTTP 5xx rate above five percent.

The repository ships rules only. Alertmanager routing, paging policy, notification receivers, inhibition rules, maintenance windows, and environment-specific thresholds remain deployment responsibilities.

## Recommended dashboards

At minimum graph:

1. request rate by controller/handler;
2. p50/p95/p99 request duration derived from the histogram;
3. 4xx and 5xx rates;
4. outbox pending/due/oldest age;
5. webhook pending/due/oldest age;
6. message counts by current status;
7. campaign recipient counts by orchestration status;
8. process RSS and heap usage.

## Health versus metrics

Use health endpoints for orchestration probes:

```text
GET /api/health/live
GET /api/health/ready
```

Use `/api/metrics` for monitoring/scraping. Do not use Prometheus scrape success as the Kubernetes liveness or readiness check.

## Security checklist

- keep `METRICS_BEARER_TOKEN` in a secret manager;
- use TLS at the ingress/service-mesh boundary;
- restrict network access to the metrics endpoint where possible;
- rotate the monitoring token independently of tenant credentials;
- do not log the metrics bearer token;
- keep the endpoint disabled when monitoring is not configured;
- review new metric labels for cardinality and data leakage before release.
