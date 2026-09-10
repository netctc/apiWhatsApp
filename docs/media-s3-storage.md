# S3-compatible retained media storage

The media upload path can optionally retain the scanned upload in a private S3-compatible bucket before the same request is sent to Meta.

This backend reuses the existing `MediaAsset` lifecycle. It does not add a second public media-serving API, expose object URLs, or persist object-storage credentials in PostgreSQL.

## Enable the backend

```text
MEDIA_BINARY_STORAGE_MODE=s3
MEDIA_S3_ENDPOINT=https://s3.example.internal
MEDIA_S3_BUCKET=whatsapp-media
MEDIA_S3_REGION=us-east-1
MEDIA_S3_ACCESS_KEY_ID=<runtime-secret>
MEDIA_S3_SECRET_ACCESS_KEY=<runtime-secret>
MEDIA_S3_SESSION_TOKEN=
MEDIA_S3_TIMEOUT_MS=30000
```

`MEDIA_S3_SESSION_TOKEN` is optional and supports temporary credentials.

The access key, secret key, and optional session token are process/runtime configuration only. `MediaAsset` stores only the backend mode and the server-generated logical object key.

## Endpoint policy

`MEDIA_S3_ENDPOINT` must be an absolute endpoint origin. The application rejects:

- embedded username/password credentials;
- query strings;
- URL fragments;
- endpoint path prefixes;
- plaintext HTTP outside `NODE_ENV=test`.

The first S3 slice deliberately uses path-style requests:

```text
https://<endpoint>/<bucket>/<tenant-uuid>/<asset-uuid>
```

The bucket and object key are operator/server configuration. API clients cannot supply either value.

## Upload sequence

For `MEDIA_BINARY_STORAGE_MODE=s3`, the media path is:

```text
multipart temp file
  -> MIME/size validation
  -> bounded content-signature validation
  -> optional ClamAV scan
  -> create MediaAsset registry row
  -> stream SHA-256 calculation from disk
  -> signed S3 PUT from a second disk stream
  -> set MediaAsset.storedAt
  -> upload the same temporary file to Meta
  -> set provider media ID / providerUploadedAt
  -> delete local temporary file in finally
```

The object-storage PUT completes before Meta is called. A storage failure therefore fails the request closed before provider upload.

The SHA-256 pass and PUT pass are both streaming. Large accepted documents are not copied into a full in-memory buffer.

## Signature V4

Requests use AWS Signature Version 4 with service `s3`.

For PUT requests the application:

1. computes the full file SHA-256 by streaming the disk-backed upload;
2. sends the same hash in `x-amz-content-sha256`;
3. includes that hash in the canonical request;
4. signs the request with the configured region and credentials;
5. streams the file body with an explicit `Content-Length`.

`UNSIGNED-PAYLOAD` is not used in this foundation.

Temporary session credentials add `x-amz-security-token` to both the request and signed headers.

The unit test suite checks the signing implementation against the published Amazon S3 GET-object Signature V4 test vector in addition to controlled HTTP behavior.

## Readiness

`GET /api/health/ready` delegates configured media-storage readiness to the active backend.

For S3 mode the application sends a signed `HEAD` request to the configured bucket path.

A successful response reports:

```json
{
  "status": "up",
  "mode": "s3"
}
```

Invalid S3 configuration reports the bounded code:

```json
{
  "status": "down",
  "mode": "s3",
  "error": "not_configured"
}
```

Network, timeout, authorization, bucket, or other non-success responses report:

```json
{
  "status": "down",
  "mode": "s3",
  "error": "unavailable"
}
```

No endpoint URL, bucket name, access key, secret key, session token, or object key is exposed by readiness.

When S3 is the configured media backend, a down media-storage diagnostic makes overall readiness `not_ready` just as an unavailable configured filesystem does.

## Retention cleanup

The existing `MediaAssetRetentionService` remains authoritative for application-side expiry.

For an expired S3 asset the cleanup order is:

```text
signed S3 DELETE object
  -> delete MediaAsset row
```

HTTP 404 during S3 DELETE is treated as idempotent success because the desired retained-binary state has already been reached.

Other deletion failures keep the registry row so a later cleanup iteration can retry. Metadata is not deleted first.

`MEDIA_ASSET_TTL_DAYS` and `MEDIA_ASSET_CLEANUP_INTERVAL_MS` have the same meaning for filesystem and S3 storage.

## Tenant isolation

Object keys are generated only by the server:

```text
<tenant UUID>/<MediaAsset UUID>
```

The S3 client rejects keys outside that exact two-UUID shape. A client-supplied filename is never used as an object key.

Media read APIs continue to return safe lifecycle evidence only. They do not return `storageKey`, bucket information, endpoint information, or storage credentials.

`GET /api/v1/operations/snapshot` counts retained binaries and bytes across all persistent backends using tenant-scoped `MediaAsset` rows.

## Required object-storage permissions

The runtime principal must be able to perform the operations used by this backend against the configured bucket:

- bucket readiness check;
- object upload;
- object deletion during retention cleanup.

Keep the bucket private and scope permissions to the dedicated media bucket/prefix. The application does not need public-read access and does not generate public object URLs.

## Failure boundaries

The backend deliberately does not:

- make S3 objects public;
- provide object download/proxy endpoints;
- use multipart S3 upload for very large objects;
- auto-create buckets;
- discover regions automatically;
- accept tenant-controlled endpoints/buckets/credentials;
- replicate or lifecycle objects independently of the application registry;
- guarantee that Meta accepted content can be recalled after a provider request succeeds.

The current application upload limit is 100 MB, so a single signed streaming PUT remains bounded for this slice. Multipart object upload can be added later if application limits expand materially.

## CI coverage

Unit coverage verifies:

- the published S3 Signature V4 vector;
- temporary security-token signing;
- exact PUT body bytes and `Content-Length`;
- full payload SHA-256 signing;
- signed bucket HEAD readiness;
- DELETE 404 idempotency;
- rejection of plaintext non-test endpoints;
- routing through the existing media binary storage abstraction.

The real-infrastructure integration gate additionally proves:

```text
HTTP multipart upload
  -> tenant authentication
  -> MediaAsset
  -> S3-compatible signed PUT
  -> Meta /media
  -> tenant media lookup / operations evidence
  -> force asset expiry
  -> S3-compatible signed DELETE
  -> MediaAsset deletion
```

The integration test requires S3 PUT to occur before the Meta provider call and verifies that the retained bytes are exactly the uploaded bytes.
