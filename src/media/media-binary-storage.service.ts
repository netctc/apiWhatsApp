import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Injectable } from "@nestjs/common";

export type MediaBinaryStorageMode = "DISABLED" | "FILESYSTEM";

export interface StagedMediaBinary {
  mode: MediaBinaryStorageMode;
  key: string | null;
  filePath: string;
  storedAt: Date | null;
}

export class MediaBinaryStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaBinaryStorageError";
  }
}

@Injectable()
export class MediaBinaryStorageService {
  async stage(sourcePath: string, tenantId: string, assetId: string): Promise<StagedMediaBinary> {
    const mode = this.mode();
    if (mode === "DISABLED") {
      return {
        mode,
        key: null,
        filePath: sourcePath,
        storedAt: null,
      };
    }

    const root = this.filesystemRoot();
    const key = `${tenantId}/${assetId}`;
    const targetPath = this.pathForKey(root, key);

    try {
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await pipeline(
        createReadStream(sourcePath),
        createWriteStream(targetPath, { flags: "wx", mode: 0o600 }),
      );
    } catch (error) {
      await rm(targetPath, { force: true }).catch(() => undefined);
      throw new MediaBinaryStorageError(
        `Unable to stage media binary: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      mode,
      key,
      filePath: targetPath,
      storedAt: new Date(),
    };
  }

  async discard(mode: string, key: string | null | undefined): Promise<void> {
    if (!key || mode === "DISABLED") {
      return;
    }
    if (mode !== "FILESYSTEM") {
      throw new MediaBinaryStorageError(`Unsupported persisted media storage mode: ${mode}`);
    }

    const root = this.filesystemRoot();
    const targetPath = this.pathForKey(root, key);
    await rm(targetPath, { force: true }).catch((error: unknown) => {
      throw new MediaBinaryStorageError(
        `Unable to delete stored media binary: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private mode(): MediaBinaryStorageMode {
    const value = (process.env.MEDIA_BINARY_STORAGE_MODE ?? "disabled").trim().toLowerCase();
    if (value === "disabled") {
      return "DISABLED";
    }
    if (value === "filesystem") {
      return "FILESYSTEM";
    }
    throw new MediaBinaryStorageError(`Unsupported MEDIA_BINARY_STORAGE_MODE: ${value}`);
  }

  private filesystemRoot(): string {
    const configured = process.env.MEDIA_FILESYSTEM_STORAGE_PATH?.trim();
    if (!configured) {
      throw new MediaBinaryStorageError(
        "MEDIA_FILESYSTEM_STORAGE_PATH is required for filesystem media storage",
      );
    }
    if (!isAbsolute(configured)) {
      throw new MediaBinaryStorageError("MEDIA_FILESYSTEM_STORAGE_PATH must be an absolute path");
    }

    const root = resolve(configured);
    if (root === sep) {
      throw new MediaBinaryStorageError("MEDIA_FILESYSTEM_STORAGE_PATH cannot be the filesystem root");
    }
    return root;
  }

  private pathForKey(root: string, key: string): string {
    const targetPath = resolve(root, key);
    if (!targetPath.startsWith(`${root}${sep}`)) {
      throw new MediaBinaryStorageError("Media storage key resolved outside the configured root");
    }
    return targetPath;
  }
}
