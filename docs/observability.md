# Observability runbook

Release 0.13.0 introduced Prometheus-compatible metrics and W3C trace correlation without adding an observability SDK to the runtime dependency graph. Current hardening adds an optional bounded OTLP/HTTP JSON trace exporter while preserving the existing public `traceparent` and queue-carrier contract.

## Scope

Implemented:

- HTTP request correlation with W3C `traceparent`;
- bounded `x-request-id` generation/propagation;
- trace carrier persistence in the transactional outbox;
- trace propagation through RabbitMQ publish, retry, and dead-letter payloads;
- trace restoration with a new worker span before outbound dispatch;
- optional OTLP/HTTP JSON export for completed HTTP server spans and outbound worker consumer spans;
- bounded in-process OTLP queue, batch size, schedule delay, and request timeout;
- W3C sampled-flag enforcement before export;
- Prometheus text metrics;
- durable backlog/status gauges sourced from PostgreSQL;
- baseline Prometheus alert rules.

Not implemented in this slice:

- automatic OpenTelemetry SDK instrumentation of PostgreSQL, Redis, RabbitMQ, `fetch`, or other libraries;
- OTLP metrics or logs export;
- producer/client child spans around outbox publication, RabbitMQ publish, Redis, or Meta HTTP calls;
- a local probabilistic/root sampling policy beyond the existing W3C trace flags;
- tracing-backend deployment or vendor-specific configuration for Jaeger, Tempo, Honeycomb, Datadog, etc.;
- automated alert delivery configuration for Alertmanager/PagerDuty/Slack/etc.

The exporter is deliberately non-critical telemetry. Collector unavailability, rejection, timeout, queue saturation, or invalid exporter configuration cannot make a business API request or outbound message fail.

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

## OTLP trace export

Trace export is disabled unless one of these variables is configured:

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
OTEL_EXPORTER_OTLP_ENDPOINT
```

The implementation supports OTLP over HTTP using JSON encoding only:

```text
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
```

A trace-specific endpoint is used exactly as configured. When only the generic endpoint is configured, `/v1/traces` is appended to its path.

Example:

```text
OTEL_SERVICE_NAME=apiWhatsApp
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otel-collector.example.net/v1/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_TRACES_TIMEOUT=10000
```

`http://` and `https://` collector endpoints are accepted because private cluster collectors commonly expose OTLP without TLS behind a trusted network boundary. Use HTTPS whenever telemetry or authentication headers cross an untrusted network.

Embedded endpoint credentials and URL fragments are rejected. Keep collector credentials in OTLP headers instead of the URL.

### Collector headers

The exporter accepts the standard comma-separated header variables:

```text
OTEL_EXPORTER_OTLP_HEADERS
OTEL_EXPORTER_OTLP_TRACES_HEADERS
```

Trace-specific headers override generic headers with the same name. Percent-encoded header values are decoded before sending.

Example:

```text
OTEL_EXPORTER_OTLP_TRACES_HEADERS=authorization=Bearer%20runtime-secret
```

The application keeps transport-controlled `content-type`, `content-length`, `host`, `connection`, and `transfer-encoding` authoritative. Configured values for those names are discarded.

Collector headers are runtime secrets/configuration. They are not written to PostgreSQL, application responses, span attributes, or normal exporter logs.

### Bounded exporter controls

Defaults:

```text
OTEL_EXPORTER_OTLP_TRACES_TIMEOUT=10000
OTEL_BSP_MAX_QUEUE_SIZE=2048
OTEL_BSP_MAX_EXPORT_BATCH_SIZE=512
OTEL_BSP_SCHEDULE_DELAY=5000
```

Application-enforced ranges:

```text
OTEL_EXPORTER_OTLP_TRACES_TIMEOUT   1..60000 ms
OTEL_BSP_MAX_QUEUE_SIZE             1..10000 spans
OTEL_BSP_MAX_EXPORT_BATCH_SIZE      1..queue size
OTEL_BSP_SCHEDULE_DELAY             100..60000 ms
```

A full local queue drops new spans rather than applying backpressure to API/worker processing. Collector failures drop the affected exported batch after the bounded attempt; they are not retried inside the business process. This prevents a telemetry outage from turning into an application memory/backpressure outage.

During graceful module shutdown the periodic timer stops and the exporter attempts to flush the remaining bounded queue. Collector failures during that flush remain non-fatal.

### Sampling behavior

The exporter sends a span only when the W3C sampled bit is set in `traceFlags`.

A valid inbound parent with `traceFlags=00` therefore continues correlation but does not export the server/worker spans from this exporter. A parent with `01` is export-eligible.

When no valid parent exists, the current trace-context implementation creates a local root with `traceFlags=01`. This means enabling OTLP export without upstream sampling can export every instrumented local-root request. For high-volume deployments, use an upstream W3C sampling policy or size the collector accordingly. A configurable local probability sampler is a separate future hardening slice.

## Exported span inventory

### HTTP server

Each completed Nest HTTP request can emit one `SERVER` span using the exact trace/span identity already returned through the response `traceparent`.

Span name:

```text
HTTP <METHOD> <Controller>.<handler>
```

Bounded attributes:

```text
http.request.method
http.response.status_code
code.namespace
code.function
```

HTTP 5xx/unhandled failures set OTLP span status to `ERROR`. 4xx responses remain application/client outcomes rather than server-span errors.

Raw URL/path/query values are deliberately not exported, avoiding IDs, phone numbers, tenant slugs, search terms, or other dynamic path/query data.

### Outbound worker consumer

Each outbound queue attempt can emit a `CONSUMER` span after the queue trace carrier is restored.

Span names:

```text
whatsapp.outbound.process
whatsapp.outbound.retry_exhausted
```

Bounded attributes:

```text
messaging.system=rabbitmq
messaging.operation.type=process
app.message.traffic_class=<OTP|TRANSACTIONAL|MARKETING>
app.queue.attempt=<bounded retry attempt>
app.queue.result=<ack|retry|defer|dead|exhausted|exception>
```

`retry`, `dead`, `exhausted`, and thrown exceptions are exported with OTLP `ERROR` status. Dynamic exception/retry reason text is intentionally excluded.

The worker span continues the existing queue carrier trace ID and uses a new span ID. No message ID is exported as a span attribute.

## OTLP data-handling policy

Do not add any of the following as span/resource attributes in routine instrumentation:

- tenant ID / tenant slug;
- contact ID;
- phone number;
- message ID / provider message ID;
- campaign ID;
- template ID;
- API key ID;
- request ID as a searchable span attribute;
- raw request URL, path with dynamic IDs, or query string;
- request/response/message payloads;
- media storage key/path/bucket;
- provider response bodies;
- error message text;
- user-provided strings;
- Meta or collector credentials.

Use the trace ID itself to join distributed spans. `x-request-id` remains available in HTTP/application-log correlation without being duplicated into exported span attributes.

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

## Metric cardinality policy

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
8. process RSS and heap usage;
9. OTLP collector accepted/dropped spans from collector-side metrics;
10. trace latency/error views for HTTP and outbound worker spans.

## Health versus telemetry

Use health endpoints for orchestration probes:

```text
GET /api/health/live
GET /api/health/ready
```

Use `/api/metrics` for monitoring/scraping and OTLP for trace export. Collector availability is deliberately **not** part of application readiness because telemetry must not remove a healthy messaging replica from service.

Do not use Prometheus scrape or OTLP collector success as Kubernetes liveness/readiness checks.

## Security checklist

- keep `METRICS_BEARER_TOKEN` and collector auth headers in a secret manager;
- use TLS when metrics or traces cross an untrusted network;
- restrict network access to metrics/collector endpoints where possible;
- rotate monitoring/collector credentials independently of tenant credentials;
- do not log metrics or collector bearer tokens;
- keep OTLP disabled when trace export is not required;
- review every new metric label and span attribute for cardinality and data leakage;
- never export business payloads or tenant/contact/message identifiers as routine telemetry;
- size collector ingestion and upstream sampling before enabling trace export on high-volume production traffic.
