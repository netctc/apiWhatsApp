# Bounded JPEG and PNG structure validation

JPEG and PNG media uploads use a file-aware structural gate after the existing bounded signature check. The goal is to reject prefix-only, truncated, malformed-container, and simple polyglot inputs before storage, malware scanning, credential access, registry reservation, or Meta upload.

This validation covers:

```text
image/jpeg
image/png
```

It is intentionally not an image decoder and does not claim to prove that every compressed pixel stream can be decoded successfully.

## JPEG boundary

JPEG validation requires the file to:

- start with the SOI marker (`FFD8`);
- end exactly with the EOI marker (`FFD9`), with no trailing bytes;
- expose a structurally valid marker sequence before the first scan;
- contain at least one Start Of Frame marker before Start Of Scan;
- use non-zero frame width, height, and component count;
- use a frame segment length consistent with its component count;
- use a Start Of Scan segment length consistent with its component count;
- contain at least one byte after the SOS header before the final EOI;
- stay within a bounded maximum of 1,024 pre-scan markers.

The validator reads marker headers and bounded frame/scan metadata by offset. It does not load the complete JPEG into Node.js heap.

The current boundary stops after validating the first SOS header and the exact final EOI position. It does **not** decode or fully validate entropy-coded scan data, Huffman/quantization semantics, restart intervals, progressive scan completeness, color profiles, metadata payloads, or pixel output.

## PNG boundary

PNG validation requires:

- the exact eight-byte PNG signature;
- `IHDR` as the first chunk and exactly once;
- valid non-zero dimensions;
- a valid PNG bit-depth/color-type combination;
- compression/filter method `0` and interlace method `0` or `1`;
- alphabetic four-byte chunk types with the PNG reserved bit clear;
- no unknown critical chunks;
- CRC-32 validation for every chunk;
- at least one `IDAT` chunk;
- consecutive `IDAT` chunks;
- `PLTE` before `IDAT` where present;
- mandatory `PLTE` for indexed-color images;
- no `PLTE` for grayscale/grayscale-alpha images;
- palette size between one and 256 entries and, for indexed color, no more entries than the declared bit depth can address;
- `IEND` with zero data bytes as the final chunk;
- no bytes after `IEND`;
- at most 10,000 chunks.

Chunk CRC data is processed in 64 KiB reads. The accepted image upload size is already capped by the media policy, so CRC traversal remains bounded by the upload limit.

The validator does not inflate or decode `IDAT` data. It therefore does not validate the complete zlib/DEFLATE stream, scanline filter output, decompressed byte count, pixel semantics, ancillary metadata content, or rendered image.

## Processing order

Image structural validation runs within the existing content-signature boundary:

```text
multipart temporary file
  -> declared MIME/size policy
  -> bounded signature identity
  -> JPEG/PNG structural validation
  -> binary-storage planning/admission
  -> optional ClamAV scan
  -> sender credential resolution
  -> MediaAsset reservation
  -> retained storage when enabled
  -> Meta media upload
```

A structurally invalid image uses the existing `MediaContentSignatureError` path and cannot reach storage staging, ClamAV, sender credentials, MediaAsset reservation, retained storage, or Meta provider access.

## Security boundary

This layer is structural identity validation, not content sanitization.

It deliberately does **not**:

- decode JPEG entropy data or PNG DEFLATE data;
- inspect EXIF, XMP, ICC, textual, or other ancillary metadata for active or malicious content;
- normalize or re-encode images;
- enforce visual dimensions beyond non-zero values;
- calculate decompression ratios or rendered-memory cost;
- detect image-library vulnerabilities;
- detect malware.

Optional ClamAV scanning remains the malware boundary. Future deeper media hardening may add decoder-backed validation, metadata policy, image normalization, or asynchronous quarantine without weakening this bounded pre-provider gate.
