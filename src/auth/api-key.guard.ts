import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { TenantStatus } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { IS_PUBLIC_KEY } from "./auth.constants.js";
import { hashApiKey } from "./api-key.util.js";
import { ApiPrincipal } from "./auth.types.js";

const LAST_USED_WRITE_INTERVAL_MS = 15 * 60 * 1000;

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined>; principal?: ApiPrincipal }>();
    const rawHeader = request.headers["x-api-key"];
    const rawKey = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!rawKey) {
      throw new UnauthorizedException("X-API-Key header is required");
    }

    const hashSecret = process.env.API_KEY_HASH_SECRET;
    if (!hashSecret) {
      throw new Error("API_KEY_HASH_SECRET is required");
    }

    const keyHash = hashApiKey(rawKey, hashSecret);
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: { tenant: true },
    });

    if (!apiKey || !apiKey.active || apiKey.revokedAt || apiKey.tenant.status !== TenantStatus.ACTIVE) {
      throw new UnauthorizedException("Invalid or inactive API key");
    }

    request.principal = {
      tenantId: apiKey.tenantId,
      apiKeyId: apiKey.id,
      scopes: apiKey.scopes,
    };

    if (!apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS) {
      await this.prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      });
    }

    return true;
  }
}
