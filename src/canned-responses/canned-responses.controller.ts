import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { auditRequestContext } from "../audit/audit-request.util.js";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { CannedResponsesService } from "./canned-responses.service.js";
import { CreateCannedResponseDto, ListCannedResponsesQueryDto, UpdateCannedResponseDto } from "./dto/canned-response-input.dto.js";
import { CannedResponseDto, CannedResponsePageDto } from "./dto/canned-response.dto.js";

@ApiTags("inbox")
@ApiSecurity("apiKey")
@ApiUnauthorizedResponse({ description: "Missing or rejected API key" })
@ApiForbiddenResponse({ description: "Required inbox scope is missing" })
@ApiBadRequestResponse({ description: "Invalid input or cursor" })
@Controller("v1/inbox/canned-responses")
export class CannedResponsesController {
  constructor(private readonly responses: CannedResponsesService) {}

  @Post()
  @Header("Cache-Control", "private, no-store")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Create a reusable plain-text inbox response; does not send a message" })
  @ApiCreatedResponse({ type: CannedResponseDto })
  @ApiConflictResponse({ description: "Shortcut is already reserved in this tenant" })
  create(@CurrentPrincipal() principal: ApiPrincipal, @Body() dto: CreateCannedResponseDto, @Req() request: Request) {
    return this.responses.create(principal, dto, auditRequestContext(request));
  }

  @Get()
  @Header("Cache-Control", "private, no-store")
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "List reusable responses, newest first; active by default" })
  @ApiOkResponse({ type: CannedResponsePageDto })
  list(@CurrentPrincipal() principal: ApiPrincipal, @Query() query: ListCannedResponsesQueryDto) {
    return this.responses.list(principal.tenantId, query);
  }

  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "Read one active or inactive tenant response" })
  @ApiOkResponse({ type: CannedResponseDto })
  @ApiNotFoundResponse({ description: "Response not found in this tenant" })
  find(@CurrentPrincipal() principal: ApiPrincipal, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    return this.responses.find(principal.tenantId, id);
  }

  @Patch(":id")
  @Header("Cache-Control", "private, no-store")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Update or deactivate a response using its last-read revision" })
  @ApiOkResponse({ type: CannedResponseDto })
  @ApiNotFoundResponse({ description: "Response not found in this tenant" })
  @ApiConflictResponse({ description: "Stale revision or duplicate tenant shortcut" })
  update(@CurrentPrincipal() principal: ApiPrincipal, @Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @Body() dto: UpdateCannedResponseDto, @Req() request: Request) {
    return this.responses.update(principal, id, dto, auditRequestContext(request));
  }
}
