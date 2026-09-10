# Media storage admission control

Filesystem readiness is a routing signal; upload admission is the enforcement backstop.

When `MEDIA_BINARY_STORAGE_MODE=filesystem`, each accepted multipart file is evaluated against the current filesystem capacity before malware scanning, tenant sender credential resolution, registry reservation, retained binary creation, or Meta provider access.

The same configured reserves used by readiness apply:

```text
MEDIA_FILESYSTEM_MIN_FREE_BYTES
MEDIA_FILESYSTEM_MIN_FREE_PERCENT
```

Admission projects free space **after** the prospective file is retained. A write is rejected when the projected free bytes or projected free percentage would cross either reserve, or when the file is larger than currently available space. The API returns a generic HTTP 503 and does not expose capacity details, filesystem paths, or tenant storage keys.

Readiness evaluates current capacity (`requiredBytes=0`). Admission evaluates projected capacity (`requiredBytes=<validated upload size>`). Both use the shared `evaluateMediaStorageCapacity` policy so boundary semantics remain identical.

The admission preflight cannot eliminate filesystem races: another replica or process can consume capacity after the check. The exclusive streaming filesystem write remains the final backstop and maps storage failures into the existing bounded `STORAGE_ERROR` lifecycle after registry reservation.

When binary retention is disabled, admission performs no filesystem capacity I/O and preserves the existing ephemeral upload path.

S3-compatible retention does not use this local capacity projection. The application validates S3 configuration and bucket readiness separately, while quota/capacity enforcement remains an object-store/operator responsibility. The upload path therefore does not invent a local free-space value for S3.
