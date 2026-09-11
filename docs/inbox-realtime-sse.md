# Realtime inbox SSE

The realtime inbox endpoint is a low-latency invalidation channel layered on top of the authoritative PostgreSQL/REST inbox model.

```text
GET /api/v1/inbox/events
Accept: text/event-stream
X-API-Key: <tenant key with inbox:read>
```

A subscription requires `inbox:read`. `inbox:write`, message, campaign, or media scopes do not grant stream access by themselves. Tenant identity is derived only from the authenticated API key.

## Delivery model

API replicas publish safe structural events to Redis pub/sub after the underlying PostgreSQL transaction has committed. Every replica can therefore deliver events produced by another process to locally connected clients.

Redis pub/sub is deliberately not presented as a durable queue. A network break, process restart, or disconnected client may miss notifications. Clients must reconnect and refresh the relevant REST collections/resources. PostgreSQL and the existing REST endpoints remain the source of truth.

No message, note, conversation, canned response, unread counter, or audit record is mutated merely by subscribing.

## Event types

The first version uses these event names:

```text
conversation.created
conversation.updated
conversation.message.created
conversation.note.created
canned_response.created
canned_response.updated
```

Frames have a UUID event ID, an event name, and JSON data. Example:

```text
id: 4e69d57e-df05-4c73-92a3-e2f1e97fcf57
event: conversation.updated
data: {"occurredAt":"2026-09-11T17:00:00.000Z","conversationId":"...","unreadCount":2}
```

The Redis receiver reconstructs an allowlisted payload before delivery. Supported data fields are limited to resource IDs plus bounded state needed to decide which REST resource to refresh:

- `conversationId`;
- `messageId`;
- `noteId`;
- `cannedResponseId`;
- `status`;
- `priority`;
- `assignedAgentId`;
- `unreadCount`;
- `revision`;
- `active`.

The SSE frame does not expose the internal tenant routing ID. Message bodies, note bodies, canned-response title/body/shortcut, phone numbers, contact data, raw webhooks, provider payloads, API keys, and provider credentials are not valid event data and are discarded by the runtime allowlist.

## Producers and transaction ordering

Notifications are emitted only after the database operation has returned successfully. Covered producers include:

- inbound messages that update/open a conversation;
- accepted free-form outbound messages linked to a conversation;
- conversation status/priority/assignment changes;
- mark-read updates;
- internal-note creation;
- canned-response creation and revision-safe updates.

A rolled-back transaction has no successful post-commit publication point. Duplicate inbound provider messages are filtered before persistence and therefore do not emit another realtime event.

Realtime publication failure does not roll back already committed business state. Clients recover by refreshing REST state; publication errors are logged without copying event data into logs.

## Connection safety

Responses include:

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: private, no-store
Connection: keep-alive
X-Accel-Buffering: no
```

The server emits SSE comment heartbeats. If `response.write()` reports backpressure, the connection is closed immediately rather than maintaining an application-level unbounded event queue.

Configuration:

```text
INBOX_SSE_HEARTBEAT_MS=15000
INBOX_SSE_MAX_CONNECTIONS=500
```

`INBOX_SSE_HEARTBEAT_MS` accepts whole milliseconds from 5000 through 60000. Invalid values use 15000.

`INBOX_SSE_MAX_CONNECTIONS` accepts 1 through 100000 and is enforced per API process. Invalid values use 500. Production infrastructure should also enforce appropriate per-tenant/per-IP connection controls at the trusted gateway/load-balancer layer.

## Reverse proxy guidance

Do not buffer SSE responses. Preserve streaming/chunked delivery, allow long-lived HTTP connections, and configure idle timeouts above the selected heartbeat interval. `X-Accel-Buffering: no` is emitted for nginx-compatible proxies, but infrastructure configuration remains authoritative.

When horizontally scaling, all API replicas must point to the same reachable Redis deployment. Sticky sessions are not required for fan-out because Redis distributes the notification to each subscribed API process.

## Client recovery

Recommended client behavior:

1. load inbox state over REST;
2. open the SSE stream;
3. on each event, refresh the identified REST resource or affected collection;
4. on disconnect, reconnect with bounded exponential backoff;
5. after reconnect, refresh REST state before assuming local state is complete.

The first version does not support `Last-Event-ID` replay. Event IDs are diagnostic/correlation identifiers within the live stream, not durable offsets.

## Non-goals

This slice does not add WebSockets, typing/presence, durable per-client replay queues, acknowledgements, human-agent SSO, a frontend UI, or automatic WhatsApp sending.
