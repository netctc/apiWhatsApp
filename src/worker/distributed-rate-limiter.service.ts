import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

@Injectable()
export class DistributedRateLimiterService implements OnModuleDestroy {
  private readonly logger = new Logger(DistributedRateLimiterService.name);
  private readonly redis: Redis;

  constructor(private readonly config: ConfigService) {
    const redisUrl = this.config.get<string>("REDIS_URL");
    if (!redisUrl) {
      throw new Error("REDIS_URL is required");
    }

    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  }

  async waitForOutboundSlot(phoneNumberId: string, configuredLimit?: number): Promise<void> {
    const defaultLimit = Number(this.config.get("DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND") ?? 75);
    const limit = Math.max(1, configuredLimit ?? defaultLimit);

    for (;;) {
      await this.ensureConnected();

      const now = Date.now();
      const window = Math.floor(now / 1000);
      const key = `rate:whatsapp:outbound:${phoneNumberId}:${window}`;
      const current = await this.redis.eval(
        "local current = redis.call('INCR', KEYS[1]); if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return current;",
        1,
        key,
        2000,
      );

      if (typeof current === "number" && current <= limit) {
        return;
      }

      const delayMs = Math.max(25, 1000 - (now % 1000) + 5);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status !== "end") {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === "ready" || this.redis.status === "connecting" || this.redis.status === "connect") {
      return;
    }

    if (this.redis.status === "wait") {
      try {
        await this.redis.connect();
        return;
      } catch (error) {
        this.logger.error("Unable to connect to Redis rate limiter");
        throw error;
      }
    }

    if (this.redis.status === "end") {
      throw new Error("Redis rate limiter connection is closed");
    }
  }
}
