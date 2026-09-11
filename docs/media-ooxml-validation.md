# Bounded OOXML package validation

Media upload performs a second structural validation step for Office Open XML document MIME types after the existing bounded prefix signature check.

The purpose of this step is package identity validation. It prevents an arbitrary ZIP file that only starts with `PK` from being accepted as a Word, Excel, or PowerPoint OOXML document.

It is not XML schema validation, active-content inspection, decompression, malware detection, or a replacement for ClamAV.

## Covered MIME types

The validator applies to:

```text
application/vnd.openxmlformats-officedocument.wordprocessingml.document
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
application/vnd.openxmlformats-officedocument.presentationml.presentation
```

The initial prefix check still requires a ZIP local-file-header signature. The file-aware validation then requires a complete bounded ZIP directory and package markers matching the declared MIME family.

## Required package identity

Every accepted OOXML package must contain exactly one central-directory entry for:

```text
[Content_Types].xml
```

It must also contain the root entry associated with the declared MIME type:

| Declared family | Required entry |
| --- | --- |
| DOCX | `word/document.xml` |
| XLSX | `xl/workbook.xml` |
| PPTX | `ppt/presentation.xml` |

A package containing a root marker for a different OOXML family is rejected. A package containing roots for multiple families is also rejected instead of guessing which interpretation is authoritative.

For `[Content_Types].xml` and the required family root, the central-directory filename must match the filename in the referenced local file header. The validator does not trust a fabricated central-directory name without checking its local-header reference.

## ZIP structural boundary

Validation is intentionally bounded and does not extract entries.

The validator:

- searches only the final ZIP End of Central Directory search window;
- requires a valid single-disk End of Central Directory record;
- requires the central directory to end immediately before that record;
- limits the central directory to 4 MiB;
- limits the package to 10,000 central-directory entries;
- rejects truncated central-directory records;
- rejects duplicate entry names;
- rejects encrypted entries;
- rejects multi-disk metadata;
- rejects ZIP64 sentinel metadata rather than following unbounded ZIP64 extensions;
- rejects required local-header offsets or names that do not match the central directory.

The upload policy already caps document uploads at 100 MB, so the ZIP64 restriction is compatible with the intended WhatsApp media-upload boundary. If a future provider/use case requires larger OOXML packages, ZIP64 support should be implemented as a separately bounded parser rather than silently relaxing this check.

## Processing order

The validation remains at the existing content-signature boundary:

```text
multipart temporary file
  -> declared MIME/size policy
  -> bounded prefix signature
  -> bounded OOXML package identity when applicable
  -> binary-storage planning/admission
  -> optional ClamAV scan
  -> sender credential resolution
  -> MediaAsset reservation
  -> retained storage when enabled
  -> Meta media upload
```

An invalid OOXML package therefore does not reach storage staging, malware scanning, sender credential resolution, registry reservation, or Meta provider access.

The public failure contract remains unchanged: a package that does not match its declared MIME type is rejected through the existing media content-signature error mapping.

## Security boundary

This validator deliberately does **not**:

- decompress document entries;
- evaluate XML or relationships;
- validate OOXML schemas;
- inspect macros, embedded objects, formulas, links, or external relationships;
- calculate decompression ratios;
- detect malware;
- sanitize document content.

Those concerns belong to deeper document inspection and asynchronous quarantine/reconciliation hardening. ClamAV remains the current optional malware boundary and runs after format identity validation.
