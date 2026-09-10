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
const CLEANUP_BATCH_SIZE = 200;

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
    await this.purgeExpired().catch((error: unknown) => {
      this.logger.error(
        `Initial media asset retention cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    this.cleanupTimer = setInterval(() => {
      void this.purgeExpired().catch((error: unknown) => {
        this.logger.error(
          `Media asset retention cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, intervalMs);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
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
}
