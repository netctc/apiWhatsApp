import { Injectable, Logger } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { TenantStatus } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { hashApiKey, parseApiKey } from "./api-key.util.js";
import type { ApiAuthContext } from "./auth.types.js";

const LAST_USED_WRITE_INTERVAL_MS = 15 * 60 * 1000;

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(private readonly prisma: PrismaService) {}

  async authenticate(rawKey: string): Promise<ApiAuthContext | undefined> {
    const parsed = parseApiKey(rawKey);
    if (!parsed) {
      return undefined;
    }

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyPrefix: parsed.keyPrefix },
      include: { tenant: true },
    });

    if (!apiKey || !this.matchesHash(rawKey, apiKey.keyHash)) {
      return undefined;
    }

    const now = new Date();
    if (
      apiKey.revokedAt ||
      (apiKey.expiresAt && apiKey.expiresAt <= now) ||
      apiKey.tenant.status !== TenantStatus.ACTIVE
    ) {
      return undefined;
    }

    this.touchLastUsed(apiKey.id, apiKey.lastUsedAt, now);

    return {
      tenantId: apiKey.tenantId,
      apiKeyId: apiKey.id,
      scopes: apiKey.scopes,
    };
  }

  private matchesHash(rawKey: string, storedHash: string): boolean {
    const actual = Buffer.from(hashApiKey(rawKey), "hex");
    const expected = Buffer.from(storedHash, "hex");

    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private touchLastUsed(apiKeyId: string, lastUsedAt: Date | null, now: Date): void {
    if (lastUsedAt && now.getTime() - lastUsedAt.getTime() < LAST_USED_WRITE_INTERVAL_MS) {
      return;
    }

    const cutoff = new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS);
    void this.prisma.apiKey
      .updateMany({
        where: {
          id: apiKeyId,
          OR: [
            { lastUsedAt: null },
            { lastUsedAt: { lt: cutoff } },
          ],
        },
        data: { lastUsedAt: now },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Unable to update lastUsedAt for API key ${apiKeyId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
