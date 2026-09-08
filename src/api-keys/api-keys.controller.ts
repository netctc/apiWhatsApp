import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { auditRequestContext } from "../audit/audit-request.util.js";
import { ApiKeysService } from "./api-keys.service.js";
import { CreateApiKeyDto } from "./dto/create-api-key.dto.js";

@ApiTags("api-keys")
@ApiSecurity("apiKey")
@Controller("v1/api-keys")
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
  @RequireScopes(ApiScope.API_KEYS_WRITE)
  create(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Req() request: Request,
    @Body() dto: CreateApiKeyDto,
  ) {
    return this.apiKeysService.create(principal, auditRequestContext(request), dto);
  }

  @Get()
  @RequireScopes(ApiScope.API_KEYS_READ)
  list(@CurrentPrincipal() principal: ApiPrincipal) {
    return this.apiKeysService.list(principal.tenantId);
  }

  @Post(":id/revoke")
  @RequireScopes(ApiScope.API_KEYS_WRITE)
  revoke(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Req() request: Request,
    @Param("id") id: string,
  ) {
    return this.apiKeysService.revoke(principal, auditRequestContext(request), id);
  }
}
