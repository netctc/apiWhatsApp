import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { ApiPrincipal } from "./auth.types.js";

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ApiPrincipal => {
    const request = context.switchToHttp().getRequest<{ principal?: ApiPrincipal }>();
    if (!request.principal) {
      throw new Error("Authenticated principal is not available");
    }
    return request.principal;
  },
);
