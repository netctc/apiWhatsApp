import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { auditRequestContext } from "../audit/audit-request.util.js";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import type { ConversationPriority, ConversationStatus } from "../generated/prisma/client.js";
import { InboxRealtimeService } from "../inbox-events/inbox-realtime.service.js";
import { ConversationAgentActionDto } from "./dto/conversation-agent-action.dto.js";
import { CreateConversationNoteDto } from "./dto/create-conversation-note.dto.js";
import { CreateInboxAgentDto } from "./dto/create-inbox-agent.dto.js";
import { ListConversationMessagesQueryDto } from "./dto/list-conversation-messages-query.dto.js";
import { ListConversationsQueryDto } from "./dto/list-conversations-query.dto.js";
import { ListInboxAgentsQueryDto } from "./dto/list-inbox-agents-query.dto.js";
import { UpdateConversationDto } from "./dto/update-conversation.dto.js";
import { UpdateInboxAgentDto } from "./dto/update-inbox-agent.dto.js";
import { InboxService } from "./inbox.service.js";

const idPipe = new ParseUUIDPipe({ version: "4" });

@ApiTags("inbox")
@ApiSecurity("apiKey")
@Controller("v1/inbox")
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly realtime: InboxRealtimeService,
  ) {}

  @Post("agents")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Create a tenant inbox agent" })
  createAgent(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Body() dto: CreateInboxAgentDto,
    @Req() request: Request,
  ) {
    return this.inbox.createAgent(principal, dto, auditRequestContext(request));
  }

  @Get("agents")
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "List tenant inbox agents" })
  listAgents(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Query() query: ListInboxAgentsQueryDto,
  ) {
    return this.inbox.listAgents(principal.tenantId, query);
  }

  @Patch("agents/:id")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Update or deactivate a tenant inbox agent" })
  updateAgent(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Body() dto: UpdateInboxAgentDto,
    @Req() request: Request,
  ) {
    return this.inbox.updateAgent(principal, id, dto, auditRequestContext(request));
  }

  @Get("conversations")
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "List tenant inbox conversations" })
  listConversations(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Query() query: ListConversationsQueryDto,
  ) {
    return this.inbox.listConversations(principal.tenantId, query);
  }

  @Get("conversations/:id/messages")
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "List messages linked to an inbox conversation" })
  listMessages(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Query() query: ListConversationMessagesQueryDto,
  ) {
    return this.inbox.listMessages(principal.tenantId, id, query);
  }

  @Get("conversations/:id")
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiOperation({ summary: "Get one inbox conversation with recent internal notes" })
  findConversation(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
  ) {
    return this.inbox.findConversation(principal.tenantId, id);
  }

  @Patch("conversations/:id")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Update conversation status, priority, or assignment" })
  async updateConversation(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Body() dto: UpdateConversationDto,
    @Req() request: Request,
  ) {
    const updated = await this.inbox.updateConversation(principal, id, dto, auditRequestContext(request));
    await this.publishConversationUpdated(principal.tenantId, updated);
    return updated;
  }

  @Post("conversations/:id/claim")
  @HttpCode(HttpStatus.OK)
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Claim an unassigned conversation for one active tenant inbox agent" })
  async claimConversation(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Body() dto: ConversationAgentActionDto,
    @Req() request: Request,
  ) {
    const result = await this.inbox.claimConversation(
      principal,
      id,
      dto.agentId,
      auditRequestContext(request),
    );
    if (result.changed) {
      await this.publishConversationUpdated(principal.tenantId, result.conversation);
    }
    return result.conversation;
  }

  @Post("conversations/:id/release")
  @HttpCode(HttpStatus.OK)
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Release a conversation only when held by the requested tenant inbox agent" })
  async releaseConversation(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Body() dto: ConversationAgentActionDto,
    @Req() request: Request,
  ) {
    const result = await this.inbox.releaseConversation(
      principal,
      id,
      dto.agentId,
      auditRequestContext(request),
    );
    if (result.changed) {
      await this.publishConversationUpdated(principal.tenantId, result.conversation);
    }
    return result.conversation;
  }

  @Post("conversations/:id/read")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Mark a conversation as read" })
  async markRead(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
  ) {
    const updated = await this.inbox.markRead(principal, id);
    await this.publishConversationUpdated(principal.tenantId, updated);
    return updated;
  }

  @Post("conversations/:id/notes")
  @RequireScopes(ApiScope.INBOX_WRITE)
  @ApiOperation({ summary: "Add an internal note to a conversation" })
  async addNote(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id", idPipe) id: string,
    @Body() dto: CreateConversationNoteDto,
  ) {
    const note = await this.inbox.addNote(principal, id, dto);
    await this.realtime.publish(principal.tenantId, "conversation.note.created", {
      conversationId: id,
      noteId: note.id,
    });
    return note;
  }

  private publishConversationUpdated(
    tenantId: string,
    conversation: {
      id: string;
      status: ConversationStatus;
      priority: ConversationPriority;
      assignedAgentId: string | null;
      unreadCount: number;
    },
  ) {
    return this.realtime.publish(tenantId, "conversation.updated", {
      conversationId: conversation.id,
      status: conversation.status,
      priority: conversation.priority,
      assignedAgentId: conversation.assignedAgentId,
      unreadCount: conversation.unreadCount,
    });
  }
}
