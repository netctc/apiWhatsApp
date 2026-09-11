# Dependency security gates

CI checks the complete development/build dependency tree and the separately
installed production runtime tree. Both checks are prerequisites for the Docker
image build. A passing runtime-only result does not resolve build-time findings.

## Commands

```bash
node --test scripts/test/dependency-audit.test.mjs
npm ci --include=dev --include=peer --include=optional --ignore-scripts
node --test scripts/test/prisma-dependency-compatibility.test.mjs
node scripts/audit-full.mjs
```

Run the runtime check in a separate checkout/container, matching the production
installation policy (this replaces the installed development tree):

```bash
npm ci --omit=dev --omit=peer --omit=optional --ignore-scripts
npm run audit:prod
```

Both audit commands use `npm audit --json --audit-level=high --ignore-scripts`.
Full mode explicitly includes development, peer and optional dependencies.
Runtime mode preserves the previous omit policy and classifies a finding as
blocking only when at least one affected locked package is actually installed.
It reports omitted findings separately instead of silently hiding them.

## Failure semantics

- Exit 0: valid evidence, with no high/critical findings in the selected scope.
- Exit 1: valid evidence with blocking high/critical findings.
- Exit 2: unavailable, malformed or inconsistent audit evidence.

The shared evaluator requires report schema version 2, a completed subprocess,
consistent severity counts, valid affected paths in the lockfile and a real npm
installation. Missing direct production dependencies cannot be passed off as
intentional omissions. Registry error JSON, invalid JSON, unknown severities,
contradictory exit codes and incomplete reports never count as a clean audit.

The subprocess has a 120-second timeout and 16 MiB output limit. Logs contain
selected dependency names, locked versions, node paths, severity, canonical GHSA
identifiers and npm remediation suggestions. Raw stderr, error details, advisory
titles and arbitrary URLs are not echoed because registry diagnostics may expose
credentials. Counts are npm's package-level findings, not distinct CVE counts.

## September 11, 2026 remediation (issue #56)

The unchanged lockfile produced four high-severity package findings in CI run
410. They originate in two packages and are inherited by their Prisma ancestors:

| Locked package | Version before remediation | Evidence |
| --- | --- | --- |
| deepmerge-ts | 7.1.5 | GHSA-ggr8-5vv4-36mx, affected below 8.0.0 |
| @prisma/config | 7.10.0 | Inherits the deepmerge-ts finding |
| mysql2 | 3.15.3 | GHSA-3f6p-5ww8-9rcr (high) and GHSA-rgwj-5xj2-c3m3 (moderate) |
| prisma | 7.10.0 | Inherits the config/mysql2 findings |

These packages were present in the full development/build installation and
absent from the separately installed production runtime. They are not treated as
harmless: Prisma configuration loading and CLI execution occur during generation,
migrations and image construction. This application uses PostgreSQL; the mysql2
package is a transitive CLI dependency, not the application's database adapter.

The scoped overrides retain Prisma 7.10.0 and select:

```json
{
  "@prisma/config": { "deepmerge-ts": "8.0.1" },
  "prisma": { "mysql2": "3.23.1" }
}
```

No blanket audit suppression, exception, automatic major downgrade to Prisma 6,
or unreviewed `npm audit fix --force` is used. The npm-generated lockfile must be
committed with the overrides and pass deterministic installation.

### Compatibility boundary

Deepmerge-ts 8 is a major version: Map value merging, some type names and
`deepmergeInto` mutation behavior changed. This override is not a general claim
that all v7 consumers are compatible. Prisma 7.10.0 passes `deepmerge` to c12 when
loading configuration. The repository config uses ordinary records and strings.
The dedicated smoke tests verify resolution from Prisma's actual dependency
ancestors, plain-record merge behavior and real config-file loading. Existing CI
also exercises project client generation, migrations, build and integration.

MySQL2 3.23.1 includes the compressed-packet decompression bound fix and is above
the affected ranges reported for this lockfile. Live advisory checks, not a
hardcoded advisory allowlist, remain authoritative for subsequent runs.

Repository maintainers should review these scoped overrides when upgrading
Prisma; remove them once upstream declares compatible patched dependencies.
Changes introducing Map-valued/custom configuration need renewed compatibility
testing. No production endpoint, message policy or database migration is changed.

## Evidence and upstream references

- Issue: https://github.com/netctc/apiWhatsApp/issues/56
- Baseline full audit: https://github.com/netctc/apiWhatsApp/actions/runs/34601651497/job/103270146244
- Baseline runtime audit: https://github.com/netctc/apiWhatsApp/actions/runs/34601651497/job/103270146287
- npm audit semantics: https://docs.npmjs.com/cli/v11/commands/npm-audit/
- Deepmerge advisory: https://github.com/RebeccaStevens/deepmerge-ts/security/advisories/GHSA-ggr8-5vv4-36mx
- Deepmerge 8 changes: https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0
- Deepmerge 8.0.1: https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.1
- MySQL2 3.23.1: https://github.com/sidorares/node-mysql2/releases/tag/v3.23.1
- Prisma config merger: https://github.com/prisma/orm/blob/7.10.0/packages/config/src/loadConfigFromFile.ts

The PR/CI results record verification for the exact candidate commit. These
gates check known package advisories and regression behavior; they do not certify
absence of all vulnerabilities or constitute a production deployment.
