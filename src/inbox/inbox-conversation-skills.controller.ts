import { Body, Controller, Delete, Param, ParseUUIDPipe, Put, Req } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { auditRequestContext } from "../audit/audit-request.util.js";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { SetConversationSkillRequirementDto } from "./dto/set-conversation-skill-requirement.dto.js";
import { InboxConversationSkillsService } from "./inbox-conversation-skills.service.js";

const idPipe = new ParseUUIDPipe({ version: "4" });

@ApiTags("inbox")
@ApiSecurity("apiKey")
@Controller("v1/inbox/conversations/:conversationId/skills")
export class InboxConversationSkillsController {
  constructor(private readonly skills: InboxConversationSkillsService) {}

  @Put(":skillId")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Create or update a conversation skill requirement" })
  setRequirement(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("conversationId", idPipe) conversationId: string,
    @Param("skillId", idPipe) skillId: string,
    @Body() dto: SetConversationSkillRequirementDto,
    @Req() request: Request,
  ) {
    return this.skills.setRequirement(
      principal,
      conversationId,
      skillId,
      dto,
      auditRequestContext(request),
    );
  }

  @Delete(":skillId")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Remove a conversation skill requirement" })
  removeRequirement(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("conversationId", idPipe) conversationId: string,
    @Param("skillId", idPipe) skillId: string,
    @Req() request: Request,
  ) {
    return this.skills.removeRequirement(
      principal,
      conversationId,
      skillId,
      auditRequestContext(request),
    );
  }
}
