import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthenticatedRequest } from "./auth.types.js";
import { REQUIRED_SCOPES_METADATA } from "./require-scopes.decorator.js";

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredScopes =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (requiredScopes.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const granted = request.auth?.scopes ?? [];

    if (granted.includes("*") || requiredScopes.every((scope) => granted.includes(scope))) {
      return true;
    }

    throw new ForbiddenException("API key does not have the required scope");
  }
}
