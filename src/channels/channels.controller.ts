import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiKeyGuard } from "../auth/api-key.guard.js";
import { CurrentTenantId } from "../auth/current-tenant.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { ScopesGuard } from "../auth/scopes.guard.js";
import { ChannelsService } from "./channels.service.js";

@ApiTags("channels")
@ApiBearerAuth("api-key")
@UseGuards(ApiKeyGuard, ScopesGuard)
@Controller("v1/channels")
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @RequireScopes("channels:read")
  @ApiOperation({ summary: "List WhatsApp channels owned by the authenticated tenant" })
  findAll(@CurrentTenantId() tenantId: string) {
    return this.channels.findAll(tenantId);
  }
}
