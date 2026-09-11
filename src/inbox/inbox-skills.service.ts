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
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreateInboxSkillDto } from "./dto/create-inbox-skill.dto.js";
import { ListInboxSkillsQueryDto } from "./dto/list-inbox-skills-query.dto.js";
import { SetInboxAgentSkillDto } from "./dto/set-inbox-agent-skill.dto.js";
import { UpdateInboxSkillDto } from "./dto/update-inbox-skill.dto.js";

@Injectable()
export class InboxSkillsService {
  constructor(private readonly prisma: PrismaService) {}

  async createSkill(
    principal: ApiPrincipal,
    dto: CreateInboxSkillDto,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);
    const name = this.requiredText(dto.name, "Skill name");
    const description = this.optionalText(dto.description);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const skill = await transaction.inboxSkill.create({
          data: {
            tenantId: actor.tenantId,
            name,
            description,
          },
        });
        const audit = auditLogData(actor, context, "inbox.skill.created", "InboxSkill", skill.id, {
          hasDescription: description !== null,
        });
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
        return skill;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("An inbox skill with that name already exists");
      }
      throw error;
    }
  }

  listSkills(tenantId: string, query: ListInboxSkillsQueryDto) {
    return this.prisma.inboxSkill.findMany({
      where: {
        tenantId,
        ...(query.active === undefined ? {} : { active: query.active }),
      },
      orderBy: [{ active: "desc" }, { name: "asc" }, { id: "asc" }],
    });
  }

  async findSkill(tenantId: string, id: string) {
    const skill = await this.prisma.inboxSkill.findFirst({
      where: { id, tenantId },
      include: {
        assignments: {
          orderBy: [{ level: "desc" }, { createdAt: "asc" }, { agentId: "asc" }],
          include: {
            agent: {
              select: {
                id: true,
                externalId: true,
                name: true,
                email: true,
                active: true,
              },
            },
          },
        },
      },
    });
    if (!skill) {
      throw new NotFoundException("Inbox skill not found");
    }
    return skill;
  }

  async updateSkill(
    principal: ApiPrincipal,
    id: string,
    dto: UpdateInboxSkillDto,
    context?: AuditRequestContext,
  ) {
    if (changedFields(dto as Record<string, unknown>).length === 0) {
      throw new BadRequestException("At least one skill field must be provided");
    }

    const actor = mutationActor(principal);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.inboxSkill.findFirst({
          where: { id, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!existing) {
          throw new NotFoundException("Inbox skill not found");
        }

        const data: Prisma.InboxSkillUpdateInput = {
          ...(dto.name === undefined ? {} : { name: this.requiredText(dto.name, "Skill name") }),
          ...(dto.description === undefined
            ? {}
            : { description: this.optionalText(dto.description) }),
          ...(dto.active === undefined ? {} : { active: dto.active }),
        };
        const skill = await transaction.inboxSkill.update({ where: { id }, data });
        const audit = auditLogData(actor, context, "inbox.skill.updated", "InboxSkill", id, {
          changedFields: changedFields(dto as Record<string, unknown>),
          active: skill.active,
        });
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
        return skill;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("An inbox skill with that name already exists");
      }
      throw error;
    }
  }

  async setAgentSkill(
    principal: ApiPrincipal,
    skillId: string,
    agentId: string,
    dto: SetInboxAgentSkillDto,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);

    await this.prisma.$transaction(async (transaction) => {
      const skill = await transaction.inboxSkill.findFirst({
        where: { id: skillId, tenantId: actor.tenantId },
        select: { id: true, active: true },
      });
      if (!skill) {
        throw new NotFoundException("Inbox skill not found");
      }

      const agent = await transaction.inboxAgent.findFirst({
        where: { id: agentId, tenantId: actor.tenantId },
        select: { id: true, active: true },
      });
      if (!agent) {
        throw new UnprocessableEntityException("Inbox agent is not in this tenant");
      }

      const existing = await transaction.inboxAgentSkill.findUnique({
        where: { skillId_agentId: { skillId, agentId } },
      });
      if (existing) {
        if (existing.level === dto.level) {
          return;
        }
        await transaction.inboxAgentSkill.update({
          where: { skillId_agentId: { skillId, agentId } },
          data: { level: dto.level },
        });
        const audit = auditLogData(
          actor,
          context,
          "inbox.skill.agent.level.updated",
          "InboxAgentSkill",
          `${skillId}:${agentId}`,
          { fromLevel: existing.level, toLevel: dto.level },
        );
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
        return;
      }

      if (!skill.active) {
        throw new UnprocessableEntityException("Inbox skill must be active for a new assignment");
      }
      if (!agent.active) {
        throw new UnprocessableEntityException("Inbox agent must be active for a new skill assignment");
      }

      const inserted = await transaction.inboxAgentSkill.createMany({
        data: [{ tenantId: actor.tenantId, skillId, agentId, level: dto.level }],
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        const audit = auditLogData(
          actor,
          context,
          "inbox.skill.agent.assigned",
          "InboxAgentSkill",
          `${skillId}:${agentId}`,
          { level: dto.level },
        );
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
        return;
      }

      const changed = await transaction.inboxAgentSkill.updateMany({
        where: {
          tenantId: actor.tenantId,
          skillId,
          agentId,
          level: { not: dto.level },
        },
        data: { level: dto.level },
      });
      if (changed.count === 1) {
        const audit = auditLogData(
          actor,
          context,
          "inbox.skill.agent.level.updated",
          "InboxAgentSkill",
          `${skillId}:${agentId}`,
          { toLevel: dto.level },
        );
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
      }
    });

    return this.findSkill(actor.tenantId, skillId);
  }

  async removeAgentSkill(
    principal: ApiPrincipal,
    skillId: string,
    agentId: string,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);

    await this.prisma.$transaction(async (transaction) => {
      const skill = await transaction.inboxSkill.findFirst({
        where: { id: skillId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!skill) {
        throw new NotFoundException("Inbox skill not found");
      }

      const removed = await transaction.inboxAgentSkill.deleteMany({
        where: { tenantId: actor.tenantId, skillId, agentId },
      });
      if (removed.count === 0) {
        return;
      }

      const audit = auditLogData(
        actor,
        context,
        "inbox.skill.agent.removed",
        "InboxAgentSkill",
        `${skillId}:${agentId}`,
      );
      if (audit) {
        await transaction.auditLog.create({ data: audit });
      }
    });

    return this.findSkill(actor.tenantId, skillId);
  }

  private requiredText(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException(`${label} cannot be blank`);
    }
    return normalized;
  }

  private optionalText(value?: string): string | null {
    if (value === undefined) {
      return null;
    }
    const normalized = value.trim();
    return normalized || null;
  }
}
