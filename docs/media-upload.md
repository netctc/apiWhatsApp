# Meta media upload

Release `0.17.0` adds a controlled tenant-scoped upload endpoint for obtaining WhatsApp Cloud API media IDs. Subsequent hardening adds bounded content-signature validation and an optional fail-closed ClamAV malware scanning gate.

## Endpoint

```text
POST /api/v1/media
Content-Type: multipart/form-data
X-API-Key: <tenant API key>
```

Required scope:

```text
media:write
```

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
  -> resolve sender credential reference
  -> POST /{phone-number-id}/media to Meta
  -> return mediaId + safe technical metadata
  -> delete temporary file in finally
```

The service does not keep the binary after the provider request and does not create a media asset database row in this release.

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

## Response

Successful upload returns only safe technical metadata:

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

## Security boundaries

- Upload requires `media:write`; message sending remains a separate `messages:write` capability.
- `senderId` is resolved using the authenticated tenant before any provider credential is exposed to the upload client.
- The global/legacy worker sender resolver is not used for client-controlled interactive upload.
- Raw Meta access tokens are never returned and are still resolved from configured credential references.
- Raw Meta provider response bodies are not returned on upload failure.
- Unexpected multipart fields fail closed.
- The declared MIME type is cross-checked against a bounded server-side content signature/container inspection before sender credentials are resolved or Meta is called.
- When ClamAV scanning is enabled, the complete temporary file is streamed to `clamd` before sender resolution. Malware detection returns HTTP 422 and no provider call is attempted.
- Scanner connection, timeout, protocol, or configuration failures fail closed with HTTP 503 when scanning is enabled.
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

- `OK` allows processing to continue to tenant sender resolution;
- `FOUND` rejects the upload with HTTP 422;
- unavailable scanner, connection reset, timeout, malformed/error response, oversized response, invalid mode/host/port/timeout, or a closed connection without a result returns HTTP 503;
- no Meta sender credential is resolved and no provider request is made unless the scan succeeds.

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

Meta continues to validate the provider upload. Controlled quarantine/object storage, asynchronous scanning pipelines, an internal media asset registry, explicit retention/expiry policy, and deeper file-format/content validation remain future hardening slices.

## Integration coverage

The real-infrastructure CI suite keeps the existing direct multipart upload coverage and adds a dedicated scanning gate with a controlled ClamAV-compatible TCP server.

The clean scenario verifies:

```text
HTTP multipart request
  -> authenticated media:write scope
  -> disk-backed temporary file
  -> declared MIME + size policy
  -> bounded JPEG signature check
  -> ClamAV INSTREAM full-file scan -> OK
  -> tenant sender credential resolution
  -> native Node FormData
  -> Meta HTTP mock /media endpoint
  -> returned mediaId
```

The same integration suite also requires:

- the exact uploaded bytes received by the ClamAV test double;
- scanner-detected content to return HTTP 422 without a Meta request;
- scanner unavailability to return HTTP 503 without a Meta request.

Existing upload coverage continues to verify the provider Authorization header, multipart boundary, `messaging_product=whatsapp`, the generated provider filename, and that the original client filename is not forwarded.

Unit coverage validates representative signatures for every supported MIME family, ClamAV INSTREAM framing across multiple chunks, `FOUND` response mapping, disabled/default behavior, configuration failure, service-level scan ordering, fail-closed mapping, and temporary-file cleanup.
