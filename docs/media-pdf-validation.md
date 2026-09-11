# Bounded PDF structure validation

PDF media uploads use a file-aware structural check after the existing bounded `%PDF-` prefix signature gate. The purpose is to reject trivial PDF-like/polyglot files that contain a PDF header but do not expose a coherent final cross-reference boundary.

This validation is intentionally bounded. It is not a full PDF parser, sanitizer, active-content scanner, or malware engine.

## Required structure

An accepted PDF must satisfy all of the following:

- a versioned `%PDF-<version>` header is present within the first 1,024 bytes;
- the final 64 KiB contains a `startxref` section followed by `%%EOF`;
- only PDF whitespace may follow the final `%%EOF` marker;
- the `startxref` value is a safe in-file byte offset;
- the referenced offset starts either a classic `xref` table or an indirect object suitable for an xref stream.

The validator supports both classic cross-reference tables and modern cross-reference streams. It also accepts leading bytes before the PDF header within the existing first-KiB compatibility boundary.

## Bounded reads

The implementation never loads the whole document into memory for this check. It reads at most:

```text
1 KiB   header search
64 KiB  final startxref/EOF search
128 B   cross-reference target inspection
```

The normal media upload policy separately caps documents at 100 MB.

## Processing order

PDF structural validation remains within the existing media content-signature boundary:

```text
multipart temporary file
  -> declared MIME/size policy
  -> bounded prefix signature
  -> bounded PDF structure validation
  -> binary-storage planning/admission
  -> optional ClamAV scan
  -> sender credential resolution
  -> MediaAsset reservation
  -> retained storage when enabled
  -> Meta media upload
```

A rejected PDF therefore does not reach retained storage, malware scanning, credential resolution, registry reservation, or Meta provider access.

The API failure mapping is unchanged: a structurally rejected PDF is reported through the existing media content-signature mismatch contract.

## Security boundary

This check deliberately does **not**:

- parse the complete xref table or xref stream;
- validate every object offset;
- decompress streams;
- evaluate object graphs, JavaScript, actions, forms, annotations, or embedded files;
- verify signatures or certificates;
- sanitize document content;
- detect malware.

Those concerns belong to deeper document inspection, asynchronous quarantine/reconciliation, and malware scanning. ClamAV remains the optional malware boundary.
