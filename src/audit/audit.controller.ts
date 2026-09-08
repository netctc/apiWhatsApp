import { Controller, Get, Query } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { AuditService } from "./audit.service.js";
import { ListAuditLogsQueryDto } from "./dto/list-audit-logs-query.dto.js";

@ApiTags("audit")
@ApiSecurity("apiKey")
@Controller("v1/audit-logs")
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequireScopes(ApiScope.AUDIT_READ)
  list(@CurrentPrincipal() principal: ApiPrincipal, @Query() query: ListAuditLogsQueryDto) {
    return this.auditService.list(principal.tenantId, query);
  }
}
