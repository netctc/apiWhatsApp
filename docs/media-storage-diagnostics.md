# Media storage diagnostics runbook

This runbook covers the operational signals added for optional retained media filesystem storage. It complements `docs/media-upload.md` and `docs/observability.md`.

## Readiness contract

`GET /api/health/ready` includes a `mediaStorage` dependency alongside PostgreSQL, Redis, and RabbitMQ.

When binary retention is disabled:

```json
{
  "status": "up",
  "mode": "disabled"
}
```

Disabled storage does not prevent the API from becoming ready.

When `MEDIA_BINARY_STORAGE_MODE=filesystem`, readiness requires all of the following:

- a valid absolute, non-root `MEDIA_FILESYSTEM_STORAGE_PATH`;
- the configured path to exist and be a directory;
- read/write access for the API process;
- a successful filesystem capacity probe;
- free bytes greater than or equal to `MEDIA_FILESYSTEM_MIN_FREE_BYTES`;
- free percentage greater than or equal to `MEDIA_FILESYSTEM_MIN_FREE_PERCENT`.

Default reserve thresholds:

```text
MEDIA_FILESYSTEM_MIN_FREE_BYTES=1073741824
MEDIA_FILESYSTEM_MIN_FREE_PERCENT=5
```

Either individual threshold can be disabled with `0`.

A required storage failure makes the overall readiness report `not_ready` and the HTTP endpoint returns 503. Error values are deliberately bounded:

```text
not_configured
unavailable
low_capacity
timeout
```

The readiness response never exposes `MEDIA_FILESYSTEM_STORAGE_PATH`, tenant IDs, storage keys, media IDs, or filenames.

## Capacity interpretation

The filesystem probe reports aggregate capacity for the configured mount:

```text
totalBytes
freeBytes
freePercent
minimumFreeBytes
minimumFreePercent
```

This is intentionally different from tenant inventory. A shared filesystem can contain allocation overhead, partial crash residue, unrelated operator files, or data for many tenants. Use the filesystem readiness values to decide whether the replica can safely accept retained media writes.

A `low_capacity` result means at least one configured reserve has been crossed. Operators should restore capacity before returning the replica to normal traffic. Raising the thresholds can be used to create a larger operational safety margin; setting them too low can allow the mount to fill before traffic is removed.

## Tenant inventory

`GET /api/v1/operations/snapshot` with `operations:read` includes tenant-scoped media inventory computed from PostgreSQL:

```json
{
  "mediaAssets": {
    "total": 120,
    "providerUploaded": 112,
    "failed": 8,
    "expired": 4,
    "retainedBinaries": 96,
    "retainedBytes": 48321536,
    "expiringWithin24Hours": 17
  }
}
```

Definitions:

- `total`: all retained registry rows for the tenant;
- `providerUploaded`: rows with a provider media ID;
- `failed`: rows with a bounded failure code;
- `expired`: rows whose local `expiresAt` is already in the past and are awaiting/undergoing cleanup;
- `retainedBinaries`: rows with both an internal storage key and finalized `storedAt`;
- `retainedBytes`: sum of the original upload sizes for those retained-binary rows;
- `expiringWithin24Hours`: non-expired rows whose local TTL ends in the next 24 hours.

The operations snapshot does not walk the filesystem and therefore remains bounded. It never returns storage keys or filesystem paths.

## Expected differences between filesystem and registry metrics

Do not expect registry `retainedBytes` to equal filesystem consumed bytes exactly. Differences can occur because:

- filesystem block allocation differs from logical file size;
- a process can die after a planned storage key is persisted but before `storedAt` is finalized;
- a cleanup attempt can retain metadata after a failed binary deletion;
- the mount can contain operator-managed or unrelated files;
- multiple tenants share the same mount.

For this reason the readiness gate trusts the filesystem capacity probe, while tenant inventory trusts PostgreSQL lifecycle metadata.

## Retention interaction

Media retention cleanup deletes the filesystem object before deleting the expired registry row. If binary deletion fails, the row remains so a later cleanup attempt retains the only application reference to that path.

A rising `expired` count together with falling filesystem free space can indicate cleanup/storage failures. A high `expiringWithin24Hours` value predicts upcoming cleanup work and can help operators correlate temporary disk-pressure relief with the configured retention horizon.

## Deployment notes

For multiple API replicas, filesystem mode requires a persistent shared volume visible at the same logical path to all replicas that can upload or run retention cleanup. A per-container ephemeral filesystem is not a valid retained-media backend.

The API process must have the minimum permissions needed to create tenant directories/files and delete expired files. Retained files are created with restrictive requested modes and are never served by an application download endpoint in this slice.

## Verification

CI uses a real temporary filesystem root plus real PostgreSQL, Redis, and RabbitMQ. The readiness integration first sets both reserve thresholds to zero and requires HTTP 200/`ready`; it then raises the byte reserve above available capacity and requires HTTP 503/`low_capacity` while the other dependencies remain healthy.

A separate real-PostgreSQL integration creates active, failed, and expired media assets and verifies the tenant inventory aggregation, including retained bytes and assets expiring within 24 hours.

Production capacity certification remains separate from CI. A production-equivalent soak should monitor filesystem free capacity, retained-byte growth, cleanup throughput/failures, and upload latency while approaching the configured readiness reserve.