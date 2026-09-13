import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

const OUTPUT_MARKER = "[release-transition] ";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMAGE_TAG_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BASENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const MIGRATION_PATH_PATTERN = /^prisma\/migrations\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/migration\.sql$/;

class TransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TransitionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TransitionError(code, message);
}

function envValue(name, { required = true } = {}) {
  const value = process.env[name]?.trim() ?? "";
  if (required && value.length === 0) {
    fail(`${name.toLowerCase()}_missing`, `${name} is required`);
  }
  return value;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value, code, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${field} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(value, code, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(code, `${field} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function validateSha256(value, code, field) {
  const text = requiredString(value, code, field);
  if (!SHA256_PATTERN.test(text)) {
    fail(code, `${field} must be a lowercase SHA-256 digest`);
  }
  return text;
}

function validateGitSha(value, code, field) {
  const text = requiredString(value, code, field);
  if (!GIT_SHA_PATTERN.test(text)) {
    fail(code, `${field} must be a full lowercase 40-character Git SHA`);
  }
  return text;
}

function validateVersion(value, code, field) {
  const text = requiredString(value, code, field);
  if (!VERSION_PATTERN.test(text)) {
    fail(code, `${field} must be a semantic application version`);
  }
  return text;
}

function validateHttpsUrl(value, code, field) {
  const text = requiredString(value, code, field);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail(code, `${field} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail(code, `${field} must be a credential-free HTTPS URL`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function validateSafeBasename(value, code, field) {
  const text = requiredString(value, code, field);
  if (
    !SAFE_BASENAME_PATTERN.test(text) ||
    text === "." ||
    text === ".." ||
    text.includes("/") ||
    text.includes("\\") ||
    basename(text) !== text
  ) {
    fail(code, `${field} must be a safe bundle basename`);
  }
  return text;
}

function childPath(root, name, code) {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, name);
  const rel = relative(absoluteRoot, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    fail(code, "Bundle file escaped its evidence directory");
  }
  return candidate;
}

async function assertDirectory(path, code) {
  let details;
  try {
    details = await stat(path);
  } catch {
    fail(code, "Evidence bundle directory is missing");
  }
  if (!details.isDirectory()) {
    fail(code, "Evidence bundle path must be a directory");
  }
}

async function assertRegularNonEmptyFile(path, code) {
  let details;
  try {
    details = await stat(path);
  } catch {
    fail(code, "Required evidence file is missing");
  }
  if (!details.isFile() || details.size <= 0) {
    fail(code, "Required evidence file must be a non-empty regular file");
  }
  return details;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(code, "Evidence JSON file is invalid");
  }
}

function parseBooleanAcknowledgement() {
  const value = envValue("TRANSITION_ACK_DATABASE_COMPATIBILITY", { required: false }).toLowerCase();
  if (!value || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  fail(
    "database_compatibility_ack_invalid",
    "TRANSITION_ACK_DATABASE_COMPATIBILITY must be true or false",
  );
}

async function parseBundleChecksums(root, role) {
  const path = resolve(root, "checksums.sha256");
  await assertRegularNonEmptyFile(path, `${role}_bundle_checksums_missing`);
  const raw = await readFile(path, "utf8");
  if (!raw.endsWith("\n")) {
    fail(`${role}_bundle_checksums_invalid`, "Bundle checksum document must end with a newline");
  }

  const lines = raw.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    fail(`${role}_bundle_checksums_invalid`, "Bundle checksum document contains empty entries");
  }

  const entries = [];
  const names = new Set();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/.exec(line);
    if (!match) {
      fail(`${role}_bundle_checksums_invalid`, "Bundle checksum document contains a malformed entry");
    }
    const [, sha256, name] = match;
    validateSafeBasename(name, `${role}_bundle_checksums_invalid`, "checksums.sha256 entry");
    if (names.has(name)) {
      fail(`${role}_bundle_checksums_invalid`, "Bundle checksum document contains duplicate file names");
    }
    names.add(name);
    entries.push({ name, sha256 });
  }

  const expectedOrder = entries.map((entry) => entry.name).slice().sort((a, b) => a.localeCompare(b));
  if (entries.some((entry, index) => entry.name !== expectedOrder[index])) {
    fail(`${role}_bundle_checksums_invalid`, "Bundle checksum entries must be sorted by file name");
  }

  for (const entry of entries) {
    const filePath = childPath(root, entry.name, `${role}_bundle_checksum_path_invalid`);
    await assertRegularNonEmptyFile(filePath, `${role}_bundle_checksum_file_missing`);
    const actual = await sha256File(filePath);
    if (actual !== entry.sha256) {
      fail(`${role}_bundle_checksum_mismatch`, `Bundle checksum mismatch for ${entry.name}`);
    }
  }

  return { path, raw, entries, byName: new Map(entries.map((entry) => [entry.name, entry.sha256])) };
}

function validateManifestDocument(manifest, role) {
  const code = `${role}_manifest_invalid`;
  if (!isObject(manifest)) {
    fail(code, "Release manifest must be a JSON object");
  }
  if (manifest.schemaVersion !== 1 || manifest.kind !== "api-whatsapp-release-candidate-evidence") {
    fail(code, "Unsupported release candidate manifest schema or kind");
  }

  if (!isObject(manifest.application) || manifest.application.name !== "api-whatsapp") {
    fail(code, "Manifest application identity is invalid");
  }
  const version = validateVersion(manifest.application.version, code, "application.version");

  if (!isObject(manifest.source)) {
    fail(code, "Manifest source identity is missing");
  }
  const repository = requiredString(manifest.source.repository, code, "source.repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    fail(code, "source.repository must use owner/repository form");
  }
  const sourceUrl = validateHttpsUrl(manifest.source.url, code, "source.url");
  const commit = validateGitSha(manifest.source.commit, code, "source.commit");
  if (manifest.source.shortCommit !== commit.slice(0, 12)) {
    fail(code, "source.shortCommit does not match source.commit");
  }
  const committedAt = requiredString(manifest.source.committedAt, code, "source.committedAt");
  if (Number.isNaN(Date.parse(committedAt))) {
    fail(code, "source.committedAt must be a valid timestamp");
  }

  if (
    !isObject(manifest.ci) ||
    manifest.ci.workflow !== "CI" ||
    manifest.ci.event !== "push" ||
    manifest.ci.conclusion !== "success" ||
    !/^[1-9]\d*$/.test(String(manifest.ci.runId ?? ""))
  ) {
    fail(code, "Manifest CI provenance is invalid");
  }
  validateHttpsUrl(manifest.ci.runUrl, code, "ci.runUrl");

  if (!isObject(manifest.image)) {
    fail(code, "Manifest image identity is missing");
  }
  const imageId = requiredString(manifest.image.id, code, "image.id");
  if (!IMAGE_ID_PATTERN.test(imageId)) {
    fail(code, "image.id must be a Docker sha256 image ID");
  }
  const imageTag = requiredString(manifest.image.tag, code, "image.tag");
  if (!IMAGE_TAG_PATTERN.test(imageTag)) {
    fail(code, "image.tag contains unsupported characters");
  }
  const imageArchive = validateSafeBasename(manifest.image.archive, code, "image.archive");
  const imageArchiveBytes = requiredInteger(manifest.image.archiveBytes, code, "image.archiveBytes", 1);
  const imageArchiveSha256 = validateSha256(
    manifest.image.archiveSha256,
    code,
    "image.archiveSha256",
  );
  if (!isObject(manifest.image.labels)) {
    fail(code, "Manifest image labels are missing");
  }
  if (
    manifest.image.labels["org.opencontainers.image.title"] !== "api-whatsapp" ||
    manifest.image.labels["org.opencontainers.image.version"] !== version ||
    manifest.image.labels["org.opencontainers.image.revision"] !== commit ||
    manifest.image.labels["org.opencontainers.image.source"] !== sourceUrl
  ) {
    fail(code, "Manifest OCI labels do not match release identity");
  }

  if (!isObject(manifest.artifacts)) {
    fail(code, "Manifest artifact metadata is missing");
  }
  if (
    !isObject(manifest.artifacts.packageLock) ||
    manifest.artifacts.packageLock.path !== "package-lock.json"
  ) {
    fail(code, "Manifest package-lock metadata is invalid");
  }
  validateSha256(manifest.artifacts.packageLock.sha256, code, "artifacts.packageLock.sha256");
  if (
    !isObject(manifest.artifacts.prismaSchema) ||
    manifest.artifacts.prismaSchema.path !== "prisma/schema.prisma"
  ) {
    fail(code, "Manifest Prisma schema metadata is invalid");
  }
  validateSha256(manifest.artifacts.prismaSchema.sha256, code, "artifacts.prismaSchema.sha256");

  if (!isObject(manifest.artifacts.migrations)) {
    fail(code, "Manifest migration metadata is missing");
  }
  const migrationCount = requiredInteger(
    manifest.artifacts.migrations.count,
    code,
    "artifacts.migrations.count",
    1,
  );
  const migrationChecksumFile = validateSafeBasename(
    manifest.artifacts.migrations.checksumFile,
    code,
    "artifacts.migrations.checksumFile",
  );
  const migrationChecksumFileSha256 = validateSha256(
    manifest.artifacts.migrations.checksumFileSha256,
    code,
    "artifacts.migrations.checksumFileSha256",
  );
  const migrationAggregateSha256 = validateSha256(
    manifest.artifacts.migrations.aggregateSha256,
    code,
    "artifacts.migrations.aggregateSha256",
  );

  if (!isObject(manifest.artifacts.runtimeSbom)) {
    fail(code, "Manifest runtime SBOM metadata is missing");
  }
  const sbomPath = validateSafeBasename(
    manifest.artifacts.runtimeSbom.path,
    code,
    "artifacts.runtimeSbom.path",
  );
  if (manifest.artifacts.runtimeSbom.format !== "CycloneDX") {
    fail(code, "Runtime SBOM format must be CycloneDX");
  }
  const sbomSpecVersion = requiredString(
    manifest.artifacts.runtimeSbom.specVersion,
    code,
    "artifacts.runtimeSbom.specVersion",
  );
  const sbomSha256 = validateSha256(
    manifest.artifacts.runtimeSbom.sha256,
    code,
    "artifacts.runtimeSbom.sha256",
  );

  if (
    !isObject(manifest.promotion) ||
    manifest.promotion.expectedVersion !== version ||
    manifest.promotion.expectedRevision !== commit
  ) {
    fail(code, "Manifest promotion identity does not match application/source identity");
  }

  return {
    version,
    repository,
    sourceUrl,
    commit,
    imageId,
    imageTag,
    imageArchive,
    imageArchiveBytes,
    imageArchiveSha256,
    migrationCount,
    migrationChecksumFile,
    migrationChecksumFileSha256,
    migrationAggregateSha256,
    sbomPath,
    sbomSpecVersion,
    sbomSha256,
  };
}

async function parseMigrations(path, role, expectedCount) {
  const raw = await readFile(path, "utf8");
  if (!raw.endsWith("\n")) {
    fail(`${role}_migrations_invalid`, "Migration checksum document must end with a newline");
  }
  const lines = raw.slice(0, -1).split("\n");
  if (lines.length !== expectedCount || lines.some((line) => line.length === 0)) {
    fail(`${role}_migrations_invalid`, "Migration checksum count does not match the manifest");
  }

  const migrations = [];
  const seen = new Set();
  for (const line of lines) {
    const separator = line.indexOf("  ");
    if (separator !== 64) {
      fail(`${role}_migrations_invalid`, "Migration checksum entry is malformed");
    }
    const sha256 = line.slice(0, separator);
    const migrationPath = line.slice(separator + 2);
    if (!SHA256_PATTERN.test(sha256) || !MIGRATION_PATH_PATTERN.test(migrationPath)) {
      fail(`${role}_migrations_invalid`, "Migration checksum entry is malformed");
    }
    if (seen.has(migrationPath)) {
      fail(`${role}_migrations_invalid`, "Migration checksum document contains duplicate paths");
    }
    seen.add(migrationPath);
    migrations.push({ path: migrationPath, sha256 });
  }

  const expectedOrder = migrations.map((entry) => entry.path).slice().sort((a, b) => a.localeCompare(b));
  if (migrations.some((entry, index) => entry.path !== expectedOrder[index])) {
    fail(`${role}_migrations_invalid`, "Migration checksum entries must be sorted by path");
  }
  return { raw, migrations };
}

async function verifyBundle(role, directory) {
  const root = resolve(directory);
  await assertDirectory(root, `${role}_bundle_missing`);
  const checksums = await parseBundleChecksums(root, role);

  if (!checksums.byName.has("release-manifest.json")) {
    fail(`${role}_bundle_manifest_uncovered`, "release-manifest.json is not covered by checksums.sha256");
  }
  const manifestPath = childPath(root, "release-manifest.json", `${role}_manifest_path_invalid`);
  const manifest = await readJson(manifestPath, `${role}_manifest_invalid`);
  const identity = validateManifestDocument(manifest, role);

  const requiredBundleFiles = [
    identity.imageArchive,
    identity.sbomPath,
    identity.migrationChecksumFile,
    "release-manifest.json",
  ];
  for (const name of requiredBundleFiles) {
    if (!checksums.byName.has(name)) {
      fail(`${role}_bundle_file_uncovered`, `${name} is not covered by checksums.sha256`);
    }
  }

  const imagePath = childPath(root, identity.imageArchive, `${role}_image_path_invalid`);
  const imageStat = await assertRegularNonEmptyFile(imagePath, `${role}_image_missing`);
  const imageSha = await sha256File(imagePath);
  if (
    imageStat.size !== identity.imageArchiveBytes ||
    imageSha !== identity.imageArchiveSha256 ||
    checksums.byName.get(identity.imageArchive) !== imageSha
  ) {
    fail(`${role}_image_metadata_mismatch`, "Image archive metadata does not match the manifest/bundle");
  }

  const sbomPath = childPath(root, identity.sbomPath, `${role}_sbom_path_invalid`);
  await assertRegularNonEmptyFile(sbomPath, `${role}_sbom_missing`);
  const sbomSha = await sha256File(sbomPath);
  if (sbomSha !== identity.sbomSha256 || checksums.byName.get(identity.sbomPath) !== sbomSha) {
    fail(`${role}_sbom_metadata_mismatch`, "Runtime SBOM checksum does not match the manifest/bundle");
  }
  const sbom = await readJson(sbomPath, `${role}_sbom_invalid`);
  if (sbom?.bomFormat !== "CycloneDX" || sbom?.specVersion !== identity.sbomSpecVersion) {
    fail(`${role}_sbom_invalid`, "Runtime SBOM identity does not match the manifest");
  }

  const migrationPath = childPath(
    root,
    identity.migrationChecksumFile,
    `${role}_migrations_path_invalid`,
  );
  await assertRegularNonEmptyFile(migrationPath, `${role}_migrations_missing`);
  const migrationFileSha = await sha256File(migrationPath);
  if (
    migrationFileSha !== identity.migrationChecksumFileSha256 ||
    migrationFileSha !== identity.migrationAggregateSha256 ||
    checksums.byName.get(identity.migrationChecksumFile) !== migrationFileSha
  ) {
    fail(
      `${role}_migration_metadata_mismatch`,
      "Migration checksum metadata does not match the manifest/bundle",
    );
  }
  const migrationDocument = await parseMigrations(migrationPath, role, identity.migrationCount);
  if (sha256Text(migrationDocument.raw) !== identity.migrationAggregateSha256) {
    fail(`${role}_migration_metadata_mismatch`, "Migration aggregate checksum is invalid");
  }

  return {
    role,
    root,
    version: identity.version,
    revision: identity.commit,
    imageId: identity.imageId,
    imageArchive: identity.imageArchive,
    bundleChecksumsSha256: sha256Text(checksums.raw),
    migrations: migrationDocument.migrations,
  };
}

function migrationRelationship(candidate, rollback) {
  const equalEntry = (left, right) => left.path === right.path && left.sha256 === right.sha256;
  if (
    candidate.migrations.length === rollback.migrations.length &&
    rollback.migrations.every((entry, index) => equalEntry(entry, candidate.migrations[index]))
  ) {
    return { relationship: "same_schema", added: [] };
  }

  if (
    candidate.migrations.length > rollback.migrations.length &&
    rollback.migrations.every((entry, index) => equalEntry(entry, candidate.migrations[index]))
  ) {
    return {
      relationship: "append_only",
      added: candidate.migrations.slice(rollback.migrations.length),
    };
  }

  fail(
    "migration_history_incompatible",
    "Candidate migration history deletes, reorders, or rewrites rollback history",
  );
}

async function writePlan(outputDir, plan) {
  await mkdir(outputDir, { recursive: true });
  const planPath = resolve(outputDir, "release-transition-plan.json");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const sha256 = await sha256File(planPath);
  const checksumPath = resolve(outputDir, "release-transition-plan.sha256");
  await writeFile(checksumPath, `${sha256}  release-transition-plan.json\n`, "utf8");
  return { planPath, checksumPath, sha256 };
}

async function main() {
  const candidateDir = resolve(envValue("TRANSITION_CANDIDATE_DIR"));
  const rollbackDir = resolve(envValue("TRANSITION_ROLLBACK_DIR"));
  if (candidateDir === rollbackDir) {
    fail("bundle_directories_not_distinct", "Candidate and rollback bundle directories must be distinct");
  }
  const outputDir = resolve(
    envValue("TRANSITION_OUTPUT_DIR", { required: false }) || "release-transition-artifacts",
  );
  if (outputDir === candidateDir || outputDir === rollbackDir) {
    fail("output_directory_invalid", "Transition output must not overwrite an evidence bundle");
  }

  const acknowledged = parseBooleanAcknowledgement();
  const candidate = await verifyBundle("candidate", candidateDir);
  const rollback = await verifyBundle("rollback", rollbackDir);
  if (candidate.revision === rollback.revision) {
    fail("release_revisions_not_distinct", "Candidate and rollback revisions must be distinct");
  }

  const migrations = migrationRelationship(candidate, rollback);
  const ready = migrations.relationship === "same_schema" || acknowledged;
  const rollbackPolicy =
    migrations.relationship === "same_schema"
      ? "application_image_rollback_without_schema_change"
      : "application_image_rollback_requires_verified_database_backward_compatibility";

  const plan = {
    schemaVersion: 1,
    kind: "api-whatsapp-release-transition-evidence",
    ready,
    generatedAt: new Date().toISOString(),
    candidate: {
      version: candidate.version,
      revision: candidate.revision,
      imageId: candidate.imageId,
      imageArchive: candidate.imageArchive,
      bundleChecksumsSha256: candidate.bundleChecksumsSha256,
    },
    rollback: {
      version: rollback.version,
      revision: rollback.revision,
      imageId: rollback.imageId,
      imageArchive: rollback.imageArchive,
      bundleChecksumsSha256: rollback.bundleChecksumsSha256,
    },
    migrations: {
      relationship: migrations.relationship,
      rollbackCount: rollback.migrations.length,
      candidateCount: candidate.migrations.length,
      added: migrations.added,
      databaseCompatibilityAcknowledged: acknowledged,
      automaticDatabaseDowngradePerformed: false,
      automaticDatabaseDowngradeProvenSafe: false,
      rollbackPolicy,
    },
    certification: {
      candidate: {
        expectedVersion: candidate.version,
        expectedRevision: candidate.revision,
      },
      rollback: {
        expectedVersion: rollback.version,
        expectedRevision: rollback.revision,
      },
    },
  };

  const written = await writePlan(outputDir, plan);
  process.stdout.write(
    `${OUTPUT_MARKER}${JSON.stringify({
      passed: ready,
      relationship: migrations.relationship,
      candidateRevision: candidate.revision,
      rollbackRevision: rollback.revision,
      addedMigrations: migrations.added.length,
      planSha256: written.sha256,
    })}\n`,
  );

  if (!ready) {
    fail(
      "database_compatibility_ack_required",
      "Append-only schema changes require explicit database compatibility acknowledgement",
    );
  }
}

main().catch((error) => {
  const code = error instanceof TransitionError ? error.code : "release_transition_failed";
  const message =
    error instanceof TransitionError ? error.message : "Release transition evidence generation failed";
  process.stdout.write(`${OUTPUT_MARKER}${JSON.stringify({ passed: false, error: code, message })}\n`);
  process.exitCode = 1;
});
