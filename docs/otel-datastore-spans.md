# OpenTelemetry datastore spans

This slice extends the existing manual OpenTelemetry trace hierarchy with two bounded datastore client spans inside outbound worker processing. It does not enable automatic Prisma or ioredis instrumentation and does not change message, retry, lease, rate-limit, or provider semantics.

## Trace hierarchy

For a traced outbound message, the relevant hierarchy is:

```text
HTTP SERVER
  -> RabbitMQ PRODUCER
       -> RabbitMQ CONSUMER
            -> PostgreSQL CLIENT: claim outbound message
            -> Redis CLIENT: reserve outbound slot
            -> Meta WhatsApp CLIENT: send_message
```

The PostgreSQL, Redis, and Meta client spans are independent sibling children of the active worker consumer span. They use the same trace ID and distinct span IDs.

No tracing header is injected into PostgreSQL, Redis, RabbitMQ, or Meta by these manual child spans.

## PostgreSQL claim span

Span name:

```text
postgresql claim outbound_message
```

Kind:

```text
CLIENT
```

The span covers the application-level claim boundary implemented by the existing `updateMany` lease claim followed by `findUnique` reload. It deliberately does not claim to represent one SQL statement.

Bounded attributes:

```text
db.system.name=postgresql
app.operation=claim_outbound_message
app.datastore.result=<claimed|not_claimed|missing|error>
```

The span does not include:

- message ID;
- tenant ID;
- sender/contact identifiers;
- database URL, host, database name, user, or credentials;
- SQL text;
- query parameters;
- row values;
- dynamic database error text.

A datastore exception marks the span `ERROR` and is rethrown unchanged to the existing dispatcher path.

## Redis reservation span

Span name:

```text
redis reserve outbound_slot
```

Kind:

```text
CLIENT
```

The span covers the application-level outbound-slot reservation boundary, including any bounded waiting/retry performed by `DistributedRateLimiterService`. It therefore represents reservation latency, not one individual Redis command or Lua execution.

Bounded attributes:

```text
db.system.name=redis
app.operation=reserve_outbound_slot
app.message.traffic_class=<OTP|TRANSACTIONAL|MARKETING>
app.datastore.result=<success|error>
```

The span does not include:

- provider phone-number ID;
- tenant/message/contact IDs;
- Redis connection URL or credentials;
- Redis keys;
- Lua/script contents;
- exact reservation counters;
- retry/wait reason text;
- dynamic Redis error text.

If Redis is unavailable, the span is marked `ERROR` and the existing dispatcher behavior remains authoritative: the message is returned to the normal retry path and Meta is not called.

## Sampling and export

These spans use the existing `TraceContextService` child-context logic and inherit the active trace sampling decision. If the W3C sampled bit is not set, the bounded OTLP exporter drops them just like the existing HTTP/RabbitMQ/Meta spans.

The exporter remains optional and telemetry-only. Collector failure cannot make the PostgreSQL claim, Redis reservation, outbound message, or application readiness fail.

See `docs/observability.md` for collector configuration, batching, sampling policy, and the general telemetry data-handling rules.

## Integration contract

`test/integration/otlp-outbound-chain.integration.ts` validates the real hierarchy against PostgreSQL, Redis, RabbitMQ, API, worker, Meta mock, and OTLP collector mock.

For one traced outbound delivery it requires:

```text
SERVER -> PRODUCER -> CONSUMER
                      |-> PostgreSQL CLIENT
                      |-> Redis CLIENT
                      |-> Meta CLIENT
```

The integration asserts that all three client spans:

- use the same trace ID as the incoming W3C trace;
- have the worker consumer span as parent;
- have distinct valid span IDs;
- complete successfully for the happy path.

It also asserts that exported spans do not contain the internal message ID, recipient phone, message body, request ID, sender provider phone-number ID, or database/Redis environment-variable names.

## Deliberate boundary

This is explicit boundary instrumentation rather than automatic client-library tracing. Future expansion may add carefully bounded spans around additional PostgreSQL, Redis, media-storage, webhook, campaign, or internal provider operations, but should keep the same low-cardinality/no-business-data policy.
