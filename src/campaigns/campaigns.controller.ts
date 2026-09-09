import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { CampaignAnalyticsService } from "./campaign-analytics.service.js";
import { CampaignsService } from "./campaigns.service.js";
import { CreateCampaignDto } from "./dto/create-campaign.dto.js";
import { ListCampaignRecipientsQueryDto } from "./dto/list-campaign-recipients-query.dto.js";
import { ListCampaignsQueryDto } from "./dto/list-campaigns-query.dto.js";

const campaignIdPipe = new ParseUUIDPipe({ version: "4" });

@ApiTags("campaigns")
@ApiSecurity("apiKey")
@Controller("v1/campaigns")
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly analytics: CampaignAnalyticsService,
  ) {}

  @Post()
  @RequireScopes(ApiScope.CAMPAIGNS_WRITE)
  @ApiOperation({ summary: "Create a draft marketing campaign with an explicit audience definition" })
  create(@CurrentPrincipal() principal: ApiPrincipal, @Body() dto: CreateCampaignDto) {
    return this.campaigns.create(principal.tenantId, dto);
  }

  @Get()
  @RequireScopes(ApiScope.CAMPAIGNS_READ)
  @ApiOperation({ summary: "List tenant campaigns" })
  list(@CurrentPrincipal() principal: ApiPrincipal, @Query() query: ListCampaignsQueryDto) {
    return this.campaigns.list(principal.tenantId, query);
  }

  @Get(":id/recipients")
  @RequireScopes(ApiScope.CAMPAIGNS_READ)
  @ApiOperation({ summary: "List the immutable recipient snapshot and processing results for a campaign" })
  listRecipients(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", campaignIdPipe) id: string,
    @Query() query: ListCampaignRecipientsQueryDto,
  ) {
    return this.campaigns.listRecipients(principal.tenantId, id, query);
  }

  @Get(":id/analytics")
  @RequireScopes(ApiScope.CAMPAIGNS_READ)
  @ApiOperation({ summary: "Get live campaign orchestration and WhatsApp delivery analytics" })
  analyticsForCampaign(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", campaignIdPipe) id: string,
  ) {
    return this.analytics.get(principal.tenantId, id);
  }

  @Get(":id")
  @RequireScopes(ApiScope.CAMPAIGNS_READ)
  @ApiOperation({ summary: "Get one tenant campaign" })
  findById(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", campaignIdPipe) id: string,
  ) {
    return this.campaigns.findById(principal.tenantId, id);
  }

  @Post(":id/launch")
  @HttpCode(HttpStatus.OK)
  @RequireScopes(ApiScope.CAMPAIGNS_WRITE)
  @ApiOperation({ summary: "Snapshot opted-in recipients and launch or schedule a draft campaign" })
  launch(@CurrentPrincipal() principal: ApiPrincipal, @Param("id", campaignIdPipe) id: string) {
    return this.campaigns.launch(principal.tenantId, id);
  }

  @Post(":id/pause")
  @HttpCode(HttpStatus.OK)
  @RequireScopes(ApiScope.CAMPAIGNS_WRITE)
  @ApiOperation({ summary: "Pause new recipient processing for a running or scheduled campaign" })
  pause(@CurrentPrincipal() principal: ApiPrincipal, @Param("id", campaignIdPipe) id: string) {
    return this.campaigns.pause(principal.tenantId, id);
  }

  @Post(":id/resume")
  @HttpCode(HttpStatus.OK)
  @RequireScopes(ApiScope.CAMPAIGNS_WRITE)
  @ApiOperation({ summary: "Resume a paused campaign" })
  resume(@CurrentPrincipal() principal: ApiPrincipal, @Param("id", campaignIdPipe) id: string) {
    return this.campaigns.resume(principal.tenantId, id);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @RequireScopes(ApiScope.CAMPAIGNS_WRITE)
  @ApiOperation({ summary: "Cancel unprocessed campaign recipients; in-flight sends may finish" })
  cancel(@CurrentPrincipal() principal: ApiPrincipal, @Param("id", campaignIdPipe) id: string) {
    return this.campaigns.cancel(principal.tenantId, id);
  }
}
