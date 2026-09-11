import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { auditRequestContext } from "../audit/audit-request.util.js";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { CreateInboxSkillDto } from "./dto/create-inbox-skill.dto.js";
import { ListInboxSkillsQueryDto } from "./dto/list-inbox-skills-query.dto.js";
import { SetInboxAgentSkillDto } from "./dto/set-inbox-agent-skill.dto.js";
import { UpdateInboxSkillDto } from "./dto/update-inbox-skill.dto.js";
import { InboxSkillsService } from "./inbox-skills.service.js";

const idPipe = new ParseUUIDPipe({ version: "4" });

@ApiTags("inbox")
@ApiSecurity("apiKey")
@Controller("v1/inbox/skills")
export class InboxSkillsController {
  constructor(private readonly skills: InboxSkillsService) {}

  @Post()
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Create a tenant inbox skill" })
  createSkill(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Body() dto: CreateInboxSkillDto,
    @Req() request: Request,
  ) {
    return this.skills.createSkill(principal, dto, auditRequestContext(request));
  }

  @Get()
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "List tenant inbox skills" })
  listSkills(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Query() query: ListInboxSkillsQueryDto,
  ) {
    return this.skills.listSkills(principal.tenantId, query);
  }

  @Get(":id")
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "Get one tenant inbox skill and agent proficiencies" })
  findSkill(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
  ) {
    return this.skills.findSkill(principal.tenantId, id);
  }

  @Patch(":id")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Update or deactivate a tenant inbox skill" })
  updateSkill(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Body() dto: UpdateInboxSkillDto,
    @Req() request: Request,
  ) {
    return this.skills.updateSkill(principal, id, dto, auditRequestContext(request));
  }

  @Put(":id/agents/:agentId")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Assign or update one tenant agent skill proficiency" })
  setAgentSkill(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Param("agentId", idPipe) agentId: string,
    @Body() dto: SetInboxAgentSkillDto,
    @Req() request: Request,
  ) {
    return this.skills.setAgentSkill(principal, id, agentId, dto, auditRequestContext(request));
  }

  @Delete(":id/agents/:agentId")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Remove one tenant agent skill proficiency" })
  removeAgentSkill(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Param("agentId", idPipe) agentId: string,
    @Req() request: Request,
  ) {
    return this.skills.removeAgentSkill(principal, id, agentId, auditRequestContext(request));
  }
}
