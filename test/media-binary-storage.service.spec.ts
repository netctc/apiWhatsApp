import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MediaBinaryStorageError,
  MediaBinaryStorageService,
} from "../src/media/media-binary-storage.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const ASSET_ID = "123e4567-e89b-42d3-a456-426614174001";
const STORAGE_ENV_KEYS = [
  "MEDIA_BINARY_STORAGE_MODE",
  "MEDIA_FILESYSTEM_STORAGE_PATH",
  "MEDIA_FILESYSTEM_MIN_FREE_BYTES",
  "MEDIA_FILESYSTEM_MIN_FREE_PERCENT",
] as const;

describe("MediaBinaryStorageService", () => {
  const service = new MediaBinaryStorageService();
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of STORAGE_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    for (const key of STORAGE_ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("plans no storage and reports readiness up when binary retention is disabled", async () => {
    delete process.env.MEDIA_BINARY_STORAGE_MODE;

    const target = service.targetFor(TENANT_ID, ASSET_ID);
    expect(target).toEqual({ mode: "DISABLED", key: null });
    await expect(service.stage("/tmp/source", target)).resolves.toEqual({
      mode: "DISABLED",
      key: null,
      filePath: "/tmp/source",
      storedAt: null,
    });
    await expect(service.diagnostics()).resolves.toEqual({
      status: "up",
      mode: "disabled",
    });
  });

  it("plans an internal key before streaming bytes with restrictive permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-media-storage-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "api-whatsapp-media-source-"));
    const sourcePath = join(sourceDir, "client-name.jpg");
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(140_000, 0x41),
      Buffer.from([0xff, 0xd9]),
    ]);
    await writeFile(sourcePath, bytes);
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = root;
    process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES = "0";
    process.env.MEDIA_FILESYSTEM_MIN_FREE_PERCENT = "0";

    try {
      const target = service.targetFor(TENANT_ID, ASSET_ID);
      expect(target).toEqual({
        mode: "FILESYSTEM",
        key: `${TENANT_ID}/${ASSET_ID}`,
      });

      const staged = await service.stage(sourcePath, target);
      expect(staged.mode).toBe("FILESYSTEM");
      expect(staged.key).toBe(`${TENANT_ID}/${ASSET_ID}`);
      expect(staged.filePath).toBe(join(root, TENANT_ID, ASSET_ID));
      expect(staged.storedAt).toBeInstanceOf(Date);
      await expect(readFile(staged.filePath)).resolves.toEqual(bytes);
      expect((await stat(staged.filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, TENANT_ID))).mode & 0o777).toBe(0o700);

      await expect(service.diagnostics()).resolves.toEqual(
        expect.objectContaining({
          status: "up",
          mode: "filesystem",
          totalBytes: expect.any(Number),
          freeBytes: expect.any(Number),
          freePercent: expect.any(Number),
          minimumFreeBytes: 0,
          minimumFreePercent: 0,
        }),
      );

      await service.discard(staged.mode, staged.key);
      await expect(access(staged.filePath)).rejects.toThrow();
      await expect(service.discard(staged.mode, staged.key)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it("reports low capacity when either configured reserve threshold is breached", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-media-storage-"));
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = root;
    process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    process.env.MEDIA_FILESYSTEM_MIN_FREE_PERCENT = "0";

    try {
      await expect(service.diagnostics()).resolves.toEqual(
        expect.objectContaining({
          status: "down",
          mode: "filesystem",
          error: "low_capacity",
          minimumFreeBytes: Number.MAX_SAFE_INTEGER,
          minimumFreePercent: 0,
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports invalid diagnostic configuration without exposing a path", async () => {
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = "relative/media";

    await expect(service.diagnostics()).resolves.toEqual({
      status: "down",
      mode: "filesystem",
      error: "not_configured",
    });

    process.env.MEDIA_BINARY_STORAGE_MODE = "unknown";
    await expect(service.diagnostics()).resolves.toEqual({
      status: "down",
      mode: "invalid",
      error: "not_configured",
    });
  });

  it("reports an unavailable filesystem when the configured root cannot be accessed", async () => {
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = join(
      tmpdir(),
      `api-whatsapp-missing-storage-${process.pid}-${Date.now()}`,
    );
    process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES = "0";
    process.env.MEDIA_FILESYSTEM_MIN_FREE_PERCENT = "0";

    await expect(service.diagnostics()).resolves.toEqual({
      status: "down",
      mode: "filesystem",
      error: "unavailable",
      minimumFreeBytes: 0,
      minimumFreePercent: 0,
    });
  });

  it("fails closed while planning when filesystem mode has no absolute storage root", () => {
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    delete process.env.MEDIA_FILESYSTEM_STORAGE_PATH;

    expect(() => service.targetFor(TENANT_ID, ASSET_ID)).toThrow(MediaBinaryStorageError);

    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = "relative/media";
    expect(() => service.targetFor(TENANT_ID, ASSET_ID)).toThrow(
      "MEDIA_FILESYSTEM_STORAGE_PATH must be an absolute path",
    );
  });

  it("rejects planned keys that resolve outside the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-media-storage-"));
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = root;

    try {
      expect(() => service.targetFor("tenant", "../../escape")).toThrow(
        "Media storage key resolved outside the configured root",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
