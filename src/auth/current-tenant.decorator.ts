import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { AuthenticatedRequest } from "./auth.types.js";

export const CurrentTenantId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  const tenantId = request.auth?.tenantId;

  if (!tenantId) {
    throw new UnauthorizedException("Authenticated tenant context is missing");
  }

  return tenantId;
});
