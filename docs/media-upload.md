# Meta media upload

Release `0.17.0` adds a controlled tenant-scoped upload endpoint for obtaining WhatsApp Cloud API media IDs.

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
- Temporary files are deleted in `finally` after success, MIME/signature rejection, sender/provider failure, or other service-level errors.
- Provider logs contain only safe technical sender/status/code/retryability data and never the token, file bytes, original filename, or provider response body.

## Temporary storage

Uploads are written to the operating system temporary directory using generated filenames rather than buffered in Node.js memory. This prevents a permitted large document upload from consuming an equivalent application heap buffer.

Operators must ensure the runtime has sufficient ephemeral disk capacity and normal OS/container isolation for the temporary directory. The file exists only for the duration of the synchronous validation/provider upload path.

The signature check reads at most the first 8 KiB of the temporary file and therefore does not introduce a second full-file memory copy.

## Timeouts and failure mapping

Media upload has a timeout independent of normal message/template calls:

```text
META_MEDIA_UPLOAD_TIMEOUT_MS=120000
```

Accepted configuration range is 1,000 to 600,000 milliseconds.

Retryable Meta/network failures return HTTP 503 with a generic message. Permanent Meta rejection returns HTTP 502 with a generic message. Provider payload details are deliberately not exposed to API consumers.

A supported declared MIME type whose file prefix does not match the expected signature/container is rejected locally with HTTP 400 before provider access.

## Content validation boundary

The upload path now validates the declared MIME type, file size, and a bounded content signature/container prefix before resolving sender credentials or calling Meta.

Current checks are intentionally conservative:

- JPEG and PNG use their standard binary signatures;
- PDF requires a `%PDF-` marker near the beginning of the file;
- Ogg, AAC/ADIF, MP3 and AMR use their common stream/file signatures;
- MP4 audio/video require an ISO Base Media File Format `ftyp` marker;
- `video/3gpp` additionally requires a 3GP/3G2-compatible brand marker;
- legacy Word/Excel/PowerPoint MIME types require the shared OLE compound-document signature;
- OOXML Word/Excel/PowerPoint MIME types require the ZIP container signature;
- `text/plain` receives a basic binary/NUL-byte screen because plain text has no stable magic signature.

These checks validate the declared type at the signature or shared-container level. They do **not** verify media codecs, parse the complete Office/ZIP structure, transcode media, perform malware scanning, or run document content inspection. A syntactically matching container can still contain unsafe or semantically invalid content.

Meta continues to validate the provider upload. Deployments that accept untrusted end-user files should add malware/content scanning plus controlled quarantine/object storage and explicit retention/expiry policy before treating uploads as trusted assets.

## Integration coverage

The real-infrastructure CI suite uploads a small JPEG through the live Nest endpoint and verifies:

```text
HTTP multipart request
  -> authenticated media:write scope
  -> tenant sender
  -> disk-backed temporary file
  -> declared MIME + size policy
  -> bounded JPEG signature check
  -> native Node FormData
  -> Meta HTTP mock /media endpoint
  -> returned mediaId
```

The test also verifies the provider Authorization header, multipart boundary, `messaging_product=whatsapp`, the generated provider filename, and that the original client filename is not forwarded.

Unit coverage validates representative signatures for every supported MIME family and explicitly verifies that a PNG declared as `image/jpeg` is rejected before tenant sender resolution/provider access while the temporary file is still deleted.
