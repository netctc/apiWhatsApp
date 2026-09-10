# apiWhatsApp

Enterprise-grade, multi-tenant WhatsApp Business Platform API for reliable high-volume messaging through Meta Cloud API.

## Current release: 0.18.0

Engineering language is English for source code, API contracts, tests, operational documentation, logs, and commit messages.

## Platform capabilities

- NestJS + TypeScript REST API
- PostgreSQL + Prisma persistence and versioned migrations
- Tenant isolation with scoped API keys
- API key lifecycle and append-only audit logs
- Contacts, consent history, normalized tags, and 24-hour service windows
- Reusable tenant contact segments with bounded/indexable predicates
- Multiple WhatsApp senders per tenant with runtime secret references
- WABA template synchronization and lifecycle tracking
- Local `APPROVED` template enforcement before outbound creation
- Outbound text plus image/video/audio/document media messaging
- Tenant-scoped direct media upload with bounded disk-backed multipart handling, MIME/content signature validation, optional fail-closed ClamAV scanning, an expiring registry, and optional controlled filesystem or S3-compatible binary retention
- Server-derived traffic classes: `OTP`, `TRANSACTIONAL`, `MARKETING`
- Isolated RabbitMQ queues, retry queues, DLQs, and traffic-class prefetch
- Priority-aware Redis sender capacity reservation
- Transactional outbox
- Signed Meta webhook ingestion and durable asynchronous processing
- Inbound message persistence and delivery receipt processing
- Tenant-scoped agent inbox with conversation state, priority, assignment, unread counters, notes, and message history
- Durable marketing campaign orchestration with immutable audience snapshots
- Safe per-recipient template personalization
- Live campaign orchestration and WhatsApp delivery analytics
- Process liveness, dependency readiness, and tenant operations diagnostics
- Prometheus-compatible metrics and baseline alert rules
- W3C trace/request correlation across HTTP -> outbox -> RabbitMQ -> worker
- Committed npm lockfile, runtime vulnerability gate, and reproducible Docker build
- Real CI integration test against PostgreSQL, Redis, RabbitMQ, API, worker, and controlled external-service seams
- Concurrent acceptance/drain load smoke gate
- OpenAPI / Swagger

## Architecture

```mermaid
flowchart LR
    Client[CRM / ERP / Application] --> API[REST API]
    Agent[Agent / Helpdesk Client] --> API
    API --> DB[(PostgreSQL)]
    API --> Temp[Ephemeral media file]
    Temp --> Scan[Optional ClamAV scan]
    Scan --> MediaRegistry[Media Asset Metadata]
    MediaRegistry --> DB
    MediaRegistry --> Store[Optional Retained Filesystem / S3]
    Store --> Meta[Meta Cloud API]
    Scan --> Meta
    DB --> Inbox[Conversation Read Model]
    DB --> Outbox[Transactional Outbox]
    Outbox --> Router[Traffic Router]
    Router --> OTP[(RabbitMQ OTP)]
    Router --> TX[(RabbitMQ Transactional)]
    Router --> MKT[(RabbitMQ Marketing)]
    OTP --> Worker[Outbound Worker]
    TX --> Worker
    MKT --> Worker
    Worker --> Rate[Redis Rate Limiter]
    Rate --> Meta
    Meta --> WhatsApp[WhatsApp]
    Meta --> Webhook[Signed Webhook]
    Webhook --> DB
    DB --> WebhookProcessor[Webhook Processor]
    DB --> CampaignProcessor[Campaign Processor]
    DB --> Analytics[Analytics / Operations / Metrics]
```

Outbound message requests accept and persist work quickly; WhatsApp delivery is asynchronous. Message creation and the intent to publish are committed atomically before RabbitMQ publication.

Media upload is intentionally different: it is a bounded synchronous provider operation. The service validates a disk-backed temporary file, optionally scans it, reserves tenant-scoped expiring metadata, optionally retains the scanned bytes under a server-derived filesystem/S3 key, uploads to Meta, finalizes the registry lifecycle, and always removes the multipart temporary file. The storage key is persisted before bytes are stored, so abrupt process termination cannot remove the application cleanup reference to a retained object in the normal flow.

The agent inbox is an operational layer over the authoritative `Message` store. Conversation rows keep assignment/state/activity data; message payloads and provider lifecycle remain on `Message`.

Campaigns reuse the normal message pipeline. They cannot bypass tenant ownership, current consent, template approval, idempotency, priority routing, retries, outbox durability, or sender rate limits.

## Requirements

- Node.js 24+
- npm 11+
- Docker and Docker Compose
- PostgreSQL
- Redis
- RabbitMQ
- Meta application with WhatsApp Business Platform access
- One or more WhatsApp Business phone numbers
- WABA ID for template senders
- Meta access token for each configured sender
- Meta app secret and webhook verify token
- Optional ClamAV service when malware scanning is enabled
- Optional protected persistent/shared filesystem or private S3-compatible bucket when media binary retention is enabled

## Local setup

```bash
cp .env.example .env
docker compose up -d
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run bootstrap:tenant -- --name="Acme" --slug=acme --key-name=bootstrap
```

The bootstrap command displays a raw API key once. PostgreSQL stores only its HMAC-SHA256 digest.

Run API and worker separately:

```bash
npm run start:dev
npm run start:worker:dev
```

API: `http://localhost:3000/api`

Swagger: `http://localhost:3000/docs`

## Authentication and authorization

Business endpoints use:

```http
X-API-Key: wapi_<prefix>_<secret>
```

Tenant identity comes only from the authenticated key and is never accepted from the request payload.

Current scopes:

```text
messages:read
messages:write
media:read
media:write
contacts:read
contacts:write
phone_numbers:read
phone_numbers:write
templates:read
templates:write
campaigns:read
campaigns:write
segments:read
segments:write
inbox:read
inbox:write
operations:read
api_keys:read
api_keys:write
audit:read
```

A delegated API key cannot create another key with privileges it does not itself hold.

## Messaging API

```text
POST /api/v1/messages
GET  /api/v1/messages
GET  /api/v1/messages/{messageId}
```

Supported outbound types:

```text
TEXT
TEMPLATE
IMAGE
VIDEO
AUDIO
DOCUMENT
```

Template messages require explicit `OPTED_IN` consent and an approved synchronized template. Free-form text and media messages require an open customer-service window.

Media messages accept exactly one existing Meta media `id` or an absolute HTTPS `link`. Image/video/document can carry a bounded caption; document can also carry a bounded filename. See `docs/media-messaging.md`.

Outbound lifecycle:

```text
QUEUED -> PROCESSING -> SUBMITTED -> SENT -> DELIVERED -> READ
                              \
                               -> FAILED
```

Clients can use `Idempotency-Key` to obtain one logical message across retries.

## Media upload and registry API

Upload:

```text
POST /api/v1/media
Content-Type: multipart/form-data
Required scope: media:write
```

Registry reads:

```text
GET /api/v1/media
GET /api/v1/media/{assetId}
Required scope: media:read
```

Multipart fields:

```text
file       required
senderId   optional tenant-scoped sender UUID
```

The upload endpoint writes one upload to OS/container temporary storage rather than buffering the full file in Node.js heap. It validates multipart fields, declared MIME/size and a bounded content signature. Storage configuration is validated before credential access; optional ClamAV scanning then runs on the temporary file. Only after a clean scan does the service resolve the tenant sender, reserve an expiring `MediaAsset`, and optionally retain the bytes through the configured filesystem or S3-compatible backend. Retained storage succeeds before Meta is called.

Current local limits are intentionally at or below provider limits:

| Category | Accepted MIME families | Max |
| --- | --- | ---: |
| Image | JPEG, PNG | 5 MB |
| Audio | AAC, MP4/M4A, MPEG/MP3, AMR, OGG | 16 MB |
| Video | MP4, 3GPP | 16 MB |
| Document | text, PDF, Word, Excel, PowerPoint legacy/OOXML | 100 MB |

Example upload response remains backward compatible:

```json
{
  "mediaId": "<meta-media-id>",
  "senderId": "<internal-sender-id>",
  "category": "IMAGE",
  "mimeType": "image/jpeg",
  "size": 48123
}
```

Registry rows derive `UPLOADING`, `ACTIVE`, `EXPIRED`, or `FAILED` state and expose safe storage evidence (`storageMode`, `binaryRetained`, `storedAt`) without exposing the internal storage key, filesystem path, S3 bucket/endpoint, or storage credentials.

Binary retention is disabled by default. Filesystem mode uses:

```text
MEDIA_BINARY_STORAGE_MODE=filesystem
MEDIA_FILESYSTEM_STORAGE_PATH=/var/lib/api-whatsapp/media
```

The path must be absolute and non-root. Files use server-derived `<tenant UUID>/<asset UUID>` keys, exclusive streaming creation and restrictive file/directory modes. Multi-replica deployments require persistent shared storage visible to every API replica that can upload or perform retention cleanup.

S3-compatible mode uses:

```text
MEDIA_BINARY_STORAGE_MODE=s3
MEDIA_S3_ENDPOINT=https://s3.example.internal
MEDIA_S3_BUCKET=whatsapp-media
MEDIA_S3_REGION=us-east-1
MEDIA_S3_ACCESS_KEY_ID=<runtime-secret>
MEDIA_S3_SECRET_ACCESS_KEY=<runtime-secret>
```

S3 requests use server-derived `<tenant UUID>/<asset UUID>` keys and AWS Signature Version 4. The file is SHA-256 hashed by streaming from disk and then streamed to the object store with the signed full payload hash. The bucket remains private; no public object URL or media download endpoint is created.

`MEDIA_ASSET_TTL_DAYS` controls both registry metadata and retained binary lifetime. `MEDIA_ASSET_CLEANUP_INTERVAL_MS` controls periodic cleanup. Expired binaries are deleted before their registry row; if backend deletion fails, the row remains so cleanup can retry later. These settings do not claim or modify Meta's provider-side media retention semantics.

See `docs/media-upload.md` for the complete security/crash-recovery lifecycle and `docs/media-s3-storage.md` for the S3 endpoint, signing, readiness and permission contract. Deeper content validation, asynchronous quarantine/reconciliation, object-lock/legal-hold policy and independent object-store lifecycle rules remain future hardening.

## Senders and templates

Sender endpoints:

```text
POST  /api/v1/phone-numbers
GET   /api/v1/phone-numbers
GET   /api/v1/phone-numbers/{senderId}
PATCH /api/v1/phone-numbers/{senderId}
```

Sender credentials are stored as runtime references such as:

```text
env:META_ACME_WHATSAPP_TOKEN
```

Raw Meta sender tokens are not stored in PostgreSQL.

Template endpoints:

```text
POST /api/v1/templates/sync
GET  /api/v1/templates
GET  /api/v1/templates/{templateId}
```

Templates are synchronized at WABA level. New template messages require an exact local `name + language + WABA` match with status `APPROVED`.

## Priority routing

Clients cannot choose priority. The server derives traffic class from trusted synchronized metadata.

| Source | Traffic class |
| --- | --- |
| `AUTHENTICATION` template | `OTP` |
| `MARKETING` template | `MARKETING` |
| `UTILITY` / other approved template | `TRANSACTIONAL` |
| Free-form text/media service message | `TRANSACTIONAL` |

Default queues:

```text
whatsapp.outbound.otp
whatsapp.outbound.transactional
whatsapp.outbound.marketing
```

The persisted PostgreSQL traffic class is authoritative. Queue-class mismatches fail closed before Meta delivery.

## Contacts, consent, and segments

Contacts maintain current consent plus an immutable consent-event history. Opt-out blocks new outbound messages. Inbound messages update the customer-service window monotonically.

Saved segments support bounded criteria only:

```text
language
tagsAny
tagsAll
```

They do not accept SQL, JavaScript, JSONPath, or arbitrary expressions.

```text
POST  /api/v1/segments
GET   /api/v1/segments
GET   /api/v1/segments/{segmentId}
GET   /api/v1/segments/{segmentId}/count
PATCH /api/v1/segments/{segmentId}
```

Segment evaluation always adds tenant ownership and current `OPTED_IN` on the server.

## Agent inbox and conversations

The inbox uses the existing contact/sender/message records and adds tenant-scoped operational state. A logical conversation is unique by `tenant + sender + contact`.

Agent endpoints:

```text
POST  /api/v1/inbox/agents
GET   /api/v1/inbox/agents
PATCH /api/v1/inbox/agents/{agentId}
```

Conversation endpoints:

```text
GET   /api/v1/inbox/conversations
GET   /api/v1/inbox/conversations/{conversationId}
PATCH /api/v1/inbox/conversations/{conversationId}
POST  /api/v1/inbox/conversations/{conversationId}/read
GET   /api/v1/inbox/conversations/{conversationId}/messages
POST  /api/v1/inbox/conversations/{conversationId}/notes
```

Conversation states are `OPEN`, `PENDING`, and `RESOLVED`; priorities are `LOW`, `NORMAL`, `HIGH`, and `URGENT`.

Inbound messages create or reopen the sender/contact conversation and increment unread state atomically with the persisted message. Duplicate provider message IDs are discarded before unread is changed, and out-of-order inbound webhooks cannot move activity timestamps backwards.

Free-form outbound text/media messages reuse the same conversation and link `Message.conversationId` inside the existing Message + Outbox transaction. Template traffic deliberately does not auto-create or reopen inbox conversations, so marketing/authentication/utility templates and campaign volume do not flood the human-support queue.

Agent and conversation administrative mutations are tenant-scoped and audited without copying agent identity values, message content, notes, or contact data into audit metadata. Internal note content lives only in `ConversationNote`.

See `docs/inbox.md` for concurrency semantics, assignment behavior, integration coverage, and deliberate foundation boundaries.

## Campaigns

```text
POST /api/v1/campaigns
GET  /api/v1/campaigns
GET  /api/v1/campaigns/{campaignId}
GET  /api/v1/campaigns/{campaignId}/recipients
GET  /api/v1/campaigns/{campaignId}/analytics
POST /api/v1/campaigns/{campaignId}/launch
POST /api/v1/campaigns/{campaignId}/pause
POST /api/v1/campaigns/{campaignId}/resume
POST /api/v1/campaigns/{campaignId}/cancel
```

Campaigns require an approved `MARKETING` template. Audience mode must be exactly one of `allOptedIn=true`, non-empty `contactIds`, or an active saved `segmentId`.

Launch runs under a row lock and repeatable-read transaction, selects currently opted-in contacts, and creates an immutable `CampaignRecipient` snapshot. Recipient processing uses leases and `FOR UPDATE SKIP LOCKED`, allowing multiple replicas and crash recovery.

Each recipient has a deterministic logical message key:

```text
campaign:<campaignId>:contact:<contactId>
```

Personalization is opt-in and resolves only allowlisted full-value contact tokens. No code or expression language is evaluated.

## Webhooks

Meta webhook endpoint:

```text
GET/POST /api/v1/webhooks/meta/whatsapp
```

POST requests require a valid `X-Hub-Signature-256` generated with `META_APP_SECRET`.

Processing path:

```text
verify signature -> persist raw event -> HTTP 200 -> process asynchronously
```

The durable processor handles inbound messages, delivery receipts, and template lifecycle updates. Inbound message processing also updates the agent-inbox conversation in the same transaction as message persistence.

## Health, metrics, and trace correlation

Public probes:

```text
GET /api/health
GET /api/health/live
GET /api/health/ready
```

Readiness checks PostgreSQL, Redis, RabbitMQ and the configured media-storage backend with bounded timeouts/diagnostics. Filesystem mode also enforces configured free-capacity reserves; S3 mode uses a signed bucket readiness check.

Tenant operational diagnostics:

```text
GET /api/v1/operations/snapshot
```

Prometheus metrics:

```text
GET /api/metrics
Authorization: Bearer <METRICS_BEARER_TOKEN>
```

Metrics labels are bounded and do not include tenant IDs, phones, message IDs, campaign IDs, payloads, raw dynamic paths, or user-provided strings.

Valid W3C `traceparent` and bounded `x-request-id` values propagate through HTTP, transactional outbox, RabbitMQ retry/DLQ flow, and outbound worker correlation. Span export to an external tracing backend remains a future slice.

See `docs/observability.md` and `ops/prometheus-alerts.yml`.

## Integration and load-smoke gate

The real-infrastructure integration job starts PostgreSQL 17, Redis 7, and RabbitMQ 4, applies production migrations, then runs the Nest API/worker against controlled test seams.

Core coverage proves:

```text
text/image message -> Message + Outbox -> RabbitMQ -> worker -> Redis -> Meta mock -> SUBMITTED
multipart media -> temp -> signature/scan -> MediaAsset planned key -> retained filesystem or S3 bytes -> Meta mock /media -> mediaId
expired retained MediaAsset -> backend binary delete -> registry delete -> detail 404
```

S3 coverage additionally requires the signed object PUT to complete before Meta upload, validates exact bytes/hash/content length, checks storage readiness and tenant retained-byte operations evidence, and then proves signed object deletion before expired registry metadata is removed.

Inbox coverage proves:

```text
signed Meta webhook -> WebhookEvent -> inbound processor -> Contact + Conversation + Message
conversation -> mark read -> agent assignment -> priority/state -> note -> resolve
later inbound -> same conversation reopened + unread
free-form outbound -> same conversationId + transactional outbox
```

The integration gate also proves message idempotency and trace persistence, then sends a default 50-message concurrent burst and requires zero transport errors, HTTP 202 for every accept, unique internal IDs, bounded p95 acceptance, eventual `SUBMITTED`, and an exact provider delivery count.

This CI burst is a regression test, not a production throughput certification. Dedicated capacity and soak tests are still required for production sizing.

### Meta test seam

The normal Graph host remains `https://graph.facebook.com`.

`META_GRAPH_API_BASE_URL` exists for controlled testing. HTTP overrides are accepted only under `NODE_ENV=test`; non-test environments require HTTPS. Embedded URL credentials, query strings, and fragments are rejected.

See `docs/testing.md` for local execution, test boundaries, staged capacity profiles, and failure/concurrency coverage.

## Supply-chain and Docker policy

The repository commits `package-lock.json` and CI uses deterministic installs.

Development/CI:

```bash
npm ci
```

Production runtime:

```bash
npm ci --omit=dev --omit=peer --omit=optional --ignore-scripts
npm run audit:prod
```

CI blocks high/critical vulnerabilities present in the actual installed production runtime tree. Docker image construction is a required gate after build, runtime-security, and integration.

## CI gates

Every pull request must pass:

1. deterministic `npm ci`;
2. Prisma generation;
3. ESLint;
4. TypeScript/Nest build;
5. unit tests;
6. production-runtime security validation;
7. real PostgreSQL/Redis/RabbitMQ integration and load smoke;
8. production Docker image build.

## Important environment variables

```text
DATABASE_URL
REDIS_URL
RABBITMQ_URL
API_KEY_HASH_SECRET
HEALTH_DEPENDENCY_TIMEOUT_MS
METRICS_BEARER_TOKEN
META_GRAPH_API_VERSION
META_APP_SECRET
META_WEBHOOK_VERIFY_TOKEN
META_HTTP_TIMEOUT_MS
META_MEDIA_UPLOAD_TIMEOUT_MS
MEDIA_MALWARE_SCAN_MODE
MEDIA_CLAMAV_HOST
MEDIA_CLAMAV_PORT
MEDIA_CLAMAV_TIMEOUT_MS
MEDIA_BINARY_STORAGE_MODE
MEDIA_FILESYSTEM_STORAGE_PATH
MEDIA_FILESYSTEM_MIN_FREE_BYTES
MEDIA_FILESYSTEM_MIN_FREE_PERCENT
MEDIA_S3_ENDPOINT
MEDIA_S3_BUCKET
MEDIA_S3_REGION
MEDIA_S3_ACCESS_KEY_ID
MEDIA_S3_SECRET_ACCESS_KEY
MEDIA_S3_SESSION_TOKEN
MEDIA_S3_TIMEOUT_MS
MEDIA_ASSET_TTL_DAYS
MEDIA_ASSET_CLEANUP_INTERVAL_MS
OUTBOUND_RETRY_DELAYS_MS
DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND
CAMPAIGN_MAX_RECIPIENTS
```

See `.env.example` for the complete documented configuration set.

Never commit production credentials or access tokens.

## Version metadata

`package.json` is the runtime version source. `src/version.ts` reads it and supplies both the OpenAPI version and the `apiWhatsApp/<version>` User-Agent used by Meta clients, preventing per-client version drift.

## Next implementation slices

- production capacity / soak / new incident-driven failure-injection test expansion
- OpenTelemetry span export and tracing-backend integration
- provider-backed secret stores beyond environment references
- asynchronous media quarantine/reconciliation, deeper content validation, and advanced object lifecycle/legal-hold policies
- realtime inbox delivery (SSE/WebSocket), teams/skills, routing policies, SLA/escalation and human-agent session/SSO integration
- optional inbox frontend application

## Repository workflow

Changes are developed through feature branches and pull requests. `main` is kept behind the complete CI gate chain listed above.
