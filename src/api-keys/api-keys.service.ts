import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuditRequestContext } from "../audit/audit.types.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { generateApiKey, hashApiKey } from "../auth/api-key.util.js";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreateApiKeyDto } from "./dto/create-api-key.dto.js";

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async create(principal: ApiPrincipal, context: AuditRequestContext, dto: CreateApiKeyDto) {
    const requestedScopes = [...new Set(dto.scopes)];
    const unauthorizedScopes = requestedScopes.filter((scope) => !principal.scopes.includes(scope));
    if (unauthorizedScopes.length > 0) {
      throw new ForbiddenException(`Cannot grant scopes not held by the current API key: ${unauthorizedScopes.join(", ")}`);
    }

    const hashSecret = process.env.API_KEY_HASH_SECRET;
    if (!hashSecret) {
      throw new Error("API_KEY_HASH_SECRET is required");
    }

    const generated = generateApiKey();
    const keyHash = hashApiKey(generated.rawKey, hashSecret);

    const apiKey = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.apiKey.create({
        data: {
          tenantId: principal.tenantId,
          name: dto.name.trim(),
          prefix: generated.prefix,
          keyHash,
          scopes: requestedScopes,
        },
      });

      await transaction.auditLog.create({
        data: {
          tenantId: principal.tenantId,
          actorApiKeyId: principal.apiKeyId,
          action: "api_key.created",
          entityType: "ApiKey",
          entityId: created.id,
          metadata: this.toJson({
            name: created.name,
            prefix: created.prefix,
            scopes: created.scopes,
          }),
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
      });

      return created;
    });

    return {
      apiKey: generated.rawKey,
      key: this.safeApiKey(apiKey),
    };
  }

  list(tenantId: string) {
    return this.prisma.apiKey.findMany({
      where: { tenantId },
      orderBy: [{ active: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        active: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
    });
  }

  async revoke(principal: ApiPrincipal, context: AuditRequestContext, id: string) {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.apiKey.findFirst({
        where: { id, tenantId: principal.tenantId },
      });
      if (!existing) {
        throw new NotFoundException("API key not found");
      }

      if (!existing.active || existing.revokedAt) {
        return this.safeApiKey(existing);
      }

      const revokedAt = new Date();
      const revoked = await transaction.apiKey.update({
        where: { id },
        data: { active: false, revokedAt },
      });

      await transaction.auditLog.create({
        data: {
          tenantId: principal.tenantId,
          actorApiKeyId: principal.apiKeyId,
          action: "api_key.revoked",
          entityType: "ApiKey",
          entityId: revoked.id,
          metadata: this.toJson({
            name: revoked.name,
            prefix: revoked.prefix,
            scopes: revoked.scopes,
          }),
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
      });

      return this.safeApiKey(revoked);
    });
  }

  private safeApiKey(apiKey: {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    active: boolean;
    lastUsedAt: Date | null;
    createdAt: Date;
    revokedAt: Date | null;
  }) {
    return {
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
      active: apiKey.active,
      lastUsedAt: apiKey.lastUsedAt,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt,
    };
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
