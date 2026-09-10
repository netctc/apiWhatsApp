import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MIN_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MediaAssetRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MediaAssetRetentionService.name);
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

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
    const result = await this.prisma.mediaAsset.deleteMany({
      where: {
        expiresAt: { lte: now },
      },
    });

    if (result.count > 0) {
      this.logger.log(`Deleted ${result.count} expired media asset registry entr${result.count === 1 ? "y" : "ies"}`);
    }
    return result.count;
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
