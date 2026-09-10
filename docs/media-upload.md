# Meta media upload

Release `0.17.0` adds a controlled tenant-scoped upload endpoint for obtaining WhatsApp Cloud API media IDs. Subsequent hardening adds bounded content-signature validation, optional fail-closed ClamAV malware scanning, and a tenant-scoped media asset registry with local metadata retention.

## Endpoints

Upload:

```text
POST /api/v1/media
Content-Type: multipart/form-data
X-API-Key: <tenant API key>
Required scope: media:write
```

Registry reads:

```text
GET /api/v1/media
GET /api/v1/media/{assetId}
X-API-Key: <tenant API key>
Required scope: media:read
```

The list endpoint is deliberately bounded to the latest 100 tenant records. Detail lookup uses the internal `assetId` and returns 404 for invalid IDs, missing records, and records owned by another tenant so cross-tenant existence is not disclosed.

Multipart fields:

```text
file       required, exactly one file
senderId   optional tenant-scoped WhatsApp sender UUID
```

No other multipart text fields are accepted. Tenant identity always comes from the authenticated API key and cannot be supplied in the form body.

If `senderId` is omitted, the tenant's active default sender is used.

## Processing path

```text
authenticate + authorize
  -> Multer disk-backed temporary file
  -> validate allowed multipart fields
  -> validate declared MIME + size policy
  -> inspect bounded file signature/container prefix
  -> optional fail-closed ClamAV INSTREAM malware scan
  -> resolve sender inside authenticated tenant
  -> reserve expiring MediaAsset metadata as PENDING/UPLOADING
  -> resolve sender credential reference
  -> POST /{phone-number-id}/media to Meta
  -> finalize MediaAsset with provider media ID/timestamp or failure code
  -> return mediaId + safe technical metadata
  -> delete temporary file in finally
```

The service does not retain uploaded binary content. `MediaAsset` stores lifecycle and security metadata only; controlled quarantine/object storage remains a separate future slice.

## Supported upload policy

Limits are enforced in decimal MB so the application does not exceed the published provider limits because of MiB/MB ambiguity.

| Category | MIME types | Max size |
| --- | --- | ---: |
| Image | `image/jpeg`, `image/png` | 5 MB |
| Audio | `audio/aac`, `audio/mp4`, `audio/mpeg`, `audio/amr`, `audio/ogg` | 16 MB |
| Video | `video/mp4`, `video/3gpp` | 16 MB |
| Document | `text/plain`, PDF, Word, Excel, PowerPoint legacy/OOXML MIME types | 100 MB |

The multipart parser also applies a 100 MB global file limit and accepts only one file.

Server-side provider filenames are generated from the approved MIME policy (`upload.jpg`, `upload.pdf`, etc.). The client-supplied original filename is not forwarded to Meta.

## Upload response

Successful upload keeps the original API response contract:

```json
{
  "mediaId": "<meta-media-id>",
  "senderId": "<internal-tenant-sender-id>",
  "category": "IMAGE",
  "mimeType": "image/jpeg",
  "size": 48123
}
```

The resulting `mediaId` can be passed to the existing message endpoint, for example:

```json
{
  "to": "+96170123456",
  "type": "IMAGE",
  "payload": {
    "id": "<meta-media-id>",
    "caption": "Delivery photo"
  }
}
```

The associated registry row can be discovered through `GET /api/v1/media` and then retrieved by its internal `assetId`.

## Media asset registry

Every upload that passes local MIME/signature scanning and tenant sender resolution reserves a `MediaAsset` row before provider upload. The row contains only technical metadata:

- tenant and internal sender IDs;
- provider media ID after a successful Meta response;
- category, normalized MIME type, and byte size;
- scan mode/status (`DISABLED/NOT_SCANNED` or `CLAMAV/CLEAN`);
- provider upload timestamp when known;
- local expiration timestamp;
- bounded technical failure code/timestamp when the provider stage fails;
- created/updated timestamps.

No original filename, binary content, Meta access token, scanner malware signature, provider response body, phone/contact identity, or message payload is copied into the registry.

Registry states are derived from durable fields rather than stored separately:

```text
UPLOADING  providerMediaId absent and no failure code
ACTIVE     providerMediaId present and local expiresAt is in the future
EXPIRED    providerMediaId present and local expiresAt has passed
FAILED     failureCode present
```

A provider media ID is unique only inside its tenant boundary. This avoids using an external identifier as a cross-tenant namespace assumption.

## Local metadata retention

The registry TTL is application metadata retention only. It does not claim, extend, shorten, or otherwise represent Meta's provider-side media retention semantics.

```text
MEDIA_ASSET_TTL_DAYS=30
```

Accepted values are whole days from 1 through 3650. Invalid configuration fails new uploads before sender credential resolution/provider access.

The expiration timestamp is assigned when the registry row is reserved, before the Meta request. Therefore `UPLOADING`, `FAILED`, and successful records all have the same bounded retention horizon, including residue left by an interrupted process.

Expired registry metadata is removed by an idempotent periodic cleanup service:

```text
MEDIA_ASSET_CLEANUP_INTERVAL_MS=3600000
```

Accepted interval values are 60,000 through 86,400,000 milliseconds. Cleanup runs once at application bootstrap and then periodically. Multiple API replicas may execute the same `DELETE ... WHERE expiresAt <= now` policy safely; no cross-replica lease is required because deletion is idempotent.

Between `expiresAt` and the next cleanup run, reads can still return a row with derived state `EXPIRED`. After cleanup the same tenant-scoped detail lookup returns 404.

## Security boundaries

- Upload requires `media:write`; registry reads require the separate `media:read` capability; message sending remains a separate `messages:write` capability.
- `senderId` is resolved using the authenticated tenant before any provider credential is exposed to the upload client.
- The global/legacy worker sender resolver is not used for client-controlled interactive upload.
- Raw Meta access tokens are never returned and are still resolved from configured credential references.
- Raw Meta provider response bodies are not returned on upload failure or stored in the registry.
- Unexpected multipart fields fail closed.
- The declared MIME type is cross-checked against a bounded server-side content signature/container inspection before sender credentials are resolved or Meta is called.
- When ClamAV scanning is enabled, the complete temporary file is streamed to `clamd` before sender resolution. Malware detection returns HTTP 422 and no provider or registry record is created.
- Scanner connection, timeout, protocol, or configuration failures fail closed with HTTP 503 when scanning is enabled.
- The registry row is reserved before the Meta call so provider failures have a durable technical lifecycle record.
- Temporary files are deleted in `finally` after success, MIME/signature rejection, malware rejection, scanner failure, sender/provider failure, or other service-level errors.
- Provider/scanner logs contain only bounded technical outcome data and never the token, file bytes, original filename, malware signature returned by the scanner, or provider response body.

## Temporary storage

Uploads are written to the operating system temporary directory using generated filenames rather than buffered in Node.js memory. This prevents a permitted large document upload from consuming an equivalent application heap buffer.

Operators must ensure the runtime has sufficient ephemeral disk capacity and normal OS/container isolation for the temporary directory. The file exists only for the duration of the synchronous validation/scanning/provider-upload path.

The signature check reads at most the first 8 KiB of the temporary file and therefore does not introduce a second full-file memory copy. ClamAV scanning also remains streaming: the service reads the temporary file in bounded chunks and sends the standard `INSTREAM` framing over TCP rather than loading the whole object into the Node.js heap.

## Malware scanning

Malware scanning is opt-in so existing deployments are not broken merely by upgrading. The default remains:

```text
MEDIA_MALWARE_SCAN_MODE=disabled
```

To require ClamAV:

```text
MEDIA_MALWARE_SCAN_MODE=clamav
MEDIA_CLAMAV_HOST=127.0.0.1
MEDIA_CLAMAV_PORT=3310
MEDIA_CLAMAV_TIMEOUT_MS=120000
```

`MEDIA_CLAMAV_PORT` must be an integer from 1 through 65535. `MEDIA_CLAMAV_TIMEOUT_MS` accepts 1,000 through 600,000 milliseconds.

The application uses the clamd TCP `INSTREAM` command. Each file chunk is length-prefixed with a four-byte big-endian size and the stream ends with a zero-length chunk. Scanner responses are bounded before parsing.

Operational behavior when `clamav` mode is enabled:

- `OK` allows processing to continue to tenant sender resolution and registry reservation;
- `FOUND` rejects the upload with HTTP 422;
- unavailable scanner, connection reset, timeout, malformed/error response, oversized response, invalid mode/host/port/timeout, or a closed connection without a result returns HTTP 503;
- no Meta sender credential is resolved, registry row is created, or provider request is made unless the scan succeeds.

The service deliberately does not expose the malware signature string returned by ClamAV to API clients or application logs.

## Timeouts and failure mapping

Media upload has a timeout independent of normal message/template calls:

```text
META_MEDIA_UPLOAD_TIMEOUT_MS=120000
```

Accepted configuration range is 1,000 to 600,000 milliseconds.

ClamAV has its own bounded timeout:

```text
MEDIA_CLAMAV_TIMEOUT_MS=120000
```

Retryable Meta/network failures return HTTP 503 with a generic message. Permanent Meta rejection returns HTTP 502 with a generic message. Provider payload details are deliberately not exposed to API consumers.

A supported declared MIME type whose file prefix does not match the expected signature/container is rejected locally with HTTP 400 before scanning or provider access. Scanner-detected malware returns HTTP 422. A required scanner that cannot produce a trustworthy result returns HTTP 503.

## Content validation boundary

The upload path validates the declared MIME type, file size, and a bounded content signature/container prefix before resolving sender credentials or calling Meta. Deployments can additionally require complete-file malware scanning through ClamAV before that credential boundary.

Current signature checks are intentionally conservative:

- JPEG and PNG use their standard binary signatures;
- PDF requires a `%PDF-` marker near the beginning of the file;
- Ogg, AAC/ADIF, MP3 and AMR use their common stream/file signatures;
- MP4 audio/video require an ISO Base Media File Format `ftyp` marker;
- `video/3gpp` additionally requires a 3GP/3G2-compatible brand marker;
- legacy Word/Excel/PowerPoint MIME types require the shared OLE compound-document signature;
- OOXML Word/Excel/PowerPoint MIME types require the ZIP container signature;
- `text/plain` receives a basic binary/NUL-byte screen because plain text has no stable magic signature.

These checks validate the declared type at the signature or shared-container level. They do **not** verify media codecs, parse the complete Office/ZIP structure, transcode media, or perform semantic document/content inspection. ClamAV scanning reduces malware risk but is not a guarantee that a file is benign or policy-compliant.

Meta continues to validate the provider upload. Controlled quarantine/object storage, asynchronous scanning pipelines, and deeper file-format/content validation remain future hardening slices. The internal metadata registry and explicit local retention/expiry policy are implemented, but no binary object is retained by the application.

## Integration coverage

The real-infrastructure CI suite keeps direct multipart upload/scanning coverage and adds a dedicated registry lifecycle scenario against PostgreSQL.

The successful registry scenario verifies:

```text
HTTP multipart request
  -> authenticated media:write scope
  -> disk-backed temporary file
  -> declared MIME + size policy
  -> bounded JPEG signature check
  -> optional malware scan
  -> tenant sender resolution
  -> expiring MediaAsset reservation
  -> Meta HTTP mock /media endpoint
  -> providerMediaId finalization
  -> media:read tenant-scoped list/detail
```

The registry integration additionally requires:

- provider IDs and rows to remain tenant-scoped;
- a write-only key to receive 403 from registry reads;
- another tenant to receive 404 for a foreign `assetId`;
- local TTL to produce derived `EXPIRED` state before cleanup;
- the retention service to delete expired rows against real PostgreSQL;
- the deleted detail lookup to return 404.

The scanning integration requires the exact uploaded bytes received by the ClamAV test double, scanner-detected content to return HTTP 422 without a Meta request, and scanner unavailability to return HTTP 503 without a Meta request.

Existing upload coverage continues to verify the provider Authorization header, multipart boundary, `messaging_product=whatsapp`, the generated provider filename, and that the original client filename is not forwarded.

Unit coverage validates representative signatures for every supported MIME family, ClamAV INSTREAM framing across multiple chunks, scan ordering/fail-closed mapping, registry reservation before provider access, TTL assignment for successful and failed lifecycles, tenant-scoped reads, and retention cleanup configuration/query behavior.
