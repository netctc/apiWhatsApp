import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MediaBinaryStorageError,
  MediaBinaryStorageService,
} from "../src/media/media-binary-storage.service.js";

const STORAGE_ENV_KEYS = [
  "MEDIA_BINARY_STORAGE_MODE",
  "MEDIA_FILESYSTEM_STORAGE_PATH",
  "MEDIA_FILESYSTEM_MIN_FREE_BYTES",
  "MEDIA_FILESYSTEM_MIN_FREE_PERCENT",
] as const;

describe("MediaBinaryStorageService capacity admission", () => {
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

  it("does not perform filesystem admission when binary retention is disabled", async () => {
    process.env.MEDIA_BINARY_STORAGE_MODE = "disabled";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = "/definitely/not/a/real/storage/root";

    await expect(service.assertCapacityFor(Number.MAX_SAFE_INTEGER)).resolves.toBeUndefined();
  });

  it("admits a bounded filesystem write when projected reserves remain satisfied", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-media-admission-unit-"));
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = root;
    process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES = "0";
    process.env.MEDIA_FILESYSTEM_MIN_FREE_PERCENT = "0";

    try {
      await expect(service.assertCapacityFor(1024)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a prospective filesystem write that crosses the configured reserve", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-media-admission-unit-"));
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = root;
    process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    process.env.MEDIA_FILESYSTEM_MIN_FREE_PERCENT = "0";

    try {
      await expect(service.assertCapacityFor(1)).rejects.toBeInstanceOf(MediaBinaryStorageError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the configured filesystem cannot be inspected", async () => {
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = join(
      tmpdir(),
      `api-whatsapp-media-admission-missing-${process.pid}-${Date.now()}`,
    );
    process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES = "0";
    process.env.MEDIA_FILESYSTEM_MIN_FREE_PERCENT = "0";

    await expect(service.assertCapacityFor(1)).rejects.toThrow(
      "Filesystem media storage is unavailable",
    );
  });
});
