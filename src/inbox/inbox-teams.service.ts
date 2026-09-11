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
import { CreateInboxTeamDto } from "./dto/create-inbox-team.dto.js";
import { ListInboxTeamsQueryDto } from "./dto/list-inbox-teams-query.dto.js";
import { UpdateInboxTeamDto } from "./dto/update-inbox-team.dto.js";

@Injectable()
export class InboxTeamsService {
  constructor(private readonly prisma: PrismaService) {}

  async createTeam(
    principal: ApiPrincipal,
    dto: CreateInboxTeamDto,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);
    const name = this.requiredText(dto.name, "Team name");
    const description = this.optionalText(dto.description);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const team = await transaction.inboxTeam.create({
          data: {
            tenantId: actor.tenantId,
            name,
            description,
          },
        });
        const audit = auditLogData(actor, context, "inbox.team.created", "InboxTeam", team.id, {
          hasDescription: description !== null,
        });
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
        return team;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("An inbox team with that name already exists");
      }
      throw error;
    }
  }

  listTeams(tenantId: string, query: ListInboxTeamsQueryDto) {
    return this.prisma.inboxTeam.findMany({
      where: {
        tenantId,
        ...(query.active === undefined ? {} : { active: query.active }),
      },
      orderBy: [{ active: "desc" }, { name: "asc" }, { id: "asc" }],
    });
  }

  async findTeam(tenantId: string, id: string) {
    const team = await this.prisma.inboxTeam.findFirst({
      where: { id, tenantId },
    });
    if (!team) {
      throw new NotFoundException("Inbox team not found");
    }

    const memberships = await this.prisma.inboxTeamMember.findMany({
      where: { tenantId, teamId: id },
      orderBy: [{ createdAt: "asc" }, { agentId: "asc" }],
    });
    const agents = memberships.length
      ? await this.prisma.inboxAgent.findMany({
          where: {
            tenantId,
            id: { in: memberships.map((membership) => membership.agentId) },
          },
          select: {
            id: true,
            externalId: true,
            name: true,
            email: true,
            active: true,
          },
        })
      : [];
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

    return {
      ...team,
      members: memberships.flatMap((membership) => {
        const agent = agentsById.get(membership.agentId);
        return agent
          ? [
              {
                agentId: membership.agentId,
                createdAt: membership.createdAt,
                agent,
              },
            ]
          : [];
      }),
    };
  }

  async updateTeam(
    principal: ApiPrincipal,
    id: string,
    dto: UpdateInboxTeamDto,
    context?: AuditRequestContext,
  ) {
    if (changedFields(dto as Record<string, unknown>).length === 0) {
      throw new BadRequestException("At least one team field must be provided");
    }

    const actor = mutationActor(principal);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.inboxTeam.findFirst({
          where: { id, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!existing) {
          throw new NotFoundException("Inbox team not found");
        }

        const data: Prisma.InboxTeamUpdateInput = {
          ...(dto.name === undefined ? {} : { name: this.requiredText(dto.name, "Team name") }),
          ...(dto.description === undefined
            ? {}
            : { description: this.optionalText(dto.description) }),
          ...(dto.active === undefined ? {} : { active: dto.active }),
        };
        const team = await transaction.inboxTeam.update({ where: { id }, data });
        const audit = auditLogData(actor, context, "inbox.team.updated", "InboxTeam", id, {
          changedFields: changedFields(dto as Record<string, unknown>),
          active: team.active,
        });
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
        return team;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("An inbox team with that name already exists");
      }
      throw error;
    }
  }

  async addMember(
    principal: ApiPrincipal,
    teamId: string,
    agentId: string,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);
    await this.prisma.$transaction(async (transaction) => {
      const team = await transaction.inboxTeam.findFirst({
        where: { id: teamId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!team) {
        throw new NotFoundException("Inbox team not found");
      }

      const agent = await transaction.inboxAgent.findFirst({
        where: { id: agentId, tenantId: actor.tenantId },
        select: { id: true, active: true },
      });
      if (!agent) {
        throw new UnprocessableEntityException("Inbox agent is not in this tenant");
      }
      if (!agent.active) {
        throw new UnprocessableEntityException("Inbox agent must be active to join a team");
      }

      const inserted = await transaction.inboxTeamMember.createMany({
        data: [{ tenantId: actor.tenantId, teamId, agentId }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        return;
      }

      const audit = auditLogData(
        actor,
        context,
        "inbox.team.member.added",
        "InboxTeamMember",
        `${teamId}:${agentId}`,
      );
      if (audit) {
        await transaction.auditLog.create({ data: audit });
      }
    });

    return this.findTeam(actor.tenantId, teamId);
  }

  async removeMember(
    principal: ApiPrincipal,
    teamId: string,
    agentId: string,
    context?: AuditRequestContext,
  ) {
    const actor = mutationActor(principal);
    await this.prisma.$transaction(async (transaction) => {
      const team = await transaction.inboxTeam.findFirst({
        where: { id: teamId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!team) {
        throw new NotFoundException("Inbox team not found");
      }

      const removed = await transaction.inboxTeamMember.deleteMany({
        where: { tenantId: actor.tenantId, teamId, agentId },
      });
      if (removed.count === 0) {
        return;
      }

      const audit = auditLogData(
        actor,
        context,
        "inbox.team.member.removed",
        "InboxTeamMember",
        `${teamId}:${agentId}`,
      );
      if (audit) {
        await transaction.auditLog.create({ data: audit });
      }
    });

    return this.findTeam(actor.tenantId, teamId);
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
