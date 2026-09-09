import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { AuditRequestContext } from "../audit/audit.types.js";
import { auditLogData, changedFields, mutationActor } from "../audit/audit-write.util.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreateSegmentDto } from "./dto/create-segment.dto.js";
import { UpdateSegmentDto } from "./dto/update-segment.dto.js";
import {
  normalizeSegmentDefinition,
  readPersistedSegmentDefinition,
  segmentContactWhere,
  SegmentDefinitionError,
} from "./segment-definition.util.js";

@Injectable()
export class SegmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    tenantOrPrincipal: string | ApiPrincipal,
    dto: CreateSegmentDto,
    auditContext?: AuditRequestContext,
  ) {
    const actor = mutationActor(tenantOrPrincipal);
    const tenantId = actor.tenantId;
    const name = this.normalizeName(dto.name);
    await this.assertNameAvailable(tenantId, name);
    const definition = this.normalizeDefinition(dto.definition);

    return this.prisma.$transaction(async (transaction) => {
      const created = await transaction.contactSegment.create({
        data: {
          tenantId,
          name,
          description: dto.description?.trim() || undefined,
          definition: this.toJson(definition),
        },
      });

      const audit = auditLogData(
        actor,
        auditContext,
        "contact_segment.created",
        "ContactSegment",
        created.id,
        {
          name: created.name,
          active: created.active,
          criteria: this.definitionSummary(definition),
        },
      );
      if (audit) {
        await transaction.auditLog.create({ data: audit });
      }

      return created;
    });
  }

  async list(tenantId: string) {
    return this.prisma.contactSegment.findMany({
      where: { tenantId },
      orderBy: [{ active: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
      take: 200,
    });
  }

  async findById(tenantId: string, id: string) {
    const segment = await this.prisma.contactSegment.findFirst({
      where: { id, tenantId },
    });
    if (!segment) {
      throw new NotFoundException("Contact segment not found");
    }
    return segment;
  }

  async update(
    tenantOrPrincipal: string | ApiPrincipal,
    id: string,
    dto: UpdateSegmentDto,
    auditContext?: AuditRequestContext,
  ) {
    const actor = mutationActor(tenantOrPrincipal);
    const tenantId = actor.tenantId;
    const existing = await this.findById(tenantId, id);
    const name = dto.name === undefined ? existing.name : this.normalizeName(dto.name);
    if (name !== existing.name) {
      await this.assertNameAvailable(tenantId, name, id);
    }

    const definition =
      dto.definition === undefined ? undefined : this.normalizeDefinition(dto.definition);

    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.contactSegment.update({
        where: { id },
        data: {
          name,
          ...(dto.description !== undefined
            ? { description: dto.description.trim() || null }
            : {}),
          ...(definition ? { definition: this.toJson(definition) } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      });

      const effectiveDefinition = definition ?? this.readDefinition(updated.definition);
      const audit = auditLogData(
        actor,
        auditContext,
        "contact_segment.updated",
        "ContactSegment",
        updated.id,
        {
          name: updated.name,
          changedFields: changedFields(dto as Record<string, unknown>),
          active: updated.active,
          definitionChanged: dto.definition !== undefined,
          criteria: this.definitionSummary(effectiveDefinition),
        },
      );
      if (audit) {
        await transaction.auditLog.create({ data: audit });
      }

      return updated;
    });
  }

  async count(tenantId: string, id: string) {
    const segment = await this.findById(tenantId, id);
    const definition = this.readDefinition(segment.definition);
    const count = await this.prisma.contact.count({
      where: segmentContactWhere(tenantId, definition),
    });

    return {
      segmentId: segment.id,
      active: segment.active,
      count,
      evaluatedAt: new Date(),
    };
  }

  async resolveActiveForCampaign(tenantId: string, id: string) {
    const segment = await this.prisma.contactSegment.findFirst({
      where: { id, tenantId, active: true },
    });
    if (!segment) {
      throw new UnprocessableEntityException("Campaign contact segment was not found or is inactive");
    }

    return {
      id: segment.id,
      name: segment.name,
      updatedAt: segment.updatedAt,
      definition: this.readDefinition(segment.definition),
    };
  }

  private normalizeName(value: string): string {
    const name = value.trim();
    if (!name) {
      throw new BadRequestException("Segment name must contain non-whitespace characters");
    }
    return name;
  }

  private normalizeDefinition(input: Parameters<typeof normalizeSegmentDefinition>[0]) {
    try {
      return normalizeSegmentDefinition(input);
    } catch (error) {
      if (error instanceof SegmentDefinitionError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private readDefinition(value: Prisma.JsonValue) {
    try {
      return readPersistedSegmentDefinition(value);
    } catch (error) {
      if (error instanceof SegmentDefinitionError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }

  private async assertNameAvailable(tenantId: string, name: string, excludingId?: string) {
    const existing = await this.prisma.contactSegment.findFirst({
      where: {
        tenantId,
        name,
        ...(excludingId ? { id: { not: excludingId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException("A contact segment with this name already exists for the tenant");
    }
  }

  private definitionSummary(definition: {
    language?: string;
    tagsAny?: string[];
    tagsAll?: string[];
  }) {
    return {
      languageConfigured: !!definition.language,
      tagsAnyCount: definition.tagsAny?.length ?? 0,
      tagsAllCount: definition.tagsAll?.length ?? 0,
    };
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
