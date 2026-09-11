# Reusable inbox responses

Canned responses are tenant-owned plain-text snippets for an agent or CRM to
select, review and copy into the existing messaging API. They are **not** Meta
message templates, and saving or reading a snippet does not send any message.
There is no expression evaluation, automatic personalization or automatic send.

## Endpoints and authorization

| Method | Path | Scope | Success |
| --- | --- | --- | --- |
| POST | `/api/v1/inbox/canned-responses` | `inbox:write` | 201 |
| GET | `/api/v1/inbox/canned-responses` | `inbox:read` | 200 |
| GET | `/api/v1/inbox/canned-responses/{id}` | `inbox:read` | 200 |
| PATCH | `/api/v1/inbox/canned-responses/{id}` | `inbox:write` | 200 |

Send `X-API-Key` as for other business endpoints. Tenant identity comes only from
that authenticated key. Write scope does not imply read scope; write responses
return the created/updated resource. Every successful response carries
`Cache-Control: private, no-store`. Missing/rejected credentials return 401;
missing scope returns 403. Missing and foreign-tenant IDs both return 404.
There is no DELETE route. Deactivate a response to remove it from normal lists.

## Create and read

```json
{
  "shortcut": "order_status",
  "title": "Order status",
  "body": "We are checking your order and will reply shortly."
}
```

The shortcut is trimmed, lowercased, 1-32 ASCII characters, starts with a letter,
and then contains only letters, digits, `_` or `-`. It is unique per tenant,
including inactive responses. A duplicate returns 409, including concurrent
creation attempts. Different tenants may reuse the same shortcut.

Title and body are trimmed at the outer boundaries, retain internal whitespace,
and contain 1-100 and 1-4096 Unicode scalar values respectively. NUL and unpaired
UTF-16 surrogates are rejected. HTML-looking or `{{variable}}` text is stored
literally: clients must render it as text, not trusted HTML. There are no language
or placeholder semantics. Unknown fields and explicit nulls are rejected.

Creation sets `active: true` and `revision: 1`. Returned fields are exactly:

```text
id, shortcut, title, body, active, revision, createdAt, updatedAt
```

No tenant object, API-key data, sender credentials or provider payload is joined.
A direct GET may read an inactive response for management purposes.

## List and lookup

```http
GET /api/v1/inbox/canned-responses?status=active&limit=50
GET /api/v1/inbox/canned-responses?shortcut=order_status
GET /api/v1/inbox/canned-responses?status=all&limit=50&cursor=<last-returned-id>
```

`status` is `active` (default), `inactive`, or `all`. `shortcut` is an optional
exact match after normalization. `limit` defaults to 50 and is bounded to 1-100;
HTTP values must be ordinary positive decimal strings (no leading zeroes,
fractions, exponents, spaces or repeated/array parameters). `cursor` is a UUIDv4.
Unknown query fields are rejected.

Response shape is `{ "items": [...], "nextCursor": "<id>" }`. The final page,
even if exactly full, has a null cursor. At most `limit + 1` rows are loaded.
Order is `createdAt DESC, id DESC`, backed by tenant-scoped composite indexes.
The exclusive cursor must belong to this tenant; missing and foreign cursors
both return 400 before page content is loaded. Cursor ownership is independent
of the current status/shortcut filter, so deactivating an anchor does not make
its ID foreign. Keep filters unchanged when following a traversal.

The server captures only the owned anchor's `id` and `createdAt`, then selects
rows strictly below that position: `createdAt < anchor.createdAt`, or an equal
creation time and `id < anchor.id`. Tenant and current status/shortcut filters
apply to both alternatives. There is no offset and no requirement for the anchor
to remain in the filtered result set. In particular, deactivation, reactivation
or shortcut changes on the anchor do not silently skip the next eligible row.

The committed table uses PostgreSQL `TIMESTAMP(3)`, exactly matching JavaScript
Date's millisecond precision. The timestamp comes from the database, never a
caller-supplied field. Do not widen this column's precision without adapting the
boundary representation and regression tests. This implementation is specific
to the canned-response table, not a generic microsecond-precision paginator.

Creation timestamps and IDs are immutable through this API. Newer inserts do
not repeat previously returned older pages. This is not a snapshot or export:
concurrent edits, activation changes or administrative deletion can change which
rows match. A cursor already deleted when the anchor is read returns 400. If
administrative deletion occurs after the owned position has been captured, the
current request still continues from that captured position; it does not look
up the deleted row again. A later request reusing that deleted cursor returns
400. No cross-request snapshot or transaction is held.
Refresh the first page to see new responses. No full-text search or total count
is performed. Tenant operators should manage library growth; there is no per-tenant
creation quota in this slice.

## Safe concurrent updates

Use the revision from the last read, not a client timestamp:

```json
{
  "expectedRevision": 1,
  "body": "Your order is being checked by our support team.",
  "active": false
}
```

At least one of `shortcut`, `title`, `body`, or `active` must be supplied.
`expectedRevision` is a required JSON integer, not a string. One conditional SQL
UPDATE matches `id + tenantId + revision` and increments the revision atomically.
Two requests using the same revision cannot silently overwrite each other: one
wins and the other returns 409. Reload and reconcile; do not blindly retry with a
new revision. Even a valid no-op edit consumes a revision. Revisions up to
2,147,483,646 can be updated, avoiding PostgreSQL integer overflow.

Updating to an existing shortcut also returns 409. A failed operation does not
consume a revision or write an audit event. Reactivation uses `active: true`
with the current revision; the ID and retained shortcut remain stable.

## Audit and messaging boundaries

Create/update and their append-only audit event commit in the same PostgreSQL
transaction. An audit failure rolls the mutation back. Actions are
`inbox.canned_response.created` and `inbox.canned_response.updated`.
Metadata contains only active state, revision and changed field names; it never
copies the shortcut, title or body. Standard actor/request metadata is retained.
Read requests do not mutate the library, inbox state or audit ledger; normal
API-key usage tracking still applies. This is not authenticated human-agent
identity or a complete version-history store.

To use a response, the client reads and reviews its body and supplies the final
text to `POST /api/v1/messages` as an ordinary `TEXT` payload. The existing
messaging pipeline remains responsible for sender ownership, current consent,
service-window checks, idempotency, queue routing and delivery. A stored snippet
is never evidence of template approval and cannot bypass those checks. No new
Meta call, message endpoint or provider policy is introduced here.

## Migration, deployment and rollback

`20260911143000_inbox_canned_responses` creates only `InboxCannedResponse` with a
tenant FK (cascade on tenant deletion), unique tenant/shortcut key, list indexes,
and checks for shortcut syntax, text lengths and positive revisions. The Prisma
model and inverse tenant relation are included. Check constraints live in the
SQL migration because the Prisma schema cannot express them.

Apply the committed migration with `npm run prisma:deploy` before starting this
application version. Existing messages, conversations and templates are not
rewritten. Application rollback can leave the additive table in place to preserve
saved snippets; do not drop populated data as part of an automatic rollback.
No dependency or environment variable is added. This feature has no frontend.

## Verification

```bash
npm test -- test/canned-response.policy.spec.ts test/canned-responses-query.spec.ts test/canned-responses.service.spec.ts
npm run test:integration -- test/integration/canned-responses.integration.ts
npm test -- test/canned-response-pagination.spec.ts
npm run test:integration -- test/integration/canned-response-pagination.integration.ts
```

The integration suite uses the actual Nest application, tenant API keys and
PostgreSQL. It exercises independent scopes, normalized uniqueness (including
concurrent creates), conditional-update races, audit rollback fault injection,
107-row tied-timestamp pagination, newer inserts, tenant isolation, database
constraints, cascade cleanup and generated OpenAPI. No live Meta token is used.
The pagination regression suite adds active/inactive anchor transitions with
tied and one-millisecond timestamps, renamed/reused shortcuts, timestamp/UUID
ordering, exact final pages, safe cursor errors and unchanged read-only state.
Eleven cases use the real HTTP route. One directly invokes the actual service
with a deterministic scheduling hook between real PostgreSQL operations to
verify deletion after anchor capture. Unit tests also assert that tenant and
filters cannot be bypassed by the boundary's OR condition, both reads remain
bounded, database errors propagate and no offset is introduced.
Run the full repository CI, including security and Docker, before merge.

References:
- Nest validation: https://docs.nestjs.com/techniques/validation
- Prisma database constraints: https://www.prisma.io/docs/orm/v7/reference/database-features
- Prisma pagination: https://www.prisma.io/docs/orm/v7/prisma-client/queries/pagination
- Existing inbox foundation: `inbox.md`
