# Outbound media messaging

Release `0.16.0` adds the first outbound media-message foundation to the existing tenant-scoped durable messaging pipeline.

## Supported message types

`POST /api/v1/messages` accepts:

```text
IMAGE
VIDEO
AUDIO
DOCUMENT
```

These types use the same authentication, tenant isolation, sender resolution, customer-service-window policy, transactional outbox, RabbitMQ routing, Redis sender capacity, retries, trace correlation, and Meta HTTP client used by existing free-form text messages.

There is no media-specific bypass around the normal outbound pipeline.

## Provider-neutral payload contract

Every media payload requires exactly one source:

```json
{ "id": "meta-media-id" }
```

or:

```json
{ "link": "https://cdn.example.com/path/file" }
```

`id` and `link` cannot be supplied together.

Links must be absolute HTTPS URLs. Embedded URL credentials and URL fragments are rejected. Query strings are allowed because controlled CDN or signed URLs may require them.

Unknown media fields fail closed.

## Type-specific fields

### IMAGE

```json
{
  "link": "https://cdn.example.com/photo.jpg",
  "caption": "Delivery photo"
}
```

Supported fields:

```text
id | link   exactly one required
caption     optional, maximum 1024 characters
```

### VIDEO

```json
{
  "id": "meta-video-id",
  "caption": "Product demonstration"
}
```

Supported fields:

```text
id | link   exactly one required
caption     optional, maximum 1024 characters
```

### AUDIO

```json
{
  "id": "meta-audio-id"
}
```

Supported fields:

```text
id | link   exactly one required
```

Captions and filenames are rejected for audio messages.

### DOCUMENT

```json
{
  "link": "https://cdn.example.com/invoice.pdf",
  "caption": "Invoice 48291",
  "filename": "invoice-48291.pdf"
}
```

Supported fields:

```text
id | link   exactly one required
caption     optional, maximum 1024 characters
filename    optional, maximum 240 characters
```

Document filenames containing control characters are rejected.

## Validation boundary

Media validation occurs before the Message/Outbox transaction. Invalid media payloads therefore do not create queued messages or outbox intents.

The Meta mapper validates the persisted payload again in the outbound worker before building the provider request. This second validation is intentional defense in depth for legacy/corrupt rows.

## Traffic and consent policy

Media messages are free-form service messages in this release. They therefore require an open customer-service window, just like free-form text messages.

They are classified as `TRANSACTIONAL` traffic by the existing server-side traffic classifier. Clients cannot override traffic class.

This release does not turn media messages into marketing-campaign content and does not relax template/opt-in rules.

## Storage boundary

Release `0.16.0` does not upload or store binary media in this service. It accepts an existing Meta media ID or an HTTPS URL that Meta can retrieve.

A future media-storage slice may add controlled upload, object storage, malware/content scanning, retention policy, and Meta Media API upload orchestration. Those capabilities are deliberately separate from this foundation.

## Integration coverage

The real-infrastructure CI suite includes an `IMAGE` message and verifies:

```text
HTTP POST /messages
  -> persisted Message + OutboxEvent
  -> RabbitMQ
  -> outbound worker
  -> Redis rate limiter
  -> HTTP Meta mock
  -> provider message ID
  -> SUBMITTED
```

The integration test verifies both the persisted normalized payload and the final Meta-compatible image request.

## Release metadata note

Administrative audit functionality was merged before this release under PR #16, while package/OpenAPI metadata remained at `0.14.0`. Release `0.16.0` intentionally corrects that metadata drift rather than rewriting repository history or publishing a misleading late `0.15.0` metadata-only state.
