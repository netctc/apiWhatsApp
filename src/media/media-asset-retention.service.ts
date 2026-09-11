import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { MediaBinaryStorageService } from "./media-binary-storage.service.js";

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MIN_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_UPLOAD_MS = 2 * 60 * 60 * 1000;
const MIN_STALE_UPLOAD_MS = 30 * 60 * 1000;
const MAX_STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 200;
const ABANDONED_UPLOAD_FAILURE_CODE = "UPLOAD_ABANDONED";

export interface MediaAssetReconciliationResult {
  markedFailed: number;
  binariesCleaned: number;
  cleanupDeferred: number;
}

@Injectable()
export class MediaAssetRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MediaAssetRetentionService.name);
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly binaryStorage: MediaBinaryStorageService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const intervalMs = this.readCleanupIntervalMs();
    this.readStaleUploadMs();
    await this.runMaintenance("Initial");

    this.cleanupTimer = setInterval(() => {
      void this.runMaintenance("Periodic");
    }, intervalMs);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  async reconcileStaleUploads(now = new Date()): Promise<MediaAssetReconciliationResult> {
    const staleBefore = new Date(now.getTime() - this.readStaleUploadMs());
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        providerMediaId: null,
        OR: [
          {
            failedAt: null,
            updatedAt: { lte: staleBefore },
          },
          {
            failureCode: ABANDONED_UPLOAD_FAILURE_CODE,
            storageKey: { not: null },
          },
        ],
      },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
      take: CLEANUP_BATCH_SIZE,
      select: {
        id: true,
        storageMode: true,
        storageKey: true,
        failureCode: true,
      },
    });

    let markedFailed = 0;
    let binariesCleaned = 0;
    let cleanupDeferred = 0;

    for (const asset of assets) {
      if (asset.failureCode !== ABANDONED_UPLOAD_FAILURE_CODE) {
        const claimed = await this.prisma.mediaAsset.updateMany({
          where: {
            id: asset.id,
            providerMediaId: null,
            failedAt: null,
            updatedAt: { lte: staleBefore },
          },
          data: {
            failedAt: now,
            failureCode: ABANDONED_UPLOAD_FAILURE_CODE,
          },
        });
        if (claimed.count !== 1) {
          continue;
        }
        markedFailed += 1;
      }

      if (!asset.storageKey) {
        continue;
      }

      try {
        await this.binaryStorage.discard(asset.storageMode, asset.storageKey);
      } catch {
        cleanupDeferred += 1;
        this.logger.error(
          `Unable to reconcile abandoned media binary asset=${asset.id} mode=${asset.storageMode}`,
        );
        continue;
      }

      const cleared = await this.prisma.mediaAsset.updateMany({
        where: {
          id: asset.id,
          providerMediaId: null,
          failureCode: ABANDONED_UPLOAD_FAILURE_CODE,
          storageKey: asset.storageKey,
        },
        data: {
          storageKey: null,
          storedAt: null,
        },
      });
      binariesCleaned += cleared.count;
    }

    if (markedFailed > 0 || binariesCleaned > 0 || cleanupDeferred > 0) {
      this.logger.log(
        `Media upload reconciliation markedFailed=${markedFailed} binariesCleaned=${binariesCleaned} cleanupDeferred=${cleanupDeferred}`,
      );
    }

    return { markedFailed, binariesCleaned, cleanupDeferred };
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        expiresAt: { lte: now },
      },
      orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
      take: CLEANUP_BATCH_SIZE,
      select: {
        id: true,
        storageMode: true,
        storageKey: true,
      },
    });

    let deleted = 0;
    for (const asset of assets) {
      try {
        await this.binaryStorage.discard(asset.storageMode, asset.storageKey);
      } catch {
        this.logger.error(
          `Unable to remove expired media binary asset=${asset.id} mode=${asset.storageMode}`,
        );
        continue;
      }

      const result = await this.prisma.mediaAsset.deleteMany({
        where: {
          id: asset.id,
          expiresAt: { lte: now },
        },
      });
      deleted += result.count;
    }

    if (deleted > 0) {
      this.logger.log(`Deleted ${deleted} expired media asset registry entr${deleted === 1 ? "y" : "ies"}`);
    }
    return deleted;
  }

  private async runMaintenance(prefix: "Initial" | "Periodic"): Promise<void> {
    await this.reconcileStaleUploads().catch((error: unknown) => {
      this.logger.error(
        `${prefix} media asset reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    await this.purgeExpired().catch((error: unknown) => {
      this.logger.error(
        `${prefix} media asset retention cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private readCleanupIntervalMs(): number {
    const raw = process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS;
    if (raw === undefined || raw.trim() === "") {
      return DEFAULT_CLEANUP_INTERVAL_MS;
    }

    const value = Number(raw);
    if (
      !Number.isInteger(value) ||
      value < MIN_CLEANUP_INTERVAL_MS ||
      value > MAX_CLEANUP_INTERVAL_MS
    ) {
      throw new Error(
        `MEDIA_ASSET_CLEANUP_INTERVAL_MS must be an integer between ${MIN_CLEANUP_INTERVAL_MS} and ${MAX_CLEANUP_INTERVAL_MS}`,
      );
    }
    return value;
  }

  private readStaleUploadMs(): number {
    const raw = process.env.MEDIA_ASSET_STALE_UPLOAD_MS;
    if (raw === undefined || raw.trim() === "") {
      return DEFAULT_STALE_UPLOAD_MS;
    }

    const value = Number(raw);
    if (
      !Number.isInteger(value) ||
      value < MIN_STALE_UPLOAD_MS ||
      value > MAX_STALE_UPLOAD_MS
    ) {
      throw new Error(
        `MEDIA_ASSET_STALE_UPLOAD_MS must be an integer between ${MIN_STALE_UPLOAD_MS} and ${MAX_STALE_UPLOAD_MS}`,
      );
    }
    return value;
  }
}
