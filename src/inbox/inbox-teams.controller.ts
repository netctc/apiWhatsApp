import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { auditRequestContext } from "../audit/audit-request.util.js";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { CreateInboxTeamDto } from "./dto/create-inbox-team.dto.js";
import { ListInboxTeamsQueryDto } from "./dto/list-inbox-teams-query.dto.js";
import { UpdateInboxTeamDto } from "./dto/update-inbox-team.dto.js";
import { InboxTeamsService } from "./inbox-teams.service.js";

const idPipe = new ParseUUIDPipe({ version: "4" });

@ApiTags("inbox")
@ApiSecurity("apiKey")
@Controller("v1/inbox/teams")
export class InboxTeamsController {
  constructor(private readonly teams: InboxTeamsService) {}

  @Post()
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Create a tenant inbox team" })
  createTeam(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Body() dto: CreateInboxTeamDto,
    @Req() request: Request,
  ) {
    return this.teams.createTeam(principal, dto, auditRequestContext(request));
  }

  @Get()
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "List tenant inbox teams" })
  listTeams(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Query() query: ListInboxTeamsQueryDto,
  ) {
    return this.teams.listTeams(principal.tenantId, query);
  }

  @Get(":id")
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "Get one tenant inbox team and its members" })
  findTeam(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
  ) {
    return this.teams.findTeam(principal.tenantId, id);
  }

  @Patch(":id")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Update or deactivate a tenant inbox team" })
  updateTeam(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Body() dto: UpdateInboxTeamDto,
    @Req() request: Request,
  ) {
    return this.teams.updateTeam(principal, id, dto, auditRequestContext(request));
  }

  @Put(":id/members/:agentId")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Add one active tenant inbox agent to a team" })
  addMember(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Param("agentId", idPipe) agentId: string,
    @Req() request: Request,
  ) {
    return this.teams.addMember(principal, id, agentId, auditRequestContext(request));
  }

  @Delete(":id/members/:agentId")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Remove one tenant inbox agent from a team" })
  removeMember(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Param("agentId", idPipe) agentId: string,
    @Req() request: Request,
  ) {
    return this.teams.removeMember(principal, id, agentId, auditRequestContext(request));
  }
}
