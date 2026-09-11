# Paginated internal note history

The inbox conversation detail keeps its existing `notes` preview of the 100 most
recent notes. Clients needing older notes can now use a separate read-only route.
The existing create-note endpoint and its response are unchanged.

## Contract

```http
GET /api/v1/inbox/conversations/{conversationId}/notes?limit=50&cursor={noteId}
X-API-Key: <key-with-inbox:read>
```

`conversationId` and `cursor` are UUIDv4 values. Omit `cursor` on the first request.
`limit` defaults to 50 and accepts integers from 1 to 100. HTTP limit values must
be ordinary positive decimal strings, without padding, leading zeroes, fractions,
exponents or hexadecimal notation. Repeated/array-valued parameters and unknown
query fields, including caller-supplied `tenantId`, are rejected.

Example response (illustrative identifiers):

```json
{
  "items": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "conversationId": "22222222-2222-4222-8222-222222222222",
      "body": "Customer requested a callback.",
      "createdAt": "2026-09-11T10:00:00.000Z",
      "createdByApiKey": {
        "id": "44444444-4444-4444-8444-444444444444",
        "name": "Support integration"
      }
    }
  ],
  "nextCursor": null
}
```

The author is an API-key reference, not an authenticated human-agent identity.
Only its ID and current display name are selected. The author may be null when
no actor was stored or its key was deleted. API-key hashes, raw keys, prefixes,
scopes, usage timestamps and tenant metadata are not included in this route.
Note text is returned as stored; clients must render it as text, not trusted HTML.
Successful responses carry `Cache-Control: private, no-store`.

## Pagination and consistency

Results are ordered by `createdAt DESC, id DESC`. The ID tie-breaker makes order
unambiguous when several notes share a timestamp. The service fetches at most
`limit + 1` note rows, returns at most `limit`, and uses the last **returned** ID
as `nextCursor` only when the lookahead row exists. An empty or final page returns
`nextCursor: null`, including a final page exactly equal to the requested limit.

Supply the returned cursor unchanged to get older notes. The cursor row itself
is excluded. Its tenant and conversation membership are checked before any page
content is fetched. Prisma resolves the anchor in PostgreSQL, avoiding a
client-side timestamp round trip. The existing `(tenantId, conversationId,
createdAt)` index supports scoped history access; no schema migration is added.

New notes sorting ahead of the anchor do not shift the older page or cause its
already-returned notes to repeat. Refresh the first page to see them. This is not
a snapshot/export protocol: concurrent administrative deletion, backfilled
records, or changes outside the append-only application API can affect traversal.
An anchor already missing when checked returns 400. Deletion after that check
can yield an empty page. No cross-request database transaction or total count is
maintained. Author display names are read at request time, not snapshotted.

## Authorization and errors

The route requires `inbox:read`; `inbox:write` alone does not grant read access.
Tenant identity comes exclusively from the authenticated principal. Conversation,
cursor, and page queries all enforce tenant ownership. Cursor queries additionally
enforce the requested conversation. Another conversation in the same tenant is
not a valid cursor source.

| Status | Meaning |
| --- | --- |
| 200 | An owned conversation's note page, possibly empty |
| 400 | Invalid identifier/query or unavailable cursor for this conversation |
| 401 | Missing, invalid, inactive or otherwise rejected API credentials |
| 403 | Authenticated API key lacks `inbox:read` |
| 404 | Conversation is absent or not owned by the authenticated tenant |

Missing and foreign conversations share the same 404 response. Unknown,
foreign-tenant and sibling-conversation cursors share the same 400 response; the
response does not disclose whether the supplied note exists elsewhere.

Reading notes does not change unread counters, conversation state, activity
timestamps, note content, messages or the administrative audit ledger. Normal
API-key usage tracking still applies. It does not call Meta or send WhatsApp
messages. Notes remain append-only through the existing write endpoint.

The OpenAPI document includes the route's query bounds, security scheme, response
schema, nullable author/cursor and documented error statuses.

## Verification

```bash
npm test -- test/conversation-notes.service.spec.ts test/conversation-notes-query.spec.ts
npm run test:integration -- test/integration/conversation-notes.integration.ts
```

Integration requires the repository's normal PostgreSQL, Redis, RabbitMQ and
Prisma setup. It starts the actual Nest application and uses real tenant API
keys, PostgreSQL rows and HTTP requests. It checks the existing note-write route,
105-note history traversal, timestamp ties, lookahead termination, newer inserts,
null authors after key deletion, unchanged preview, independent scopes, tenant
and conversation isolation, invalid queries, safe projections, read-only state,
cache headers and generated OpenAPI. No live Meta credentials are required.

This change adds no dependency, configuration variable or database migration.
It does not implement human-agent authentication, realtime inbox push or a UI.

References:
- Inbox foundation: `inbox.md`
- Prisma pagination: https://www.prisma.io/docs/orm/v7/prisma-client/queries/pagination
- Nest validation: https://docs.nestjs.com/techniques/validation
