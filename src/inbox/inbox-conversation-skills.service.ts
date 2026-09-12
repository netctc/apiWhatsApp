import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { auditLogData, mutationActor } from "../audit/audit-write.util.js";
import type { AuditRequestContext } from "../audit/audit.types.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { SetConversationSkillRequirementDto } from "./dto/set-conversation-skill-requirement.dto.js";

@Injectable()
export class InboxConversationSkillsService {
  constructor(private readonly prisma: PrismaService) {}

  async setRequirement(
    principal: ApiPrincipal,
    conversationId: string,
    skillId: string,
    dto: SetConversationSkillRequirementDto,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);
    await this.prisma.$transaction(async (transaction) => {
      await this.lockConversation(transaction, actor.tenantId, conversationId);
      const conversation = await transaction.conversation.findFirst({
        where: { id: conversationId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!conversation) {
        throw new NotFoundException("Conversation not found");
      }

      const skill = await transaction.inboxSkill.findFirst({
        where: { id: skillId, tenantId: actor.tenantId },
        select: { id: true, active: true },
      });
      if (!skill) {
        throw new NotFoundException("Inbox skill not found");
      }

      const existing = await transaction.conversationSkillRequirement.findUnique({
        where: { conversationId_skillId: { conversationId, skillId } },
      });
      if (existing) {
        if (existing.minLevel === dto.minLevel) return;
        await transaction.conversationSkillRequirement.update({
          where: { conversationId_skillId: { conversationId, skillId } },
          data: { minLevel: dto.minLevel },
        });
        const audit = auditLogData(
          actor,
          context,
          "inbox.conversation.skill.level.updated",
          "ConversationSkillRequirement",
          `${conversationId}:${skillId}`,
          { fromLevel: existing.minLevel, toLevel: dto.minLevel },
        );
        if (audit) await transaction.auditLog.create({ data: audit });
        return;
      }

      if (!skill.active) {
        throw new UnprocessableEntityException("Inbox skill must be active for a new conversation requirement");
      }

      await transaction.conversationSkillRequirement.create({
        data: {
          tenantId: actor.tenantId,
          conversationId,
          skillId,
          minLevel: dto.minLevel,
        },
      });
      const audit = auditLogData(
        actor,
        context,
        "inbox.conversation.skill.required",
        "ConversationSkillRequirement",
        `${conversationId}:${skillId}`,
        { minLevel: dto.minLevel },
      );
      if (audit) await transaction.auditLog.create({ data: audit });
    });

    return this.listRequirements(actor.tenantId, conversationId);
  }

  async removeRequirement(
    principal: ApiPrincipal,
    conversationId: string,
    skillId: string,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);
    await this.prisma.$transaction(async (transaction) => {
      await this.lockConversation(transaction, actor.tenantId, conversationId);
      const conversation = await transaction.conversation.findFirst({
        where: { id: conversationId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!conversation) {
        throw new NotFoundException("Conversation not found");
      }

      const removed = await transaction.conversationSkillRequirement.deleteMany({
        where: { tenantId: actor.tenantId, conversationId, skillId },
      });
      if (removed.count === 0) return;

      const audit = auditLogData(
        actor,
        context,
        "inbox.conversation.skill.removed",
        "ConversationSkillRequirement",
        `${conversationId}:${skillId}`,
      );
      if (audit) await transaction.auditLog.create({ data: audit });
    });

    return this.listRequirements(actor.tenantId, conversationId);
  }

  listRequirements(tenantId: string, conversationId: string) {
    return this.prisma.conversationSkillRequirement.findMany({
      where: { tenantId, conversationId },
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
    });
  }

  private async lockConversation(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "Conversation"
      WHERE "id" = ${conversationId}::uuid AND "tenantId" = ${tenantId}::uuid
      FOR UPDATE
    `);
  }
}
