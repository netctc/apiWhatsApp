# Release Transition and Rollback Evidence

The Release Transition Evidence gate compares two already-generated Release Candidate Evidence bundles before an operator promotes a candidate: the exact candidate image and an exact known-good rollback image.

The gate is evidence-only. It does not deploy either image, change a database, push to a registry, create a Git tag/release, or generate customer traffic.

## Why this gate exists

Keeping a previous Docker image is not by itself a complete rollback plan. A new application release can also append database migrations. Prisma production migrations are forward migrations; this project does not claim that applying a migration makes the database automatically downgradeable.

The transition gate therefore separates two questions:

1. **Can the exact application images be identified and recovered?** Both RC bundles must be intact and include exact version, revision, image ID/archive, SBOM, and migration evidence.
2. **Has database compatibility been reviewed?** When the candidate adds migrations, an operator must explicitly acknowledge that the known-good rollback application has been reviewed against the post-migration schema.

The acknowledgement records review; it does **not** execute a downgrade and does **not** prove a downgrade safe.

## Accepted migration relationships

The gate compares the ordered `migrations.sha256` histories from both RC bundles.

### `same_schema`

Every migration path and SHA-256 digest is identical. No database compatibility acknowledgement is required because the transition does not introduce a schema-history delta.

The generated rollback policy is:

```text
application_image_rollback_without_schema_change
```

### `append_only`

Every rollback migration is an exact prefix of the candidate history and the candidate only adds new migrations.

The gate records every added migration path and digest. Transition readiness remains **false** unless `acknowledge_database_compatibility=true` is explicitly supplied.

The rollback policy is:

```text
application_image_rollback_requires_verified_database_backward_compatibility
```

Even after acknowledgement, the evidence always records:

```json
{
  "automaticDatabaseDowngradePerformed": false,
  "automaticDatabaseDowngradeProvenSafe": false
}
```

The deployment owner is responsible for verifying that the rollback application can operate safely with any new schema objects/constraints or for providing a separately reviewed database recovery procedure.

### Incompatible history

The gate fails closed when a candidate deletes, reorders, or rewrites any migration already present in the rollback bundle. Duplicate or malformed migration entries also fail closed.

Historical migration mutation must be fixed in source; it must not be approved through an acknowledgement.

## Bundle integrity validation

Before comparing releases, each extracted Release Candidate Evidence bundle is independently verified.

The runner checks:

- `checksums.sha256` syntax, unique/sorted safe basenames, and every listed file digest;
- `release-manifest.json` schema/kind/application/source/CI/image/promotion identity;
- exact full lowercase Git revision and Docker `sha256:` image ID;
- OCI version/revision/source metadata consistency;
- image archive size and SHA-256 against both manifest and bundle checksums;
- CycloneDX SBOM identity/digest against both manifest and bundle checksums;
- migration checksum-file digest/count/aggregate against both manifest and bundle checksums;
- sorted, unique, safe `prisma/migrations/<name>/migration.sql` entries and valid SHA-256 digests.

`package-lock.json` and `prisma/schema.prisma` are not files inside the current RC artifact, so their manifest hashes are syntax-validated provenance metadata but cannot be independently re-hashed by this transition runner. The migration, SBOM, manifest, and image archive files are all present and fully verified.

## Manual workflow

Run **Release Transition Evidence** from the Actions tab on `main`.

Inputs:

- `confirm_release_transition`: must be explicitly enabled;
- `candidate_rc_run_id`: successful Release Candidate Evidence workflow run ID for the candidate;
- `rollback_rc_run_id`: successful Release Candidate Evidence workflow run ID for the known-good rollback image;
- `acknowledge_database_compatibility`: required only for an `append_only` schema relationship, but the input is always visible so the acknowledgement is explicit.

The candidate and rollback workflow run IDs must be distinct.

### Provenance validation

Before downloading artifacts, the workflow verifies that each referenced run:

- belongs to this repository;
- uses `.github/workflows/release-candidate.yml`;
- is named `Release Candidate Evidence`;
- was triggered by `workflow_dispatch`;
- ran on `main`;
- is `completed` with conclusion `success`;
- has a full lowercase Git SHA;
- contains exactly one non-expired artifact whose name begins `api-whatsapp-rc-`.

Artifact ZIP entries are inspected before extraction; absolute paths, parent traversal, and backslash paths are rejected.

The workflow requires only `actions: read` and `contents: read` permissions and uses no application/production secrets.

## Transition plan artifact

A valid comparison writes:

```text
release-transition-plan.json
release-transition-plan.sha256
```

The plan includes:

- candidate version, exact revision, image ID/archive, and RC bundle-checksum digest;
- rollback version, exact revision, image ID/archive, and RC bundle-checksum digest;
- migration relationship, counts, and newly added migration paths/hashes;
- explicit database compatibility acknowledgement state;
- explicit statements that database downgrade was neither performed nor proven safe;
- rollback policy classification;
- exact candidate `expectedVersion`/`expectedRevision` values for post-deployment Production Readiness Certification;
- exact rollback `expectedVersion`/`expectedRevision` values to verify if the rollback image is later deployed.

Verify the extracted plan artifact with:

```bash
sha256sum -c release-transition-plan.sha256
```

## Operational sequence

A controlled promotion should use this evidence chain:

```text
successful main CI
  -> candidate Release Candidate Evidence bundle
  -> known-good rollback Release Candidate Evidence bundle
  -> Release Transition Evidence comparison
  -> controlled deployment of the exact candidate image
  -> Production Readiness Certification for candidate version + revision
  -> traffic promotion
```

If application rollback is required:

```text
stop/cancel promotion
  -> select the exact rollback image from the verified rollback RC bundle
  -> follow the transition plan rollback policy
  -> deploy the exact rollback image only when its database compatibility assumptions hold
  -> Production Readiness Certification for rollback version + revision
  -> restore traffic only after readiness/certification passes
```

For an `append_only` transition, do not interpret the acknowledgement as permission to run reverse SQL. Database restore/downgrade procedures, if needed, require a separately tested and approved recovery plan appropriate to the specific migrations and production data.
