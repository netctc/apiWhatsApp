import { Controller, Get, Header, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { ConversationNotesService } from "./conversation-notes.service.js";
import { ConversationNotePageDto } from "./dto/conversation-note-page.dto.js";
import { ListConversationNotesQueryDto } from "./dto/list-conversation-notes-query.dto.js";

@ApiTags("inbox")
@ApiSecurity("apiKey")
@Controller("v1/inbox/conversations/:conversationId/notes")
export class ConversationNotesController {
  constructor(private readonly notes: ConversationNotesService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "List internal conversation notes, newest first" })
  @ApiParam({ name: "conversationId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ type: ConversationNotePageDto })
  @ApiBadRequestResponse({ description: "Invalid query or note cursor" })
  @ApiUnauthorizedResponse({ description: "Missing or invalid API key" })
  @ApiForbiddenResponse({ description: "API key lacks inbox:read" })
  @ApiNotFoundResponse({ description: "Conversation not found in the authenticated tenant" })
  list(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("conversationId", new ParseUUIDPipe({ version: "4" })) conversationId: string,
    @Query() query: ListConversationNotesQueryDto,
  ): Promise<ConversationNotePageDto> {
    return this.notes.list(principal.tenantId, conversationId, query);
  }
}
