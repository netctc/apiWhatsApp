import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiScope, IS_PUBLIC_KEY, REQUIRED_SCOPES_KEY } from "./auth.constants.js";
import { ApiPrincipal } from "./auth.types.js";

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredScopes = this.reflector.getAllAndOverride<ApiScope[]>(REQUIRED_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [];

    if (requiredScopes.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ principal?: ApiPrincipal }>();
    if (!request.principal) {
      throw new UnauthorizedException("Authenticated principal is required");
    }

    const missingScopes = requiredScopes.filter((scope) => !request.principal?.scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new ForbiddenException(`Missing required API scopes: ${missingScopes.join(", ")}`);
    }

    return true;
  }
}
