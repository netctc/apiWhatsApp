# Media storage reconciliation

Media upload is synchronous, but the registry and optional retained binary are durable. A process crash can therefore leave a `MediaAsset` without a provider media ID even though its registry row or retained object already exists.

This reconciliation path prevents those interrupted uploads from remaining in `UPLOADING` forever.

## Stale upload definition

A media asset is eligible only when:

- `providerMediaId` is still null;
- `failedAt` is still null;
- `updatedAt` is older than the configured stale threshold.

`updatedAt` is intentionally used instead of `createdAt`. Registry creation establishes the first progress point and persisting `storedAt` renews it before the Meta provider call.

The default threshold is two hours:

```text
MEDIA_ASSET_STALE_UPLOAD_MS=7200000
```

Accepted range:

```text
1800000..86400000 ms
```

Keep this threshold longer than the maximum legitimate synchronous upload path in the deployment. Meta media upload, malware scanning, proxies, and object-storage latency all contribute to that path.

## Reconciliation lifecycle

The existing media maintenance scheduler runs reconciliation and normal expiry cleanup.

For each stale unfinished asset:

1. atomically claim the row with a conditional `updateMany`;
2. persist `failedAt` and `failureCode=UPLOAD_ABANDONED`;
3. if a retained `storageKey` exists, delete it through `MediaBinaryStorageService`;
4. clear `storageKey` and `storedAt` only after storage deletion succeeds.

The conditional claim includes the stale `updatedAt`, null provider ID, and null failure state. If an upload completes or another replica claims it after selection, the update count is zero and that replica does not touch storage.

## Storage cleanup retry

Filesystem deletion uses forced removal and S3 deletion is idempotent. Previously abandoned rows whose storage key remains set are selected again on later maintenance cycles.

If storage is unavailable:

- the asset remains failed with `UPLOAD_ABANDONED`;
- its `storageKey` remains in PostgreSQL;
- the maintenance cycle logs only the bounded asset ID and storage mode;
- a later cycle retries deletion.

The registry reference is never cleared before the delete succeeds.

## Expiry interaction

Normal TTL cleanup remains authoritative for expired registry rows. Expired assets are still processed by the existing retention path, which deletes their retained binary before deleting registry metadata.

Reconciliation does not change `MEDIA_ASSET_TTL_DAYS` or Meta provider-side retention.

## Provider-success boundary

Rows with a provider media ID are never selected for abandoned-upload reconciliation.

The reconciler cannot recover a provider media ID when Meta accepted an upload but the application crashed before persisting that ID. Such a row is treated as locally incomplete after the stale threshold. This avoids pretending that an unknown provider object can be safely referenced by clients.

## Multi-replica behavior

Multiple API replicas may run the maintenance scheduler.

Only one replica can transition a live stale candidate to `UPLOAD_ABANDONED` because the transition is conditional. Cleanup of an already abandoned storage object may be attempted by more than one replica, which is safe because both supported delete operations are idempotent.

No long-running database transaction is held open while a filesystem or S3 delete is performed.

## Operational guidance

Monitor for repeated reconciliation logs or a growing population of failed media assets. Repeated `cleanupDeferred` activity usually indicates retained-storage availability or permission problems.

The tenant media registry endpoint exposes `failureCode` without exposing storage keys, filesystem paths, bucket names, endpoints, or credentials.

This slice is crash reconciliation for synchronous uploads. It is not an asynchronous quarantine/scanning workflow, content sanitization system, object-lock policy, or provider-object reconciliation API.
