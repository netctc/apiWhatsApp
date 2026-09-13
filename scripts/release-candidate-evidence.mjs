import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

const OUTPUT_MARKER = "[release-candidate] ";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IMAGE_TAG_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

class EvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvidenceError(code, message);
}

function envValue(name, { required = true } = {}) {
  const value = process.env[name]?.trim() ?? "";
  if (required && value.length === 0) {
    fail(`${name.toLowerCase()}_missing`, `${name} is required`);
  }
  return value;
}

function validateSha(value, code) {
  if (!SHA_PATTERN.test(value)) {
    fail(code, "Expected a full lowercase 40-character hexadecimal commit SHA");
  }
  return value;
}

function validateVersion(value, code) {
  if (!VERSION_PATTERN.test(value)) {
    fail(code, "Expected a semantic application version");
  }
  return value;
}

function validateHttpsUrl(value, code) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code, "Expected a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail(code, "Expected a credential-free HTTPS URL");
  }
  return parsed.toString().replace(/\/$/, "");
}

function ensureChildPath(root, candidate, code) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(process.cwd(), candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    fail(code, "Evidence paths must resolve to files inside the output directory");
  }
  return absoluteCandidate;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function assertRegularNonEmptyFile(path, code) {
  let details;
  try {
    details = await stat(path);
  } catch {
    fail(code, "Required evidence input file is missing");
  }
  if (!details.isFile() || details.size <= 0) {
    fail(code, "Required evidence input must be a non-empty regular file");
  }
  return details;
}

async function migrationEvidence() {
  const migrationsRoot = resolve("prisma/migrations");
  let entries;
  try {
    entries = await readdir(migrationsRoot, { withFileTypes: true });
  } catch {
    fail("migrations_missing", "Prisma migrations directory is required");
  }

  const paths = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `prisma/migrations/${entry.name}/migration.sql`)
    .sort((a, b) => a.localeCompare(b));

  if (paths.length === 0) {
    fail("migrations_missing", "At least one Prisma migration is required");
  }

  const migrations = [];
  for (const path of paths) {
    await assertRegularNonEmptyFile(resolve(path), "migration_file_invalid");
    migrations.push({ path, sha256: await sha256File(path) });
  }

  const checksumDocument = `${migrations.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
  return {
    migrations,
    checksumDocument,
    aggregateSha256: sha256Text(checksumDocument),
  };
}

function sourceDateFromEpoch(value) {
  if (!/^(?:0|[1-9]\d{0,12})$/.test(value)) {
    fail("source_date_epoch_invalid", "RC_SOURCE_DATE_EPOCH must be a non-negative integer epoch value");
  }
  const millis = Number(value) * 1000;
  const date = new Date(millis);
  if (!Number.isFinite(millis) || Number.isNaN(date.getTime())) {
    fail("source_date_epoch_invalid", "RC_SOURCE_DATE_EPOCH is outside the supported date range");
  }
  return date.toISOString();
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const expectedSha = validateSha(envValue("RC_EXPECTED_SHA"), "expected_sha_invalid");
  const sourceSha = validateSha(
    envValue("RC_SOURCE_SHA", { required: false }) || envValue("GITHUB_SHA"),
    "source_sha_invalid",
  );
  if (expectedSha !== sourceSha) {
    fail("source_sha_mismatch", "The checked-out source commit does not match RC_EXPECTED_SHA");
  }

  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
    fail("package_identity_invalid", "package.json must contain name and version strings");
  }
  const packageVersion = validateVersion(packageJson.version, "package_version_invalid");
  const expectedVersion = envValue("RC_EXPECTED_VERSION", { required: false });
  if (expectedVersion.length > 0) {
    validateVersion(expectedVersion, "expected_version_invalid");
    if (expectedVersion !== packageVersion) {
      fail("version_mismatch", "RC_EXPECTED_VERSION does not match package.json");
    }
  }

  const imageId = envValue("RC_IMAGE_ID");
  if (!IMAGE_ID_PATTERN.test(imageId)) {
    fail("image_id_invalid", "RC_IMAGE_ID must be a sha256 Docker image ID");
  }
  const imageTag = envValue("RC_IMAGE_TAG");
  if (!IMAGE_TAG_PATTERN.test(imageTag)) {
    fail("image_tag_invalid", "RC_IMAGE_TAG contains unsupported characters");
  }

  const ciRunId = envValue("RC_CI_RUN_ID");
  if (!/^[1-9]\d*$/.test(ciRunId)) {
    fail("ci_run_id_invalid", "RC_CI_RUN_ID must be a positive integer");
  }
  const sourceRepository = envValue("RC_SOURCE_REPOSITORY");
  if (!REPOSITORY_PATTERN.test(sourceRepository)) {
    fail("source_repository_invalid", "RC_SOURCE_REPOSITORY must use owner/repository form");
  }
  const sourceUrl = validateHttpsUrl(envValue("RC_SOURCE_URL"), "source_url_invalid");
  const ciRunUrl = validateHttpsUrl(envValue("RC_CI_RUN_URL"), "ci_run_url_invalid");

  const outputDir = resolve(envValue("RC_OUTPUT_DIR", { required: false }) || "release-candidate-artifacts");
  const sbomPath = ensureChildPath(outputDir, envValue("RC_SBOM_PATH"), "sbom_path_invalid");
  const imageArchivePath = ensureChildPath(
    outputDir,
    envValue("RC_IMAGE_ARCHIVE_PATH"),
    "image_archive_path_invalid",
  );
  const sbomStat = await assertRegularNonEmptyFile(sbomPath, "sbom_invalid");
  const imageArchiveStat = await assertRegularNonEmptyFile(imageArchivePath, "image_archive_invalid");
  void sbomStat;

  let sbom;
  try {
    sbom = JSON.parse(await readFile(sbomPath, "utf8"));
  } catch {
    fail("sbom_invalid", "Runtime SBOM must be valid JSON");
  }
  if (sbom?.bomFormat !== "CycloneDX" || typeof sbom?.specVersion !== "string") {
    fail("sbom_invalid", "Runtime SBOM must be a CycloneDX document");
  }

  const migration = await migrationEvidence();
  const migrationChecksumPath = resolve(outputDir, "migrations.sha256");
  await writeFile(migrationChecksumPath, migration.checksumDocument, "utf8");

  const packageLockPath = resolve("package-lock.json");
  const prismaSchemaPath = resolve("prisma/schema.prisma");
  await assertRegularNonEmptyFile(packageLockPath, "package_lock_invalid");
  await assertRegularNonEmptyFile(prismaSchemaPath, "prisma_schema_invalid");

  const packageLockSha256 = await sha256File(packageLockPath);
  const prismaSchemaSha256 = await sha256File(prismaSchemaPath);
  const sbomSha256 = await sha256File(sbomPath);
  const imageArchiveSha256 = await sha256File(imageArchivePath);
  const migrationChecksumSha256 = await sha256File(migrationChecksumPath);
  const sourceDate = sourceDateFromEpoch(envValue("RC_SOURCE_DATE_EPOCH"));
  const npmVersion = envValue("RC_NPM_VERSION");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion)) {
    fail("npm_version_invalid", "RC_NPM_VERSION must be a valid npm version string");
  }

  const imageLabels = {
    "org.opencontainers.image.title": "api-whatsapp",
    "org.opencontainers.image.version": packageVersion,
    "org.opencontainers.image.revision": sourceSha,
    "org.opencontainers.image.source": sourceUrl,
  };

  const manifest = {
    schemaVersion: 1,
    kind: "api-whatsapp-release-candidate-evidence",
    application: {
      name: packageJson.name,
      version: packageVersion,
    },
    source: {
      repository: sourceRepository,
      url: sourceUrl,
      commit: sourceSha,
      shortCommit: sourceSha.slice(0, 12),
      committedAt: sourceDate,
    },
    ci: {
      workflow: "CI",
      event: "push",
      conclusion: "success",
      runId: ciRunId,
      runUrl: ciRunUrl,
    },
    runtime: {
      nodeVersion: process.version,
      npmVersion,
    },
    image: {
      tag: imageTag,
      id: imageId,
      archive: basename(imageArchivePath),
      archiveBytes: imageArchiveStat.size,
      archiveSha256: imageArchiveSha256,
      labels: imageLabels,
    },
    artifacts: {
      packageLock: { path: "package-lock.json", sha256: packageLockSha256 },
      prismaSchema: { path: "prisma/schema.prisma", sha256: prismaSchemaSha256 },
      migrations: {
        count: migration.migrations.length,
        checksumFile: basename(migrationChecksumPath),
        checksumFileSha256: migrationChecksumSha256,
        aggregateSha256: migration.aggregateSha256,
      },
      runtimeSbom: {
        path: basename(sbomPath),
        format: "CycloneDX",
        specVersion: sbom.specVersion,
        sha256: sbomSha256,
      },
    },
    promotion: {
      expectedVersion: packageVersion,
      expectedRevision: sourceSha,
    },
  };

  const manifestPath = resolve(outputDir, "release-manifest.json");
  await writeJson(manifestPath, manifest);
  const manifestSha256 = await sha256File(manifestPath);

  const bundleEntries = [
    { path: imageArchivePath, name: basename(imageArchivePath), sha256: imageArchiveSha256 },
    { path: sbomPath, name: basename(sbomPath), sha256: sbomSha256 },
    { path: migrationChecksumPath, name: basename(migrationChecksumPath), sha256: migrationChecksumSha256 },
    { path: manifestPath, name: basename(manifestPath), sha256: manifestSha256 },
  ].sort((a, b) => a.name.localeCompare(b.name));

  const checksumPath = resolve(outputDir, "checksums.sha256");
  await writeFile(
    checksumPath,
    `${bundleEntries.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n")}\n`,
    "utf8",
  );

  process.stdout.write(
    `${OUTPUT_MARKER}${JSON.stringify({
      passed: true,
      version: packageVersion,
      commit: sourceSha,
      imageId,
      migrations: migration.migrations.length,
      outputDir: basename(outputDir),
    })}\n`,
  );
}

main().catch((error) => {
  const code = error instanceof EvidenceError ? error.code : "evidence_generation_failed";
  const message = error instanceof EvidenceError ? error.message : "Release candidate evidence generation failed";
  process.stdout.write(`${OUTPUT_MARKER}${JSON.stringify({ passed: false, error: code, message })}\n`);
  process.exitCode = 1;
});
