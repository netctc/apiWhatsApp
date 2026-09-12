import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { auditLogData, changedFields, mutationActor } from "../audit/audit-write.util.js";
import type { AuditRequestContext } from "../audit/audit.types.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { ConversationStatus, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreateConversationNoteDto } from "./dto/create-conversation-note.dto.js";
import { CreateInboxAgentDto } from "./dto/create-inbox-agent.dto.js";
import { ListConversationMessagesQueryDto } from "./dto/list-conversation-messages-query.dto.js";
import { ListConversationsQueryDto } from "./dto/list-conversations-query.dto.js";
import { ListInboxAgentsQueryDto } from "./dto/list-inbox-agents-query.dto.js";
import { UpdateConversationDto } from "./dto/update-conversation.dto.js";
import { UpdateInboxAgentDto } from "./dto/update-inbox-agent.dto.js";
import {
  assertAgentHasConversationCapacity,
  lockActiveAgentCapacity,
  type LockedAgentCapacity,
} from "./inbox-capacity-admission.js";
import {
  assertAgentMeetsConversationSkills,
  filterAgentsByConversationSkills,
} from "./inbox-skill-admission.js";

const conversationSummaryInclude = {
  contact: {
    select: {
      id: true,
      phone: true,
      name: true,
      language: true,
      tags: true,
      consentStatus: true,
      serviceWindowExpiresAt: true,
    },
  },
  sender: {
    select: {
      id: true,
      providerPhoneNumberId: true,
      displayPhoneNumber: true,
      verifiedName: true,
    },
  },
  assignedAgent: {
    select: {
      id: true,
      externalId: true,
      name: true,
      email: true,
      active: true,
      maxConcurrentConversations: true,
    },
  },
  teamAssignment: {
    select: {
      teamId: true,
      createdAt: true,
      updatedAt: true,
      team: {
        select: {
          id: true,
          name: true,
          description: true,
          active: true,
        },
      },
    },
  },
  messages: {
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: 1,
    select: {
      id: true,
      direction: true,
      type: true,
      status: true,
      createdAt: true,
      providerTimestamp: true,
    },
  },
} satisfies Prisma.ConversationInclude;

@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  async createAgent(
    principal: ApiPrincipal,
    dto: CreateInboxAgentDto,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);
    const name = this.requiredText(dto.name, "Agent name");
    const externalId = this.optionalText(dto.externalId);
    const email = this.optionalText(dto.email)?.toLowerCase();

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const agent = await transaction.inboxAgent.create({
          data: {
            tenantId: actor.tenantId,
            name,
            externalId,
            email,
            ...(dto.maxConcurrentConversations === undefined
              ? {}
              : { maxConcurrentConversations: dto.maxConcurrentConversations }),
            ...(dto.metadata ? { metadata: this.toJson(dto.metadata) } : {}),
          },
        });

        const audit = auditLogData(actor, context, "inbox.agent.created", "InboxAgent", agent.id, {
          hasExternalId: !!externalId,
          hasEmail: !!email,
          hasMetadata: !!dto.metadata,
        });
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
        return agent;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("An inbox agent with that external ID already exists");
      }
      throw error;
    }
  }

  listAgents(tenantId: string, query: ListInboxAgentsQueryDto) {
    return this.prisma.inboxAgent.findMany({
      where: {
        tenantId,
        ...(query.active === undefined ? {} : { active: query.active }),
      },
      orderBy: [{ active: "desc" }, { name: "asc" }, { id: "asc" }],
    });
  }

  async updateAgent(
    principal: ApiPrincipal,
    id: string,
    dto: UpdateInboxAgentDto,
    context?: AuditRequestContext,
  ) {
    if (changedFields(dto as Record<string, unknown>).length === 0) {
      throw new BadRequestException("At least one agent field must be provided");
    }

    const actor = mutationActor(principal);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.inboxAgent.findFirst({
          where: { id, tenantId: actor.tenantId },
        });
        if (!existing) {
          throw new NotFoundException("Inbox agent not found");
        }

        const data: Prisma.InboxAgentUpdateInput = {
          ...(dto.name === undefined ? {} : { name: this.requiredText(dto.name, "Agent name") }),
          ...(dto.externalId === undefined ? {} : { externalId: this.requiredText(dto.externalId, "External ID") }),
          ...(dto.email === undefined ? {} : { email: this.requiredText(dto.email, "Email").toLowerCase() }),
          ...(dto.active === undefined ? {} : { active: dto.active }),
          ...(dto.maxConcurrentConversations === undefined
            ? {}
            : { maxConcurrentConversations: dto.maxConcurrentConversations }),
          ...(dto.metadata === undefined ? {} : { metadata: this.toJson(dto.metadata) }),
        };

        const agent = await transaction.inboxAgent.update({ where: { id }, data });
        const audit = auditLogData(actor, context, "inbox.agent.updated", "InboxAgent", id, {
          changedFields: changedFields(dto as Record<string, unknown>),
          active: agent.active,
        });
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
        return agent;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("An inbox agent with that external ID already exists");
      }
      throw error;
    }
  }

  async listConversations(tenantId: string, query: ListConversationsQueryDto) {
    if (query.unassigned && query.assignedAgentId) {
      throw new BadRequestException("assignedAgentId cannot be combined with unassigned=true");
    }
    if (query.unassignedTeam && query.assignedTeamId) {
      throw new BadRequestException("assignedTeamId cannot be combined with unassignedTeam=true");
    }

    if (query.cursor) {
      const cursor = await this.prisma.conversation.findFirst({
        where: { id: query.cursor, tenantId },
        select: { id: true },
      });
      if (!cursor) {
        throw new BadRequestException("Conversation cursor is invalid for this tenant");
      }
    }

    const where: Prisma.ConversationWhereInput = {
      tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.assignedAgentId ? { assignedAgentId: query.assignedAgentId } : {}),
      ...(query.unassigned ? { assignedAgentId: null } : {}),
      ...(query.assignedTeamId
        ? { teamAssignment: { is: { tenantId, teamId: query.assignedTeamId } } }
        : {}),
      ...(query.unassignedTeam ? { teamAssignment: { is: null } } : {}),
      ...(query.senderId ? { senderId: query.senderId } : {}),
      ...(query.contactId ? { contactId: query.contactId } : {}),
    };

    const rows = await this.prisma.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: conversationSummaryInclude,
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async findConversation(tenantId: string, id: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, tenantId },
      include: {
        ...conversationSummaryInclude,
        skillRequirements: {
          orderBy: [{ skill: { name: "asc" } }, { skillId: "asc" }],
          include: {
            skill: {
              select: {
                id: true,
                name: true,
                description: true,
                active: true,
              },
            },
          },
        },
        notes: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 100,
          include: {
            createdByApiKey: {
              select: { id: true, name: true, prefix: true },
            },
          },
        },
      },
    });
    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }
    return conversation;
  }

  async listMessages(tenantId: string, conversationId: string, query: ListConversationMessagesQueryDto) {
    await this.assertConversation(tenantId, conversationId);

    if (query.cursor) {
      const cursor = await this.prisma.message.findFirst({
        where: { id: query.cursor, tenantId, conversationId },
        select: { id: true },
      });
      if (!cursor) {
        throw new BadRequestException("Message cursor is invalid for this conversation");
      }
    }

    const rows = await this.prisma.message.findMany({
      where: { tenantId, conversationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        statusEvents: { orderBy: { createdAt: "asc" } },
      },
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async updateConversation(
    principal: ApiPrincipal,
    id: string,
    dto: UpdateConversationDto,
    context?: AuditRequestContext,
  ) {
    if (changedFields(dto as Record<string, unknown>).length === 0) {
      throw new BadRequestException("At least one conversation field must be provided");
    }

    const actor = mutationActor(principal);
    return this.prisma.$transaction(async (transaction) => {
      await this.lockConversation(transaction, actor.tenantId, id);
      const existing = await transaction.conversation.findFirst({
        where: { id, tenantId: actor.tenantId },
        include: {
          teamAssignment: {
            select: { teamId: true },
          },
        },
      });
      if (!existing) {
        throw new NotFoundException("Conversation not found");
      }

      let assignedAgentCapacity: LockedAgentCapacity | null = null;
      if (dto.assignedAgentId) {
        assignedAgentCapacity = await lockActiveAgentCapacity(
          transaction,
          actor.tenantId,
          dto.assignedAgentId,
          "Assigned inbox agent is not active in this tenant",
        );
      }

      if (dto.assignedTeamId) {
        const team = await transaction.inboxTeam.findFirst({
          where: { id: dto.assignedTeamId, tenantId: actor.tenantId, active: true },
          select: { id: true },
        });
        if (!team) {
          throw new UnprocessableEntityException("Assigned inbox team is not active in this tenant");
        }
      }

      const assignmentChanged = dto.assignedAgentId !== undefined || dto.assignedTeamId !== undefined;
      const finalAgentId = dto.assignedAgentId === undefined
        ? existing.assignedAgentId
        : dto.assignedAgentId;
      const finalTeamId = dto.assignedTeamId === undefined
        ? existing.teamAssignment?.teamId ?? null
        : dto.assignedTeamId;
      const newAgentAdmission = dto.assignedAgentId !== undefined
        && finalAgentId !== null
        && finalAgentId !== existing.assignedAgentId;
      if (assignmentChanged && finalAgentId && finalTeamId) {
        await this.assertAgentTeamMembership(
          transaction,
          actor.tenantId,
          finalTeamId,
          finalAgentId,
          "Assigned inbox agent is not a member of the assigned team",
        );
      }
      if (dto.assignedAgentId !== undefined && finalAgentId) {
        await assertAgentMeetsConversationSkills(
          transaction,
          actor.tenantId,
          id,
          finalAgentId,
          "Assigned inbox agent does not satisfy conversation skill requirements",
        );
      }
      if (newAgentAdmission && assignedAgentCapacity) {
        await assertAgentHasConversationCapacity(
          transaction,
          actor.tenantId,
          assignedAgentCapacity,
          "Assigned inbox agent has no remaining conversation capacity",
        );
      }

      if (dto.assignedTeamId !== undefined) {
        if (dto.assignedTeamId === null) {
          await transaction.conversationTeamAssignment.deleteMany({
            where: { tenantId: actor.tenantId, conversationId: id },
          });
        } else {
          await transaction.conversationTeamAssignment.upsert({
            where: { conversationId: id },
            create: {
              tenantId: actor.tenantId,
              conversationId: id,
              teamId: dto.assignedTeamId,
            },
            update: { teamId: dto.assignedTeamId },
          });
        }
      }

      const updated = await transaction.conversation.update({
        where: { id },
        data: {
          ...(dto.status === undefined
            ? {}
            : {
                status: dto.status,
                resolvedAt: dto.status === ConversationStatus.RESOLVED ? new Date() : null,
              }),
          ...(dto.priority === undefined ? {} : { priority: dto.priority }),
          ...(dto.assignedAgentId === undefined ? {} : { assignedAgentId: dto.assignedAgentId }),
        },
        include: conversationSummaryInclude,
      });

      const audit = auditLogData(actor, context, "inbox.conversation.updated", "Conversation", id, {
        changedFields: changedFields(dto as Record<string, unknown>),
        status: updated.status,
        priority: updated.priority,
        assigned: !!updated.assignedAgentId,
        teamAssigned: updated.teamAssignment !== null,
      });
      if (audit) {
        await transaction.auditLog.create({ data: audit });
      }
      return updated;
    });
  }

  async claimConversation(
    principal: ApiPrincipal,
    id: string,
    agentId: string,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);
    return this.prisma.$transaction(async (transaction) => {
      await this.lockConversation(transaction, actor.tenantId, id);
      const existing = await transaction.conversation.findFirst({
        where: { id, tenantId: actor.tenantId },
        include: {
          teamAssignment: {
            select: { teamId: true },
          },
        },
      });
      if (!existing) {
        throw new NotFoundException("Conversation not found");
      }

      const agentCapacity = await lockActiveAgentCapacity(
        transaction,
        actor.tenantId,
        agentId,
        "Inbox agent is not active in this tenant",
      );

      if (existing.assignedAgentId === agentId) {
        const conversation = await transaction.conversation.findFirstOrThrow({
          where: { id, tenantId: actor.tenantId },
          include: conversationSummaryInclude,
        });
        return { conversation, changed: false };
      }
      if (existing.assignedAgentId) {
        throw new ConflictException("Conversation is already assigned to another inbox agent");
      }

      const assignedTeamId = existing.teamAssignment?.teamId;
      if (assignedTeamId) {
        await this.assertAgentTeamMembership(
          transaction,
          actor.tenantId,
          assignedTeamId,
          agentId,
          "Inbox agent is not a member of the assigned team",
        );
      }
      await assertAgentMeetsConversationSkills(
        transaction,
        actor.tenantId,
        id,
        agentId,
        "Inbox agent does not satisfy conversation skill requirements",
      );
      await assertAgentHasConversationCapacity(
        transaction,
        actor.tenantId,
        agentCapacity,
        "Inbox agent has no remaining conversation capacity",
      );

      const conversation = await transaction.conversation.update({
        where: { id },
        data: { assignedAgentId: agentId },
        include: conversationSummaryInclude,
      });
      const audit = auditLogData(actor, context, "inbox.conversation.claimed", "Conversation", id, {
        assigned: true,
      });
      if (audit) {
        await transaction.auditLog.create({ data: audit });
      }
      return { conversation, changed: true };
    });
  }

  async routeConversation(
    principal: ApiPrincipal,
    id: string,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);
    return this.prisma.$transaction(async (transaction) => {
      await this.lockConversation(transaction, actor.tenantId, id);
      const existing = await transaction.conversation.findFirst({
        where: { id, tenantId: actor.tenantId },
        include: {
          teamAssignment: {
            select: { teamId: true },
          },
        },
      });
      if (!existing) {
        throw new NotFoundException("Conversation not found");
      }

      if (existing.assignedAgentId) {
        const conversation = await transaction.conversation.findFirstOrThrow({
          where: { id, tenantId: actor.tenantId },
          include: conversationSummaryInclude,
        });
        return { conversation, changed: false };
      }

      const teamId = existing.teamAssignment?.teamId;
      if (!teamId) {
        throw new UnprocessableEntityException(
          "Conversation must be assigned to an inbox team before automatic routing",
        );
      }

      const lockedTeam = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "InboxTeam"
        WHERE "id" = ${teamId}::uuid
          AND "tenantId" = ${actor.tenantId}::uuid
          AND "active" = TRUE
        FOR UPDATE
      `);
      if (lockedTeam.length === 0) {
        throw new UnprocessableEntityException("Assigned inbox team is not active in this tenant");
      }

      const candidates = await transaction.$queryRaw<Array<{
        agentId: string;
        maxConcurrentConversations: number | null;
      }>>(Prisma.sql`
        SELECT membership."agentId", agent."maxConcurrentConversations"
        FROM "InboxTeamMember" AS membership
        INNER JOIN "InboxAgent" AS agent
          ON agent."id" = membership."agentId"
          AND agent."tenantId" = membership."tenantId"
        WHERE membership."tenantId" = ${actor.tenantId}::uuid
          AND membership."teamId" = ${teamId}::uuid
          AND agent."active" = TRUE
        ORDER BY membership."agentId" ASC
        FOR UPDATE OF membership, agent
      `);
      if (candidates.length === 0) {
        throw new UnprocessableEntityException("Assigned inbox team has no active routing members");
      }

      const skillEligible = await filterAgentsByConversationSkills(
        transaction,
        actor.tenantId,
        id,
        candidates.map((candidate) => candidate.agentId),
      );
      const candidateIds = skillEligible.agentIds;
      if (candidateIds.length === 0) {
        throw new UnprocessableEntityException(
          "Assigned inbox team has no active members satisfying required skills",
        );
      }

      const groupedLoads = await transaction.conversation.groupBy({
        by: ["assignedAgentId"],
        where: {
          tenantId: actor.tenantId,
          assignedAgentId: { in: candidateIds },
          status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
        },
        _count: { _all: true },
      });
      const loadByAgent = new Map<string, number>();
      for (const row of groupedLoads) {
        if (row.assignedAgentId) {
          loadByAgent.set(row.assignedAgentId, row._count._all);
        }
      }

      const capacityByAgent = new Map(
        candidates.map((candidate) => [candidate.agentId, candidate.maxConcurrentConversations ?? null]),
      );
      const capacityEligibleIds = candidateIds.filter((candidateId) => {
        const limit = capacityByAgent.get(candidateId) ?? null;
        return limit === null || (loadByAgent.get(candidateId) ?? 0) < limit;
      });
      if (capacityEligibleIds.length === 0) {
        throw new UnprocessableEntityException(
          "Assigned inbox team has no routing members with remaining conversation capacity",
        );
      }

      let selectedAgentId = capacityEligibleIds[0];
      let selectedLoad = loadByAgent.get(selectedAgentId) ?? 0;
      for (const candidateId of capacityEligibleIds.slice(1)) {
        const load = loadByAgent.get(candidateId) ?? 0;
        if (load < selectedLoad) {
          selectedAgentId = candidateId;
          selectedLoad = load;
        }
      }

      const conversation = await transaction.conversation.update({
        where: { id },
        data: { assignedAgentId: selectedAgentId },
        include: conversationSummaryInclude,
      });
      const audit = auditLogData(actor, context, "inbox.conversation.routed", "Conversation", id, {
        strategy: "least_open_pending",
        eligibleAgents: capacityEligibleIds.length,
        capacityLimitedAgents: candidateIds.length - capacityEligibleIds.length,
        requiredSkills: skillEligible.requiredSkills,
        selectedLoad,
        assigned: true,
      });
      if (audit) {
        await transaction.auditLog.create({ data: audit });
      }
      return { conversation, changed: true };
    });
  }

  async releaseConversation(
    principal: ApiPrincipal,
    id: string,
    agentId: string,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);
    return this.prisma.$transaction(async (transaction) => {
      await this.lockConversation(transaction, actor.tenantId, id);
      const existing = await transaction.conversation.findFirst({
        where: { id, tenantId: actor.tenantId },
      });
      if (!existing) {
        throw new NotFoundException("Conversation not found");
      }

      const agent = await transaction.inboxAgent.findFirst({
        where: { id: agentId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!agent) {
        throw new UnprocessableEntityException("Inbox agent is not in this tenant");
      }

      if (existing.assignedAgentId === null) {
        const conversation = await transaction.conversation.findFirstOrThrow({
          where: { id, tenantId: actor.tenantId },
          include: conversationSummaryInclude,
        });
        return { conversation, changed: false };
      }
      if (existing.assignedAgentId !== agentId) {
        throw new ConflictException("Conversation is assigned to another inbox agent");
      }

      const conversation = await transaction.conversation.update({
        where: { id },
        data: { assignedAgentId: null },
        include: conversationSummaryInclude,
      });
      const audit = auditLogData(actor, context, "inbox.conversation.released", "Conversation", id, {
        assigned: false,
      });
      if (audit) {
        await transaction.auditLog.create({ data: audit });
      }
      return { conversation, changed: true };
    });
  }

  async markRead(principal: ApiPrincipal, id: string) {
    return this.prisma.$transaction(async (transaction) => {
      await this.lockConversation(transaction, principal.tenantId, id);
      const existing = await transaction.conversation.findFirst({
        where: { id, tenantId: principal.tenantId },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException("Conversation not found");
      }
      return transaction.conversation.update({
        where: { id },
        data: { unreadCount: 0 },
        include: conversationSummaryInclude,
      });
    });
  }

  async addNote(principal: ApiPrincipal, id: string, dto: CreateConversationNoteDto) {
    const body = this.requiredText(dto.body, "Note");
    return this.prisma.$transaction(async (transaction) => {
      const conversation = await transaction.conversation.findFirst({
        where: { id, tenantId: principal.tenantId },
        select: { id: true },
      });
      if (!conversation) {
        throw new NotFoundException("Conversation not found");
      }
      return transaction.conversationNote.create({
        data: {
          tenantId: principal.tenantId,
          conversationId: id,
          createdByApiKeyId: principal.apiKeyId,
          body,
        },
        include: {
          createdByApiKey: {
            select: { id: true, name: true, prefix: true },
          },
        },
      });
    });
  }

  private async assertConversation(tenantId: string, id: string): Promise<void> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }
  }

  private async lockConversation(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<void> {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "Conversation"
      WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid
      FOR UPDATE
    `);
  }

  private async assertAgentTeamMembership(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    teamId: string,
    agentId: string,
    message: string,
  ): Promise<void> {
    const membership = await transaction.inboxTeamMember.findFirst({
      where: { tenantId, teamId, agentId },
      select: { teamId: true },
    });
    if (!membership) {
      throw new UnprocessableEntityException(message);
    }
  }

  private requiredText(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException(`${label} cannot be blank`);
    }
    return normalized;
  }

  private optionalText(value?: string): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    const normalized = value.trim();
    return normalized || undefined;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
