import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface EvidenceResult {
  passed: boolean;
  error?: string;
  version?: string;
  commit?: string;
  migrations?: number;
}

interface ReleaseManifest {
  source: { commit: string };
  application: { version: string };
  image: { id: string; archiveSha256: string };
  artifacts: {
    migrations: { count: number; aggregateSha256: string };
    runtimeSbom: { format: string; sha256: string };
  };
  promotion: { expectedVersion: string; expectedRevision: string };
}

interface Fixture {
  root: string;
  outputDir: string;
  sbomPath: string;
  imageArchivePath: string;
}

const scriptPath = resolve("scripts/release-candidate-evidence.mjs");
const sourceSha = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;

async function createFixture(migrationNames = ["20260102000000_second", "20260101000000_first"]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "api-whatsapp-rc-"));
  const outputDir = join(root, "release-candidate-artifacts");
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(root, "prisma", "migrations"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "api-whatsapp", version: "1.2.3" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
  await writeFile(join(root, "prisma", "schema.prisma"), "generator client {}\n", "utf8");

  for (const migrationName of migrationNames) {
    const migrationDir = join(root, "prisma", "migrations", migrationName);
    await mkdir(migrationDir, { recursive: true });
    await writeFile(
      join(migrationDir, "migration.sql"),
      `-- ${migrationName}\nSELECT 1;\n`,
      "utf8",
    );
  }

  const sbomPath = join(outputDir, "runtime-sbom.cdx.json");
  await writeFile(
    sbomPath,
    `${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1, components: [] }, null, 2)}\n`,
    "utf8",
  );
  const imageArchivePath = join(outputDir, "api-whatsapp-1.2.3-aaaaaaaaaaaa.docker.tar.gz");
  await writeFile(imageArchivePath, Buffer.from("deterministic-image-archive-fixture", "utf8"));

  return { root, outputDir, sbomPath, imageArchivePath };
}

function baseEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    RC_EXPECTED_SHA: sourceSha,
    RC_SOURCE_SHA: sourceSha,
    RC_EXPECTED_VERSION: "1.2.3",
    RC_IMAGE_ID: imageId,
    RC_IMAGE_TAG: "api-whatsapp:rc-aaaaaaaaaaaa",
    RC_CI_RUN_ID: "12345",
    RC_CI_RUN_URL: "https://github.com/example/api-whatsapp/actions/runs/12345",
    RC_SOURCE_REPOSITORY: "example/api-whatsapp",
    RC_SOURCE_URL: "https://github.com/example/api-whatsapp",
    RC_OUTPUT_DIR: fixture.outputDir,
    RC_SBOM_PATH: fixture.sbomPath,
    RC_IMAGE_ARCHIVE_PATH: fixture.imageArchivePath,
    RC_SOURCE_DATE_EPOCH: "1700000000",
    RC_NPM_VERSION: "11.19.0",
  };
}

async function runEvidence(fixture: Fixture, overrides: NodeJS.ProcessEnv = {}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: fixture.root,
    env: { ...process.env, ...baseEnv(fixture), ...overrides },
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

function parseResult(stdout: string): EvidenceResult {
  const marker = "[release-candidate] ";
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(marker));
  if (!line) {
    throw new Error("Release candidate evidence result was not emitted");
  }
  return JSON.parse(line.slice(marker.length)) as EvidenceResult;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function verifyBundleChecksums(outputDir: string): Promise<void> {
  const document = await readFile(join(outputDir, "checksums.sha256"), "utf8");
  for (const line of document.trim().split("\n")) {
    const separator = line.indexOf("  ");
    expect(separator).toBeGreaterThan(0);
    const expected = line.slice(0, separator);
    const fileName = line.slice(separator + 2);
    const content = await readFile(join(outputDir, fileName));
    expect(sha256(content)).toBe(expected);
  }
}

async function manifestFor(fixture: Fixture): Promise<ReleaseManifest> {
  return JSON.parse(await readFile(join(fixture.outputDir, "release-manifest.json"), "utf8")) as ReleaseManifest;
}

describe("release candidate evidence generator", () => {
  it("creates a verifiable evidence bundle for an exact release candidate", async () => {
    const fixture = await createFixture();
    try {
      const result = await runEvidence(fixture);
      const summary = parseResult(result.stdout);
      const manifest = await manifestFor(fixture);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(summary).toMatchObject({
        passed: true,
        version: "1.2.3",
        commit: sourceSha,
        migrations: 2,
      });
      expect(manifest.application.version).toBe("1.2.3");
      expect(manifest.source.commit).toBe(sourceSha);
      expect(manifest.image.id).toBe(imageId);
      expect(manifest.artifacts.runtimeSbom.format).toBe("CycloneDX");
      expect(manifest.promotion).toEqual({ expectedVersion: "1.2.3", expectedRevision: sourceSha });
      await verifyBundleChecksums(fixture.outputDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a malformed expected commit SHA before generating evidence", async () => {
    const fixture = await createFixture();
    try {
      const result = await runEvidence(fixture, { RC_EXPECTED_SHA: sourceSha.toUpperCase() });
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({ passed: false, error: "expected_sha_invalid" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a checked-out commit that does not match the expected SHA", async () => {
    const fixture = await createFixture();
    try {
      const result = await runEvidence(fixture, { RC_SOURCE_SHA: "c".repeat(40) });
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({ passed: false, error: "source_sha_mismatch" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an expected version that does not match package.json", async () => {
    const fixture = await createFixture();
    try {
      const result = await runEvidence(fixture, { RC_EXPECTED_VERSION: "1.2.4" });
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({ passed: false, error: "version_mismatch" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("hashes migrations deterministically regardless of directory creation order", async () => {
    const first = await createFixture(["20260102000000_second", "20260101000000_first"]);
    const second = await createFixture(["20260101000000_first", "20260102000000_second"]);
    try {
      expect((await runEvidence(first)).code).toBe(0);
      expect((await runEvidence(second)).code).toBe(0);

      const firstChecksums = await readFile(join(first.outputDir, "migrations.sha256"), "utf8");
      const secondChecksums = await readFile(join(second.outputDir, "migrations.sha256"), "utf8");
      expect(firstChecksums).toBe(secondChecksums);
      expect(firstChecksums.split("\n")[0]).toContain("20260101000000_first/migration.sql");

      const firstManifest = await manifestFor(first);
      const secondManifest = await manifestFor(second);
      expect(firstManifest.artifacts.migrations.count).toBe(2);
      expect(firstManifest.artifacts.migrations.aggregateSha256).toBe(
        secondManifest.artifacts.migrations.aggregateSha256,
      );
    } finally {
      await rm(first.root, { recursive: true, force: true });
      await rm(second.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the supplied SBOM is not CycloneDX", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(fixture.sbomPath, '{"bomFormat":"SPDX","specVersion":"2.3"}\n', "utf8");
      const result = await runEvidence(fixture);
      expect(result.code).toBe(1);
      expect(parseResult(result.stdout)).toMatchObject({ passed: false, error: "sbom_invalid" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
