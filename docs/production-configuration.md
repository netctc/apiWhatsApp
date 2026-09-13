# Production Configuration Validation

Production API and worker processes validate critical configuration during Nest configuration bootstrap. The validation runs through `ConfigModule.forRoot({ validate })`, after environment files are loaded and before dependent providers are constructed.

The objective is to fail closed before a process starts accepting traffic or consuming queues when deployment configuration is missing, malformed, or structurally unsafe.

Validation is enabled only when:

```text
NODE_ENV=production
```

Development and test environments keep the existing permissive behavior.

## Shared API and worker requirements

Both production process profiles require:

- `DATABASE_URL` using `postgresql:` or `postgres:`;
- `REDIS_URL` using `redis:` or `rediss:`;
- `RABBITMQ_URL` using `amqp:` or `amqps:`;
- `META_GRAPH_API_VERSION` in the existing `vNN.N` format;
- `APP_REVISION` as the exact lowercase 40-character Git commit SHA;
- valid mounted-secret roots when `SECRET_FILE_ROOTS` is explicitly configured.

`META_GRAPH_API_BASE_URL` remains optional. When configured in production, it must be an HTTPS absolute URL without embedded credentials, query parameters, or fragments.

The exact `APP_REVISION` requirement links runtime identity to the release-candidate evidence chain. Release-candidate Docker images set this value to the exact source commit, and `/api/health/live` exposes it for production-readiness certification.

## API-only requirements

The production API additionally requires:

- `API_KEY_HASH_SECRET`: at least 32 characters and not the documented example placeholder;
- `META_WEBHOOK_VERIFY_TOKEN`: at least 16 characters;
- `META_APP_SECRET`: at least 16 characters;
- `METRICS_BEARER_TOKEN`: at least 32 characters;
- `PORT`, when provided, between 1 and 65535.

These checks prevent an API replica from starting successfully while tenant authentication, signed Meta webhooks, or the protected metrics endpoint would fail only on first use.

The worker profile intentionally does **not** require API-only webhook or metrics credentials.

## Conditional media validation

Media integrations remain optional. Their configuration is validated only when the corresponding mode is enabled.

### Filesystem retention

When:

```text
MEDIA_BINARY_STORAGE_MODE=filesystem
```

production configuration requires an absolute non-root `MEDIA_FILESYSTEM_STORAGE_PATH`. Optional reserve controls are validated when set:

- `MEDIA_FILESYSTEM_MIN_FREE_BYTES`: non-negative safe integer;
- `MEDIA_FILESYSTEM_MIN_FREE_PERCENT`: number from 0 through 100.

The bootstrap validator does not touch the filesystem. Runtime readiness remains responsible for checking that the configured directory exists, is writable, and has sufficient capacity.

### S3 retention

When:

```text
MEDIA_BINARY_STORAGE_MODE=s3
```

production configuration validates:

- HTTPS `MEDIA_S3_ENDPOINT` without credentials, query, fragment, or path;
- DNS-compatible `MEDIA_S3_BUCKET`;
- `MEDIA_S3_REGION` syntax, defaulting to `us-east-1` when omitted;
- presence of `MEDIA_S3_ACCESS_KEY_ID` and `MEDIA_S3_SECRET_ACCESS_KEY`;
- optional `MEDIA_S3_TIMEOUT_MS` from 1000 through 300000.

The validator does not contact the bucket. `/api/health/ready` remains the external availability gate.

### ClamAV scanning

When:

```text
MEDIA_MALWARE_SCAN_MODE=clamav
```

production configuration validates:

- non-empty `MEDIA_CLAMAV_HOST`;
- optional port from 1 through 65535;
- optional timeout from 1000 through 600000 ms.

The validator does not open a scanner connection. Upload-time fail-closed behavior remains unchanged.

## Sanitized failures

Configuration errors identify variable names and validation reasons only. They do not echo configured values.

Example:

```text
Production configuration validation failed (api): API_KEY_HASH_SECRET: must contain at least 32 characters; APP_REVISION: must be the exact lowercase 40-character Git commit SHA
```

Do not add raw secret values to validation messages, logs, health responses, or CI artifacts.

## Deployment sequence

A production-like promotion should use the following order:

1. obtain a successful `main` CI for the exact commit;
2. generate the Release Candidate Evidence bundle for that commit;
3. deploy the exact release-candidate image with environment/secrets mounted;
4. allow API and worker bootstrap validation to reject unsafe configuration immediately;
5. run Production Readiness Certification against the deployed API using the exact manifest version and revision;
6. only then promote customer traffic according to the deployment runbook.

This bootstrap validation complements, rather than replaces, runtime readiness. Structural configuration is checked before startup; network/service availability is checked by readiness and certification.
