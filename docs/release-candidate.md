# Release Candidate Evidence Bundle

The Release Candidate Evidence workflow packages one exact, already-tested `main` commit into a non-deploying evidence bundle. It is intended to make release promotion auditable without rebuilding the candidate later.

This workflow does **not** deploy infrastructure, push an image to a registry, create a Git tag or GitHub Release, contact customer systems, or use production credentials.

## Release contract

A release candidate is accepted for packaging only when all of the following are true:

1. `confirm_release_candidate=true` is explicitly selected.
2. The workflow is dispatched from `main`.
3. `expected_sha` is the full lowercase 40-character SHA of the workflow commit.
4. The optional `expected_version`, when supplied, exactly matches `package.json`.
5. GitHub already contains a successful, push-triggered `CI` run for the same `main` SHA.
6. The production Docker image can be built with exact version/revision/source OCI labels.
7. The locked production runtime dependency tree can produce a CycloneDX SBOM.
8. All release evidence can be hashed and verified before upload.

A green pull-request CI is not sufficient for packaging. The exact merged `main` commit must have its own successful push CI result.

## Workflow inputs

Run **Release Candidate Evidence** manually from the Actions tab and select the `main` branch.

- `confirm_release_candidate`: must be `true`.
- `expected_sha`: required exact `main` commit SHA.
- `expected_version`: optional exact semantic version. Leave blank to use `package.json`.

The workflow has only `actions: read` and `contents: read` permissions. It does not need repository write access or application secrets.

## Bundle contents

The uploaded artifact is named:

```text
api-whatsapp-rc-<version>-<12-char-sha>
```

It contains:

- `api-whatsapp-<version>-<12-char-sha>.docker.tar.gz` — the exact Docker image built for this release candidate. The archive is produced with `docker save` and deterministic gzip metadata (`gzip -n`).
- `runtime-sbom.cdx.json` — CycloneDX SBOM generated from a locked production-only `npm ci` installation.
- `migrations.sha256` — ordered SHA-256 digest for every `prisma/migrations/*/migration.sql` file.
- `release-manifest.json` — non-secret identity and integrity metadata.
- `checksums.sha256` — SHA-256 verification document for the bundle files above.

The manifest records:

- application name and semantic version;
- exact source repository and commit SHA;
- source commit timestamp;
- successful CI run ID and URL;
- Node and npm versions used for evidence generation;
- Docker image ID, archive name/size/hash and OCI labels;
- `package-lock.json` checksum;
- `prisma/schema.prisma` checksum;
- migration count and aggregate checksum;
- CycloneDX SBOM checksum;
- the version and revision that must later be supplied to production-readiness certification.

No API keys, deployment target URLs, database URLs, Meta credentials, or other application secrets are included.

## Docker image identity

Release-candidate builds pass these values into the production image:

```text
org.opencontainers.image.title=api-whatsapp
org.opencontainers.image.version=<package version>
org.opencontainers.image.revision=<full source SHA>
org.opencontainers.image.source=<repository URL>
```

The same full source SHA is baked into `APP_REVISION`. Consequently `/api/health/live` exposes the release revision after this exact image is deployed, which allows the Production Readiness Certification workflow to prove that it is checking the intended build.

Normal local/CI Docker builds remain supported: the build arguments have safe defaults and do not require a revision.

## Verify an extracted bundle

Before promotion, verify the artifact contents from inside the extracted artifact directory:

```bash
sha256sum -c checksums.sha256
```

Every line must report `OK`.

The image archive can then be loaded without rebuilding it:

```bash
docker load --input api-whatsapp-<version>-<12-char-sha>.docker.tar.gz
```

Inspect its immutable identity before promotion:

```bash
docker image inspect api-whatsapp:rc-<12-char-sha>
```

The image ID and OCI labels must match `release-manifest.json`.

## Promotion into a production-like environment

The release workflow intentionally stops before deployment. Infrastructure-specific automation can promote the exact image archive or an equivalent registry copy of that exact image ID.

After deployment, run the [Production Readiness Certification](production-readiness-certification.md) workflow with:

```text
expected_version = release-manifest.json.application.version
expected_revision = release-manifest.json.source.commit
```

Certification then verifies build identity, dependency readiness, readiness latency, tenant outbox health and optional inbox SLA gates against the deployed environment.

The resulting release evidence chain is therefore:

```text
successful main CI
  -> exact release candidate image + manifest + SBOM + checksums
  -> controlled deployment of that exact image
  -> exact version/revision production-readiness certification
```

## Failure behavior

The workflow fails closed when identity, CI provenance, Docker labels, SBOM format, required release files, migration inventory, or bundle checksums do not satisfy the contract. A failed workflow does not create or promote a release candidate.

Do not bypass a failed identity or checksum gate by rebuilding the image separately. Fix the source/workflow issue, obtain a green `main` CI for the corrected commit, and package that new exact commit instead.
