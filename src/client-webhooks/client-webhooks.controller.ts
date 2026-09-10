import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { auditRequestContext } from "../audit/audit-request.util.js";
import { ClientWebhooksService } from "./client-webhooks.service.js";
import { CreateClientWebhookDto } from "./dto/create-client-webhook.dto.js";
import { UpdateClientWebhookDto } from "./dto/update-client-webhook.dto.js";

const endpointIdPipe = new ParseUUIDPipe({ version: "4" });

@ApiTags("client-webhooks")
@ApiSecurity("apiKey")
@Controller("v1/client-webhooks")
export class ClientWebhooksController {
  constructor(private readonly clientWebhooks: ClientWebhooksService) {}

  @Post()
  @RequireScopes(ApiScope.CLIENT_WEBHOOKS_WRITE)
  @ApiOperation({ summary: "Create a tenant outbound webhook subscription and return its signing secret once" })
  create(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Body() dto: CreateClientWebhookDto,
    @Req() request: Request,
  ) {
    return this.clientWebhooks.create(principal, dto, auditRequestContext(request));
  }

  @Get()
  @RequireScopes(ApiScope.CLIENT_WEBHOOKS_READ)
  @ApiOperation({ summary: "List tenant outbound webhook subscriptions" })
  list(@CurrentPrincipal() principal: ApiPrincipal) {
    return this.clientWebhooks.list(principal.tenantId);
  }

  @Get(":id")
  @RequireScopes(ApiScope.CLIENT_WEBHOOKS_READ)
  @ApiOperation({ summary: "Get one tenant outbound webhook subscription" })
  findById(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", endpointIdPipe) id: string,
  ) {
    return this.clientWebhooks.findById(principal.tenantId, id);
  }

  @Patch(":id")
  @RequireScopes(ApiScope.CLIENT_WEBHOOKS_WRITE)
  @ApiOperation({ summary: "Update or deactivate a tenant outbound webhook subscription" })
  update(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", endpointIdPipe) id: string,
    @Body() dto: UpdateClientWebhookDto,
    @Req() request: Request,
  ) {
    return this.clientWebhooks.update(principal, id, dto, auditRequestContext(request));
  }

  @Post(":id/rotate-secret")
  @RequireScopes(ApiScope.CLIENT_WEBHOOKS_WRITE)
  @ApiOperation({ summary: "Rotate a tenant outbound webhook signing secret and return the new secret once" })
  rotateSecret(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", endpointIdPipe) id: string,
    @Req() request: Request,
  ) {
    return this.clientWebhooks.rotateSecret(principal, id, auditRequestContext(request));
  }
}
