import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MediaBinaryStorageError,
  MediaBinaryStorageService,
} from "../src/media/media-binary-storage.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const ASSET_ID = "123e4567-e89b-42d3-a456-426614174001";
const STORAGE_ENV_KEYS = ["MEDIA_BINARY_STORAGE_MODE", "MEDIA_FILESYSTEM_STORAGE_PATH"] as const;

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

  it("leaves the temporary upload in place when binary retention is disabled", async () => {
    delete process.env.MEDIA_BINARY_STORAGE_MODE;

    await expect(service.stage("/tmp/source", TENANT_ID, ASSET_ID)).resolves.toEqual({
      mode: "DISABLED",
      key: null,
      filePath: "/tmp/source",
      storedAt: null,
    });
  });

  it("streams a file into an internal tenant/asset key with restrictive permissions", async () => {
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

    try {
      const staged = await service.stage(sourcePath, TENANT_ID, ASSET_ID);
      expect(staged.mode).toBe("FILESYSTEM");
      expect(staged.key).toBe(`${TENANT_ID}/${ASSET_ID}`);
      expect(staged.filePath).toBe(join(root, TENANT_ID, ASSET_ID));
      expect(staged.storedAt).toBeInstanceOf(Date);
      await expect(readFile(staged.filePath)).resolves.toEqual(bytes);
      expect((await stat(staged.filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, TENANT_ID))).mode & 0o777).toBe(0o700);

      await service.discard(staged.mode, staged.key);
      await expect(access(staged.filePath)).rejects.toThrow();
      await expect(service.discard(staged.mode, staged.key)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it("fails closed when filesystem mode has no absolute storage root", async () => {
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    delete process.env.MEDIA_FILESYSTEM_STORAGE_PATH;

    await expect(service.stage("/tmp/source", TENANT_ID, ASSET_ID)).rejects.toBeInstanceOf(
      MediaBinaryStorageError,
    );

    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = "relative/media";
    await expect(service.stage("/tmp/source", TENANT_ID, ASSET_ID)).rejects.toMatchObject({
      message: "MEDIA_FILESYSTEM_STORAGE_PATH must be an absolute path",
    });
  });

  it("rejects storage keys that resolve outside the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-whatsapp-media-storage-"));
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = root;

    try {
      await expect(service.stage("/tmp/source", "tenant", "../../escape")).rejects.toMatchObject({
        name: "MediaBinaryStorageError",
        message: "Media storage key resolved outside the configured root",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
