import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { MetaTemplateClient } from "../meta/meta-template.client.js";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ListTemplatesQueryDto } from "./dto/list-templates-query.dto.js";
import { SyncTemplatesDto } from "./dto/sync-templates.dto.js";

export interface ProviderTemplateStatusUpdate {
  providerTemplateId: string;
  name: string;
  language: string;
  status: string;
  rejectionReason?: string;
  raw: Record<string, unknown>;
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metaTemplates: MetaTemplateClient,
  ) {}

  async sync(tenantId: string, dto: SyncTemplatesDto) {
    const remote = await this.metaTemplates.listTemplates(tenantId, dto.senderId);
    const providerTemplateIds = remote.templates.map((template) => template.id);

    if (providerTemplateIds.length > 0) {
      const collision = await this.prisma.messageTemplate.findFirst({
        where: {
          providerTemplateId: { in: providerTemplateIds },
          tenantId: { not: tenantId },
        },
        select: { providerTemplateId: true },
      });
      if (collision) {
        throw new ConflictException(
          `Meta template ${collision.providerTemplateId} is already associated with another tenant`,
        );
      }
    }

    const syncedAt = new Date();
    const markedDeleted = await this.prisma.$transaction(async (transaction) => {
      for (const template of remote.templates) {
        const data = {
          providerTemplateId: template.id,
          category: template.category ?? null,
          status: template.status.toUpperCase(),
          components: template.components ? this.toJson(template.components) : undefined,
          qualityScore:
            template.qualityScore !== undefined ? this.toJson(template.qualityScore) : undefined,
          rejectionReason: template.rejectionReason ?? null,
          providerPayload: this.toJson(template.raw),
          lastSyncedAt: syncedAt,
        };

        await transaction.messageTemplate.upsert({
          where: {
            tenantId_wabaId_name_language: {
              tenantId,
              wabaId: remote.wabaId,
              name: template.name,
              language: template.language,
            },
          },
          update: data,
          create: {
            tenantId,
            wabaId: remote.wabaId,
            name: template.name,
            language: template.language,
            ...data,
          },
        });
      }

      return transaction.messageTemplate.updateMany({
        where: {
          tenantId,
          wabaId: remote.wabaId,
          status: { not: "DELETED" },
          ...(providerTemplateIds.length > 0
            ? { providerTemplateId: { notIn: providerTemplateIds } }
            : {}),
        },
        data: {
          status: "DELETED",
          lastSyncedAt: syncedAt,
        },
      });
    });

    return {
      wabaId: remote.wabaId,
      senderId: remote.senderId,
      synced: remote.templates.length,
      markedDeleted: markedDeleted.count,
      syncedAt,
    };
  }

  async list(tenantId: string, query: ListTemplatesQueryDto) {
    if (query.cursor) {
      const cursorTemplate = await this.prisma.messageTemplate.findFirst({
        where: { id: query.cursor, tenantId },
        select: { id: true },
      });
      if (!cursorTemplate) {
        throw new BadRequestException("Template cursor is invalid for this tenant");
      }
    }

    const rows = await this.prisma.messageTemplate.findMany({
      where: {
        tenantId,
        ...(query.wabaId ? { wabaId: query.wabaId } : {}),
        ...(query.status ? { status: query.status.toUpperCase() } : {}),
        ...(query.category ? { category: query.category.toUpperCase() } : {}),
        ...(query.language ? { language: query.language } : {}),
        ...(query.name ? { name: { contains: query.name, mode: "insensitive" } } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async findById(tenantId: string, id: string) {
    const template = await this.prisma.messageTemplate.findFirst({
      where: { id, tenantId },
    });
    if (!template) {
      throw new NotFoundException("Message template not found");
    }
    return template;
  }

  async assertApproved(tenantId: string, wabaId: string, payload: unknown) {
    const templateIdentity = this.extractTemplateIdentity(payload);
    const template = await this.prisma.messageTemplate.findFirst({
      where: {
        tenantId,
        wabaId,
        name: templateIdentity.name,
        language: templateIdentity.language,
        status: "APPROVED",
      },
    });

    if (!template) {
      throw new UnprocessableEntityException(
        `Template ${templateIdentity.name}/${templateIdentity.language} is not synced and APPROVED for WABA ${wabaId}`,
      );
    }
    return template;
  }

  async applyProviderStatusUpdate(
    tenantId: string,
    wabaId: string,
    update: ProviderTemplateStatusUpdate,
  ) {
    const status = update.status.toUpperCase();
    const existingByProvider = await this.prisma.messageTemplate.findUnique({
      where: { providerTemplateId: update.providerTemplateId },
    });

    if (existingByProvider) {
      if (existingByProvider.tenantId !== tenantId || existingByProvider.wabaId !== wabaId) {
        throw new ConflictException(
          `Meta template ${update.providerTemplateId} is associated with a different tenant or WABA`,
        );
      }
      return this.prisma.messageTemplate.update({
        where: { id: existingByProvider.id },
        data: {
          name: update.name,
          language: update.language,
          status,
          rejectionReason: update.rejectionReason ?? null,
          providerPayload: this.toJson(update.raw),
          lastSyncedAt: new Date(),
        },
      });
    }

    return this.prisma.messageTemplate.upsert({
      where: {
        tenantId_wabaId_name_language: {
          tenantId,
          wabaId,
          name: update.name,
          language: update.language,
        },
      },
      update: {
        providerTemplateId: update.providerTemplateId,
        status,
        rejectionReason: update.rejectionReason ?? null,
        providerPayload: this.toJson(update.raw),
        lastSyncedAt: new Date(),
      },
      create: {
        tenantId,
        wabaId,
        providerTemplateId: update.providerTemplateId,
        name: update.name,
        language: update.language,
        status,
        rejectionReason: update.rejectionReason ?? null,
        providerPayload: this.toJson(update.raw),
        lastSyncedAt: new Date(),
      },
    });
  }

  private extractTemplateIdentity(payload: unknown): { name: string; language: string } {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new UnprocessableEntityException("Template message payload must be an object");
    }
    const value = payload as { name?: unknown; language?: unknown };
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      throw new UnprocessableEntityException("Template message payload requires a non-empty name");
    }
    if (typeof value.language !== "string" || value.language.trim().length === 0) {
      throw new UnprocessableEntityException("Template message payload requires a non-empty language");
    }
    return { name: value.name.trim(), language: value.language.trim() };
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
