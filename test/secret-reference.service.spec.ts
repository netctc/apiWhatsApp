import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecretReferenceError,
  SecretReferenceService,
} from "../src/meta/secret-reference.service.js";

const ENV_KEYS = ["SECRET_FILE_ROOTS", "TEST_MOUNTED_META_TOKEN"] as const;

describe("SecretReferenceService", () => {
  const service = new SecretReferenceService();
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("preserves env: references with strict variable names", async () => {
    process.env.TEST_MOUNTED_META_TOKEN = "env-secret-value";

    await expect(service.resolve("env:TEST_MOUNTED_META_TOKEN")).resolves.toBe(
      "env-secret-value",
    );
    await expect(service.resolve("env:bad-name")).rejects.toMatchObject({
      name: "SecretReferenceError",
      reason: "INVALID_REFERENCE",
    });
  });

  it("reads a mounted single-line secret under an explicitly allowed root and trims only trailing line endings", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-secret-root-"));
    const secretPath = join(root, "meta-token");
    await writeFile(secretPath, "mounted-secret-value\n", { mode: 0o600 });
    process.env.SECRET_FILE_ROOTS = root;

    try {
      await expect(service.resolve(`file:${secretPath}`)).resolves.toBe("mounted-secret-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not cache mounted values so atomic secret rotation is visible on the next resolve", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-secret-root-"));
    const secretPath = join(root, "meta-token");
    process.env.SECRET_FILE_ROOTS = root;

    try {
      await writeFile(secretPath, "first-secret", { mode: 0o600 });
      await expect(service.resolve(`file:${secretPath}`)).resolves.toBe("first-secret");

      await writeFile(secretPath, "second-secret", { mode: 0o600 });
      await expect(service.resolve(`file:${secretPath}`)).resolves.toBe("second-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute files outside every configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-secret-root-"));
    const outside = await mkdtemp(join(tmpdir(), "api-whatsapp-secret-outside-"));
    const outsidePath = join(outside, "token");
    await writeFile(outsidePath, "outside-secret", { mode: 0o600 });
    process.env.SECRET_FILE_ROOTS = root;

    try {
      await expect(service.resolve(`file:${outsidePath}`)).rejects.toMatchObject({
        reason: "INVALID_REFERENCE",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlink escape whose resolved target is outside the allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-secret-root-"));
    const outside = await mkdtemp(join(tmpdir(), "api-whatsapp-secret-outside-"));
    const outsidePath = join(outside, "token");
    const linkPath = join(root, "token-link");
    await writeFile(outsidePath, "outside-secret", { mode: 0o600 });
    await symlink(outsidePath, linkPath);
    process.env.SECRET_FILE_ROOTS = root;

    try {
      await expect(service.resolve(`file:${linkPath}`)).rejects.toMatchObject({
        reason: "INVALID_REFERENCE",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects relative paths, root-level allowlists, oversized files, and multiline values", async () => {
    await expect(service.resolve("file:relative/token")).rejects.toBeInstanceOf(
      SecretReferenceError,
    );

    process.env.SECRET_FILE_ROOTS = "/";
    await expect(service.resolve("file:/tmp/token")).rejects.toMatchObject({
      reason: "NOT_CONFIGURED",
    });

    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-secret-root-"));
    process.env.SECRET_FILE_ROOTS = root;
    const oversized = join(root, "oversized");
    const multiline = join(root, "multiline");
    await writeFile(oversized, Buffer.alloc(64 * 1024 + 1, 0x41), { mode: 0o600 });
    await writeFile(multiline, "line-one\nline-two", { mode: 0o600 });

    try {
      await expect(service.resolve(`file:${oversized}`)).rejects.toMatchObject({
        reason: "INVALID_SECRET",
      });
      await expect(service.resolve(`file:${multiline}`)).rejects.toMatchObject({
        reason: "INVALID_SECRET",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
