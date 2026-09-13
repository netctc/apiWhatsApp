import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface MigrationEntry {
  path: string;
  sha256: string;
}

interface BundleOptions {
  commit: string;
  version?: string;
  migrations: MigrationEntry[];
  imageMarker?: string;
  manifestMutation?: (manifest: Record<string, unknown>) => void;
}

interface TransitionResult {
  passed: boolean;
  error?: string;
  relationship?: string;
  candidateRevision?: string;
  rollbackRevision?: string;
  addedMigrations?: number;
}

interface TransitionPlan {
  ready: boolean;
  candidate: { version: string; revision: string; imageId: string };
  rollback: { version: string; revision: string; imageId: string };
  migrations: {
    relationship: string;
    rollbackCount: number;
    candidateCount: number;
    added: MigrationEntry[];
    databaseCompatibilityAcknowledged: boolean;
    automaticDatabaseDowngradePerformed: boolean;
    automaticDatabaseDowngradeProvenSafe: boolean;
    rollbackPolicy: string;
  };
  certification: {
    candidate: { expectedVersion: string; expectedRevision: string };
    rollback: { expectedVersion: string; expectedRevision: string };
  };
}

interface TestFixture {
  root: string;
  candidateDir: string;
  rollbackDir: string;
  outputDir: string;
}

const scriptPath = resolve("scripts/release-transition-evidence.mjs");
const candidateSha = "a".repeat(40);
const rollbackSha = "b".repeat(40);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function migration(pathSuffix: string, marker = "stable"): MigrationEntry {
  const path = `prisma/migrations/${pathSuffix}/migration.sql`;
  return { path, sha256: sha256(`${path}:${marker}`) };
}

const migrationOne = migration("20260101000000_initial");
const migrationTwo = migration("20260201000000_inbox");
const migrationThree = migration("20260301000000_sla");

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createBundle(directory: string, options: BundleOptions): Promise<void> {
  await mkdir(directory, { recursive: true });
  const version = options.version ?? "1.2.3";
  const shortCommit = options.commit.slice(0, 12);
  const imageName = `api-whatsapp-${version}-${shortCommit}.docker.tar.gz`;
  const imageContent = Buffer.from(
    `docker-image:${options.commit}:${options.imageMarker ?? "candidate"}`,
    "utf8",
  );
  const imagePath = join(directory, imageName);
  await writeFile(imagePath, imageContent);

  const sbomName = "runtime-sbom.cdx.json";
  const sbomPath = join(directory, sbomName);
  await writeJson(sbomPath, {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [],
  });

  const migrationDocument = `${options.migrations
    .map((entry) => `${entry.sha256}  ${entry.path}`)
    .join("\n")}\n`;
  const migrationsName = "migrations.sha256";
  const migrationsPath = join(directory, migrationsName);
  await writeFile(migrationsPath, migrationDocument, "utf8");

  const sourceUrl = "https://github.com/example/api-whatsapp";
  const imageId = `sha256:${sha256(`image-id:${options.commit}`)}`;
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "api-whatsapp-release-candidate-evidence",
    application: {
      name: "api-whatsapp",
      version,
    },
    source: {
      repository: "example/api-whatsapp",
      url: sourceUrl,
      commit: options.commit,
      shortCommit,
      committedAt: "2026-09-13T00:00:00.000Z",
    },
    ci: {
      workflow: "CI",
      event: "push",
      conclusion: "success",
      runId: "12345",
      runUrl: "https://github.com/example/api-whatsapp/actions/runs/12345",
    },
    runtime: {
      nodeVersion: "v24.20.0",
      npmVersion: "11.19.0",
    },
    image: {
      tag: `api-whatsapp:rc-${shortCommit}`,
      id: imageId,
      archive: imageName,
      archiveBytes: imageContent.length,
      archiveSha256: sha256(imageContent),
      labels: {
        "org.opencontainers.image.title": "api-whatsapp",
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.revision": options.commit,
        "org.opencontainers.image.source": sourceUrl,
      },
    },
    artifacts: {
      packageLock: { path: "package-lock.json", sha256: "1".repeat(64) },
      prismaSchema: { path: "prisma/schema.prisma", sha256: "2".repeat(64) },
      migrations: {
        count: options.migrations.length,
        checksumFile: migrationsName,
        checksumFileSha256: sha256(migrationDocument),
        aggregateSha256: sha256(migrationDocument),
      },
      runtimeSbom: {
        path: sbomName,
        format: "CycloneDX",
        specVersion: "1.6",
        sha256: sha256(await readFile(sbomPath)),
      },
    },
    promotion: {
      expectedVersion: version,
      expectedRevision: options.commit,
    },
  };
  options.manifestMutation?.(manifest);

  const manifestPath = join(directory, "release-manifest.json");
  await writeJson(manifestPath, manifest);

  const checksumEntries = [imageName, migrationsName, "release-manifest.json", sbomName]
    .sort((left, right) => left.localeCompare(right));
  const checksumDocument = `${(
    await Promise.all(
      checksumEntries.map(async (name) => `${sha256(await readFile(join(directory, name)))}  ${name}`),
    )
  ).join("\n")}\n`;
  await writeFile(join(directory, "checksums.sha256"), checksumDocument, "utf8");
}

async function createFixture(
  candidateMigrations: MigrationEntry[] = [migrationOne, migrationTwo],
  rollbackMigrations: MigrationEntry[] = [migrationOne, migrationTwo],
): Promise<TestFixture> {
  const root = await mkdtemp(join(tmpdir(), "api-whatsapp-transition-"));
  const candidateDir = join(root, "candidate");
  const rollbackDir = join(root, "rollback");
  const outputDir = join(root, "transition");
  await createBundle(candidateDir, { commit: candidateSha, migrations: candidateMigrations });
  await createBundle(rollbackDir, {
    commit: rollbackSha,
    version: "1.2.2",
    migrations: rollbackMigrations,
    imageMarker: "rollback",
  });
  return { root, candidateDir, rollbackDir, outputDir };
}

async function runTransition(
  fixture: TestFixture,
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TRANSITION_CANDIDATE_DIR: fixture.candidateDir,
      TRANSITION_ROLLBACK_DIR: fixture.rollbackDir,
      TRANSITION_OUTPUT_DIR: fixture.outputDir,
      TRANSITION_ACK_DATABASE_COMPATIBILITY: "false",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  return { code, stdout, stderr };
}

function parseResult(stdout: string): TransitionResult {
  const marker = "[release-transition] ";
  const lines = stdout
    .split("\n")
    .filter((line) => line.startsWith(marker));
  if (lines.length === 0) {
    throw new Error("Release transition result was not emitted");
  }
  return JSON.parse(lines[lines.length - 1].slice(marker.length)) as TransitionResult;
}

async function readPlan(fixture: TestFixture): Promise<TransitionPlan> {
  return JSON.parse(
    await readFile(join(fixture.outputDir, "release-transition-plan.json"), "utf8"),
  ) as TransitionPlan;
}

async function verifyPlanChecksum(fixture: TestFixture): Promise<void> {
  const checksumDocument = await readFile(
    join(fixture.outputDir, "release-transition-plan.sha256"),
    "utf8",
  );
  const expected = checksumDocument.slice(0, 64);
  expect(checksumDocument).toBe(`${expected}  release-transition-plan.json\n`);
  expect(expected).toBe(
    sha256(await readFile(join(fixture.outputDir, "release-transition-plan.json"))),
  );
}

async function cleanup(fixture: TestFixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

describe("release transition evidence generator", () => {
  it("accepts distinct release candidates with an identical migration history", async () => {
    const fixture = await createFixture();
    try {
      const result = await runTransition(fixture);
      const summary = parseResult(result.stdout);
      const plan = await readPlan(fixture);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(summary).toMatchObject({
        passed: true,
        relationship: "same_schema",
        candidateRevision: candidateSha,
        rollbackRevision: rollbackSha,
        addedMigrations: 0,
      });
      expect(plan.ready).toBe(true);
      expect(plan.migrations.relationship).toBe("same_schema");
      expect(plan.migrations.databaseCompatibilityAcknowledged).toBe(false);
      expect(plan.migrations.automaticDatabaseDowngradePerformed).toBe(false);
      expect(plan.migrations.automaticDatabaseDowngradeProvenSafe).toBe(false);
      expect(plan.certification.candidate.expectedRevision).toBe(candidateSha);
      expect(plan.certification.rollback.expectedRevision).toBe(rollbackSha);
      await verifyPlanChecksum(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  it("writes a not-ready append-only plan when database compatibility is not acknowledged", async () => {
    const fixture = await createFixture(
      [migrationOne, migrationTwo, migrationThree],
      [migrationOne, migrationTwo],
    );
    try {
      const result = await runTransition(fixture);
      const plan = await readPlan(fixture);

      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({
        passed: false,
        error: "database_compatibility_ack_required",
      });
      expect(plan.ready).toBe(false);
      expect(plan.migrations.relationship).toBe("append_only");
      expect(plan.migrations.added).toEqual([migrationThree]);
      expect(plan.migrations.databaseCompatibilityAcknowledged).toBe(false);
      expect(plan.migrations.rollbackPolicy).toBe(
        "application_image_rollback_requires_verified_database_backward_compatibility",
      );
      await verifyPlanChecksum(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  it("accepts append-only migration history only with explicit compatibility acknowledgement", async () => {
    const fixture = await createFixture(
      [migrationOne, migrationTwo, migrationThree],
      [migrationOne, migrationTwo],
    );
    try {
      const result = await runTransition(fixture, {
        TRANSITION_ACK_DATABASE_COMPATIBILITY: "true",
      });
      const summary = parseResult(result.stdout);
      const plan = await readPlan(fixture);

      expect(result.code).toBe(0);
      expect(summary).toMatchObject({ passed: true, relationship: "append_only", addedMigrations: 1 });
      expect(plan.ready).toBe(true);
      expect(plan.migrations.databaseCompatibilityAcknowledged).toBe(true);
      expect(plan.migrations.automaticDatabaseDowngradePerformed).toBe(false);
      expect(plan.migrations.automaticDatabaseDowngradeProvenSafe).toBe(false);
    } finally {
      await cleanup(fixture);
    }
  });

  it("fails closed when candidate rewrites a historical migration", async () => {
    const rewritten = migration("20260101000000_initial", "rewritten");
    const fixture = await createFixture([rewritten, migrationTwo, migrationThree], [migrationOne, migrationTwo]);
    try {
      const result = await runTransition(fixture, {
        TRANSITION_ACK_DATABASE_COMPATIBILITY: "true",
      });
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({
        passed: false,
        error: "migration_history_incompatible",
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it("fails closed when candidate deletes historical migrations", async () => {
    const fixture = await createFixture([migrationTwo, migrationThree], [migrationOne, migrationTwo]);
    try {
      const result = await runTransition(fixture, {
        TRANSITION_ACK_DATABASE_COMPATIBILITY: "true",
      });
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({
        passed: false,
        error: "migration_history_incompatible",
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it("detects bundle content tampering before release comparison", async () => {
    const fixture = await createFixture();
    try {
      const manifest = JSON.parse(
        await readFile(join(fixture.candidateDir, "release-manifest.json"), "utf8"),
      ) as { image: { archive: string } };
      await writeFile(join(fixture.candidateDir, manifest.image.archive), "tampered-image", "utf8");

      const result = await runTransition(fixture);
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({
        passed: false,
        error: "candidate_bundle_checksum_mismatch",
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it("rejects malformed or duplicate bundle checksum entries", async () => {
    const fixture = await createFixture();
    try {
      const checksumPath = join(fixture.candidateDir, "checksums.sha256");
      const checksumDocument = await readFile(checksumPath, "utf8");
      const firstLine = checksumDocument.split("\n")[0];
      await writeFile(checksumPath, `${firstLine}\n${firstLine}\n`, "utf8");

      const result = await runTransition(fixture);
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({
        passed: false,
        error: "candidate_bundle_checksums_invalid",
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it("rejects a manifest whose declared image metadata does not match the bundle", async () => {
    const fixture = await createFixture();
    try {
      await rm(fixture.candidateDir, { recursive: true, force: true });
      await createBundle(fixture.candidateDir, {
        commit: candidateSha,
        migrations: [migrationOne, migrationTwo],
        manifestMutation: (manifest) => {
          const image = manifest.image as Record<string, unknown>;
          image.archiveBytes = 999999;
        },
      });

      const result = await runTransition(fixture);
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({
        passed: false,
        error: "candidate_image_metadata_mismatch",
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it("rejects duplicate migration paths even when the bundle hashes are internally consistent", async () => {
    const fixture = await createFixture();
    try {
      await rm(fixture.candidateDir, { recursive: true, force: true });
      await createBundle(fixture.candidateDir, {
        commit: candidateSha,
        migrations: [migrationOne, migrationOne],
      });

      const result = await runTransition(fixture);
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({
        passed: false,
        error: "candidate_migrations_invalid",
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it("requires candidate and rollback release revisions to be distinct", async () => {
    const fixture = await createFixture();
    try {
      await rm(fixture.rollbackDir, { recursive: true, force: true });
      await createBundle(fixture.rollbackDir, {
        commit: candidateSha,
        version: "1.2.2",
        migrations: [migrationOne, migrationTwo],
      });

      const result = await runTransition(fixture);
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({
        passed: false,
        error: "release_revisions_not_distinct",
      });
    } finally {
      await cleanup(fixture);
    }
  });

  it("rejects invalid database acknowledgement values", async () => {
    const fixture = await createFixture();
    try {
      const result = await runTransition(fixture, {
        TRANSITION_ACK_DATABASE_COMPATIBILITY: "yes",
      });
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({
        passed: false,
        error: "database_compatibility_ack_invalid",
      });
      await expect(stat(fixture.outputDir)).rejects.toThrow();
    } finally {
      await cleanup(fixture);
    }
  });
});
