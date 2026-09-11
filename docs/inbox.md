# Agent Inbox and Conversations

Release `0.18.0` provides a tenant-scoped agent inbox foundation plus the first productivity extensions. The inbox is an operational read/write layer over the existing durable `Message` records; it does not introduce a second message store.

## Scope

The release provides:

- tenant-scoped inbox-agent resources;
- one logical conversation per tenant + WhatsApp sender + contact;
- conversation states `OPEN`, `PENDING`, and `RESOLVED`;
- priorities `LOW`, `NORMAL`, `HIGH`, and `URGENT`;
- assignment to active tenant inbox agents;
- unread counters;
- append-only internal notes with paginated history;
- tenant-owned canned responses with revision-safe editing;
- paginated conversation and message-history reads;
- automatic inbound conversation creation/reopening;
- automatic linking of free-form outbound messages to the same conversation;
- append-only audit events for agent, conversation, and canned-response administrative mutations.

## Authorization

Inbox endpoints require tenant API keys with one or both of:

```text
inbox:read
inbox:write
```

The authenticated API key is the only source of tenant identity. Tenant IDs are not accepted from request bodies or query strings.

Inbox agents are operational identities, not authentication credentials. Creating an `InboxAgent` does not create an API key or grant platform access.

## REST API

### Agents

```text
POST  /api/v1/inbox/agents
GET   /api/v1/inbox/agents
PATCH /api/v1/inbox/agents/{agentId}
```

Agents can be deactivated instead of deleted so historical assignments remain understandable. Assignment operations only accept an active agent owned by the authenticated tenant.

### Conversations

```text
GET   /api/v1/inbox/conversations
GET   /api/v1/inbox/conversations/{conversationId}
PATCH /api/v1/inbox/conversations/{conversationId}
POST  /api/v1/inbox/conversations/{conversationId}/read
GET   /api/v1/inbox/conversations/{conversationId}/messages
GET   /api/v1/inbox/conversations/{conversationId}/notes
POST  /api/v1/inbox/conversations/{conversationId}/notes
```

Conversation listing supports bounded filters for status, priority, assignment, sender, and contact plus cursor pagination. It does not accept arbitrary SQL/JSON predicates.

`PATCH /conversations/{id}` can change:

- status;
- priority;
- assigned agent.

Sending `assignedAgentId: null` removes the assignment.

### Canned responses

```text
POST  /api/v1/inbox/canned-responses
GET   /api/v1/inbox/canned-responses
GET   /api/v1/inbox/canned-responses/{responseId}
PATCH /api/v1/inbox/canned-responses/{responseId}
```

Canned responses are tenant-owned reusable plain-text snippets for inbox/CRM clients. They are not Meta-approved WhatsApp templates and do not send messages automatically.

Lists are cursor-paginated and can filter active/inactive rows or perform exact normalized shortcut lookup. Updates require `expectedRevision`; competing updates against the same revision have one winner and stale writers receive a conflict rather than silently overwriting newer content.

See `docs/inbox-canned-responses.md` for limits, normalization rules, pagination behavior, audit boundaries, and rollback guidance.

## Conversation identity

A logical conversation is unique on:

```text
tenantId + senderId + contactId
```

This prevents separate WhatsApp numbers from being incorrectly merged into one thread for the same contact.

## Inbound behavior

A valid, deduplicated inbound WhatsApp message:

1. resolves the tenant from Meta `phone_number_id`;
2. creates or updates the tenant contact;
3. opens or reopens the sender/contact conversation;
4. increments `unreadCount` exactly once for that persisted provider message;
5. moves `lastInboundAt` and `lastMessageAt` forward without allowing out-of-order webhooks to move activity timestamps backwards;
6. stores `Message.conversationId` in the same PostgreSQL transaction as the inbound message.

If a resolved conversation receives a new inbound message, it returns to `OPEN` and `resolvedAt` is cleared.

Webhook deduplication still happens on provider message ID before conversation activity is changed, so a duplicate provider message cannot increment unread twice.

## Outbound behavior

Free-form service messages accepted through `POST /api/v1/messages` reuse the same sender/contact conversation when the contact exists. Conversation update and `Message + OutboxEvent` persistence occur in the same PostgreSQL transaction.

This applies to free-form:

```text
TEXT
IMAGE
VIDEO
AUDIO
DOCUMENT
```

Template traffic deliberately does not create or reopen an inbox conversation automatically. This prevents marketing/authentication/utility template traffic and campaign volume from flooding the human-support inbox.

Campaign orchestration therefore retains its existing behavior and does not create agent-inbox work items merely because a marketing message was sent.

Canned responses do not bypass this outbound policy. A client may explicitly copy canned-response text into a normal outbound request or an internal note, but the copied text then follows the target endpoint's existing authorization and messaging rules.

## Unread semantics

`unreadCount` represents inbound messages not acknowledged by the inbox consumer.

```text
POST /api/v1/inbox/conversations/{conversationId}/read
```

sets the counter to zero under a row lock. An inbound message committed after that operation increments it again, preserving the correct ordering under concurrency.

## State and concurrency

Administrative conversation mutations use a row lock before updating status, priority, assignment, or unread state.

This gives useful ordering semantics:

- if an inbound message commits after a resolve action, the conversation reopens;
- if a resolve action commits after the inbound message, it remains resolved because the operator action occurred later;
- mark-read and inbound increments cannot silently overwrite one another outside database lock ordering.

Canned-response updates use optimistic revision checks. Notes remain append-only and therefore do not compete for a mutable revision.

## Internal notes

Conversation notes are append-only records attached to the tenant and conversation. A note stores the API-key actor ID when available.

The conversation detail response keeps a bounded recent-note preview. Older notes can be read through:

```text
GET /api/v1/inbox/conversations/{conversationId}/notes
```

The history endpoint is newest-first with deterministic `createdAt DESC, id DESC` ordering, bounded page sizes, tenant/conversation-scoped cursor validation, and `Cache-Control: private, no-store`. Read access does not mutate unread state, conversation activity, notes, messages, or audit logs.

Note bodies are not copied into the administrative `AuditLog`. The note record itself is the content source of truth, avoiding duplicate sensitive text in a second ledger.

See `docs/inbox-note-history.md` for the full response, cursor, privacy, and concurrency contract.

## Audit policy

Agent creation/update, conversation status/priority/assignment mutations, and canned-response mutations write audit events in the same PostgreSQL transaction as the administrative change.

Actions include:

```text
inbox.agent.created
inbox.agent.updated
inbox.conversation.updated
inbox.canned_response.created
inbox.canned_response.updated
```

Audit metadata records structural facts such as changed field names, status, priority, assignment state, and canned-response revision. It does not copy agent email/external IDs, contact data, message content, note bodies, canned-response text, or raw API keys.

## Data model

```text
Tenant
  ├─ InboxAgent
  ├─ InboxCannedResponse
  └─ Conversation
       ├─ Contact
       ├─ WhatsAppPhoneNumber
       ├─ assigned InboxAgent (optional)
       ├─ Message[]
       └─ ConversationNote[]
```

`Message` remains authoritative for inbound/outbound payloads and provider delivery status. `Conversation` stores operational state and activity timestamps only; it does not duplicate message bodies or provider payloads.

## Integration coverage

CI applies the full Prisma migration history to an empty PostgreSQL database and runs the core messaging suites plus inbox, note-history, canned-response, media, recovery, and cross-feature integration tests.

The inbox integration proves:

```text
signed Meta webhook
  -> durable WebhookEvent
  -> asynchronous inbound processor
  -> Contact
  -> Conversation OPEN + unread
  -> Message.conversationId
  -> mark read
  -> create InboxAgent
  -> assign + prioritize
  -> internal note
  -> resolve
  -> later inbound reopens same conversation
  -> free-form outbound links to same conversation
```

Additional regressions cover paginated note traversal, tenant/cursor isolation, concurrent canned-response revisions, mutable-filter pagination, explicit snippet-to-note copying, independent inbox/media scopes, and early rejection of invalid Ogg/Opus uploads while inbox endpoints remain usable.

The existing core test continues to prove the full outbound worker/Meta mock path and also cleans the conversations created by free-form traffic.

## Deliberate boundaries

The inbox still does not provide:

- SSO/user-session authentication for human agents;
- realtime WebSocket/SSE inbox push;
- teams/skills/round-robin assignment policies;
- SLA timers and escalation policies;
- message search/full-text indexing;
- attachment proxy/storage for inbound media;
- presence/typing indicators;
- a frontend inbox UI.

Those capabilities can be layered on the normalized conversation model without replacing the durable WhatsApp messaging pipeline.
