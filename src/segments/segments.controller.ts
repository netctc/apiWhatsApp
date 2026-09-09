import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { CreateSegmentDto } from "./dto/create-segment.dto.js";
import { UpdateSegmentDto } from "./dto/update-segment.dto.js";
import { SegmentsService } from "./segments.service.js";

const segmentIdPipe = new ParseUUIDPipe({ version: "4" });

@ApiTags("segments")
@ApiSecurity("apiKey")
@Controller("v1/segments")
export class SegmentsController {
  constructor(private readonly segments: SegmentsService) {}

  @Post()
  @RequireScopes(ApiScope.SEGMENTS_WRITE)
  @ApiOperation({ summary: "Create a reusable tenant contact segment" })
  create(@CurrentPrincipal() principal: ApiPrincipal, @Body() dto: CreateSegmentDto) {
    return this.segments.create(principal.tenantId, dto);
  }

  @Get()
  @RequireScopes(ApiScope.SEGMENTS_READ)
  @ApiOperation({ summary: "List reusable tenant contact segments" })
  list(@CurrentPrincipal() principal: ApiPrincipal) {
    return this.segments.list(principal.tenantId);
  }

  @Get(":id/count")
  @RequireScopes(ApiScope.SEGMENTS_READ)
  @ApiOperation({ summary: "Count currently opted-in contacts matching a saved segment" })
  count(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", segmentIdPipe) id: string,
  ) {
    return this.segments.count(principal.tenantId, id);
  }

  @Get(":id")
  @RequireScopes(ApiScope.SEGMENTS_READ)
  @ApiOperation({ summary: "Get one reusable tenant contact segment" })
  findById(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", segmentIdPipe) id: string,
  ) {
    return this.segments.findById(principal.tenantId, id);
  }

  @Patch(":id")
  @RequireScopes(ApiScope.SEGMENTS_WRITE)
  @ApiOperation({ summary: "Update or deactivate a reusable tenant contact segment" })
  update(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", segmentIdPipe) id: string,
    @Body() dto: UpdateSegmentDto,
  ) {
    return this.segments.update(principal.tenantId, id, dto);
  }
}
