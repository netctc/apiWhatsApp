import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import { MessageTrafficClass } from "../generated/prisma/client.js";

const RESERVE_SLOT_LUA = `
local total = tonumber(redis.call('GET', KEYS[1]) or '0')
local classCurrent = tonumber(redis.call('GET', KEYS[2]) or '0')
local totalLimit = tonumber(ARGV[1])
local classLimit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

if total >= totalLimit or classCurrent >= classLimit then
  return 0
end

local newTotal = redis.call('INCR', KEYS[1])
local newClass = redis.call('INCR', KEYS[2])
if newTotal == 1 then redis.call('PEXPIRE', KEYS[1], ttl) end
if newClass == 1 then redis.call('PEXPIRE', KEYS[2], ttl) end
return 1
`;

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

  async waitForOutboundSlot(
    phoneNumberId: string,
    trafficClass: MessageTrafficClass,
    configuredLimit?: number,
  ): Promise<void> {
    const defaultLimit = Number(this.config.get("DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND") ?? 75);
    const candidateLimit = configuredLimit ?? defaultLimit;
    const limit =
      Number.isFinite(candidateLimit) && candidateLimit > 0 ? Math.max(1, Math.floor(candidateLimit)) : 75;
    const reservationWindowMs = this.reservationWindowMs();

    for (;;) {
      await this.ensureConnected();

      const now = Date.now();
      const elapsed = now % 1000;
      const window = Math.floor(now / 1000);
      const canBorrow = elapsed >= reservationWindowMs;
      const classLimit = canBorrow ? limit : this.reservedClassLimit(limit, trafficClass);

      // Keep the pre-0.6 total key shape so old and new workers share one sender limit during rolling upgrades.
      const totalKey = `rate:whatsapp:outbound:${phoneNumberId}:${window}`;
      const classKey = `rate:whatsapp:outbound:${phoneNumberId}:${window}:${trafficClass.toLowerCase()}`;

      const accepted = await this.redis.eval(
        RESERVE_SLOT_LUA,
        2,
        totalKey,
        classKey,
        limit,
        classLimit,
        2000,
      );

      if (accepted === 1) {
        return;
      }

      const delayMs =
        elapsed < reservationWindowMs
          ? Math.max(25, reservationWindowMs - elapsed + 5)
          : Math.max(25, 1000 - elapsed + 5);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status !== "end") {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
  }

  private reservedClassLimit(limit: number, trafficClass: MessageTrafficClass): number {
    const shares = this.reservationShares();
    switch (trafficClass) {
      case MessageTrafficClass.OTP:
        return limit;
      case MessageTrafficClass.TRANSACTIONAL:
        return Math.max(1, Math.floor(limit * shares.transactional));
      case MessageTrafficClass.MARKETING:
        return Math.max(1, Math.floor(limit * shares.marketing));
    }
  }

  private reservationShares(): { transactional: number; marketing: number } {
    const transactional = this.share("OUTBOUND_TRANSACTIONAL_MAX_SHARE", 0.6);
    const marketing = this.share("OUTBOUND_MARKETING_MAX_SHARE", 0.2);

    // Preserve at least 10% headroom for OTP during the reservation phase.
    if (transactional + marketing > 0.9) {
      return { transactional: 0.6, marketing: 0.2 };
    }
    return { transactional, marketing };
  }

  private reservationWindowMs(): number {
    const value = Number(this.config.get("OUTBOUND_PRIORITY_RESERVATION_WINDOW_MS") ?? 700);
    return Number.isFinite(value) && value >= 0 && value <= 950 ? Math.floor(value) : 700;
  }

  private share(name: string, fallback: number): number {
    const value = Number(this.config.get(name) ?? fallback);
    return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
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
