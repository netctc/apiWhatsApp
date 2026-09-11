# Ogg Opus upload admission regression gate

The mono Opus parser is exercised both directly and through the real multipart
HTTP upload route. This gate is included automatically by the existing Jest
unit and integration configurations; no new workflow or production setting is
required.

## Execute

```bash
npm test -- test/media-ogg-opus-profile.spec.ts test/ogg-opus-upload-fixtures.spec.ts
npm run test:integration -- test/integration/ogg-opus-upload.integration.ts
```

The integration command requires the normal PostgreSQL, Redis and RabbitMQ
integration environment and generated Prisma client. It starts the actual Nest
application, authenticates using a real tenant API key, persists metadata in
PostgreSQL, and retains binaries in an isolated temporary filesystem directory.
Meta and ClamAV are controlled local HTTP/TCP services. It never contacts real
Meta or sends a WhatsApp message.

## Positive cases

Minimal mono Opus and a comment packet of exactly 64 KiB spanning two Ogg pages
must return HTTP 201 with the AUDIO category. The provider mock parses the
outgoing multipart body and requires byte-for-byte equality with the scanned
payload and the retained file. It also verifies that registry creation and
storage finalization happened before the provider request.

The registry detail must show ACTIVE, CLAMAV/CLEAN and binaryRetained without
revealing the internal storage key. The multipart temporary file must already
be absent when the HTTP response completes.

## Rejection cases

The shared fixture corpus includes codec-less Ogg, a foreign codec header,
stereo output, unsupported channel mapping, overflowing vendor lengths,
continued tags above 64 KiB, malformed or empty audio packets, missing comments,
chained streams, invalid CRCs, truncated pages and appended bytes.

Every rejected upload must return HTTP 400 with the bounded content-signature
error, without invoking storage planning/admission, scanning, sender credential
resolution, registry reservation or retained-byte staging. PostgreSQL row counts,
retained directory entries, scanner payloads and provider request counts remain
unchanged. The disk-backed multipart temporary file is removed on every path.

Separate cases require HTTP 422 for the test scanner marker in otherwise valid
Opus comments, HTTP 503 for valid audio with the required scanner offline, and
HTTP 400 for malformed audio even while that scanner is offline. Structural
validation must not bypass malware scanning or depend on its availability.

## Fixture and assurance boundaries

`test/helpers/ogg-opus-fixtures.ts` creates deterministic pages with valid Ogg
CRCs. Unit tests distinguish codec/profile rejection from generic-container
rejection, so a broken checksum cannot accidentally make a codec-policy test
pass. The continuation fixture exercises the exact 64 KiB comment limit.

This is an admission/order/cleanup regression gate, not a decoder certification,
real antivirus efficacy test, live Meta interoperability test or production load
benchmark. The scanner marker is only a local protocol-test marker, not a real
malware sample. No production parser behavior or accepted profile is changed.

Packet organization and comment-page boundaries follow RFC 7845 sections 3-5;
Opus packet framing is described in RFC 6716 section 3. The deliberately stricter
application profile remains documented in `media-audio-structure-validation.md`.

- RFC 7845: https://www.rfc-editor.org/rfc/rfc7845.html
- RFC 6716: https://www.rfc-editor.org/rfc/rfc6716.html
