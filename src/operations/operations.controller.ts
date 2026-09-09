import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { OperationsService, type OperationsSnapshot } from "./operations.service.js";

@ApiTags("operations")
@ApiSecurity("apiKey")
@Controller("v1/operations")
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get("snapshot")
  @RequireScopes(ApiScope.OPERATIONS_READ)
  @ApiOperation({ summary: "Get tenant-scoped operational backlog and status counters" })
  snapshot(@CurrentPrincipal() principal: ApiPrincipal): Promise<OperationsSnapshot> {
    return this.operations.snapshot(principal.tenantId);
  }
}
