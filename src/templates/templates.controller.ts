import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { ListTemplatesQueryDto } from "./dto/list-templates-query.dto.js";
import { SyncTemplatesDto } from "./dto/sync-templates.dto.js";
import { TemplatesService } from "./templates.service.js";

@ApiTags("templates")
@ApiSecurity("apiKey")
@Controller("v1/templates")
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Post("sync")
  @RequireScopes(ApiScope.TEMPLATES_WRITE)
  @ApiOperation({ summary: "Synchronize message templates from the WABA behind a tenant sender" })
  sync(@CurrentPrincipal() principal: ApiPrincipal, @Body() dto: SyncTemplatesDto) {
    return this.templates.sync(principal.tenantId, dto);
  }

  @Get()
  @RequireScopes(ApiScope.TEMPLATES_READ)
  @ApiOperation({ summary: "List tenant message templates" })
  list(@CurrentPrincipal() principal: ApiPrincipal, @Query() query: ListTemplatesQueryDto) {
    return this.templates.list(principal.tenantId, query);
  }

  @Get(":id")
  @RequireScopes(ApiScope.TEMPLATES_READ)
  @ApiOperation({ summary: "Get one tenant message template" })
  findById(@CurrentPrincipal() principal: ApiPrincipal, @Param("id") id: string) {
    return this.templates.findById(principal.tenantId, id);
  }
}
