import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ApiKeysService } from "./api-keys.service.js";
import type { AuthenticatedRequest } from "./auth.types.js";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawKey = this.extractApiKey(request);

    if (!rawKey) {
      throw new UnauthorizedException("API key is required");
    }

    const auth = await this.apiKeys.authenticate(rawKey);
    if (!auth) {
      throw new UnauthorizedException("Invalid or inactive API key");
    }

    request.auth = auth;
    return true;
  }

  private extractApiKey(request: AuthenticatedRequest): string | undefined {
    const authorization = request.headers.authorization;
    const bearer = this.extractBearerToken(authorization);
    const apiKeyHeader = request.headers["x-api-key"];
    const headerKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;

    if (bearer && headerKey && bearer !== headerKey) {
      throw new UnauthorizedException("Conflicting API credentials");
    }

    return bearer ?? (headerKey?.trim() || undefined);
  }

  private extractBearerToken(authorization?: string): string | undefined {
    if (!authorization) {
      return undefined;
    }

    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return match?.[1]?.trim() || undefined;
  }
}
