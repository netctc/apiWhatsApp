import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  CampaignRecipientStatus,
  CampaignStatus,
  ConsentStatus,
  Prisma,
} from "../generated/prisma/client.js";
import { PhoneNumbersService } from "../phone-numbers/phone-numbers.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { SegmentsService } from "../segments/segments.service.js";
import { TemplatesService } from "../templates/templates.service.js";
import {
  CampaignPersonalizationTemplateError,
  validateCampaignComponents,
} from "./campaign-personalization.util.js";
import type { CampaignAudienceDto } from "./dto/campaign-audience.dto.js";
import { CreateCampaignDto } from "./dto/create-campaign.dto.js";
import { ListCampaignRecipientsQueryDto } from "./dto/list-campaign-recipients-query.dto.js";
import { ListCampaignsQueryDto } from "./dto/list-campaigns-query.dto.js";

interface NormalizedCampaignAudience {
  allOptedIn: boolean;
  contactIds?: string[];
  segmentId?: string;
  segmentName?: string;
  segmentUpdatedAt?: string;
  language?: string;
  tagsAny?: string[];
  tagsAll?: string[];
}

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly phoneNumbers: PhoneNumbersService,
    private readonly templates: TemplatesService,
    private readonly segments: SegmentsService,
  ) {}

  async create(tenantId: string, dto: CreateCampaignDto) {
    const personalizationEnabled = dto.personalizationEnabled === true;
    const audience = await this.normalizeAudience(tenantId, dto.audience);
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException("Campaign name must contain non-whitespace characters");
    }

    if (personalizationEnabled && dto.components) {
      this.assertComponentsValid(dto.components);
    }

    const sender = await this.phoneNumbers.resolveForTenant(tenantId, dto.senderId);
    if (!sender.wabaId) {
      throw new UnprocessableEntityException("The selected WhatsApp sender is missing its WABA ID");
    }

    const template = await this.templates.findById(tenantId, dto.templateId);
    this.assertMarketingTemplate(template, sender.wabaId);

    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException("scheduledAt must be a valid ISO date-time");
    }

    return this.prisma.campaign.create({
      data: {
        tenantId,
        senderId: sender.id,
        templateId: template.id,
        name,
        audience: this.toJson(audience),
        components: dto.components ? this.toJson(dto.components) : undefined,
        personalizationEnabled,
        scheduledAt,
      },
      include: this.campaignInclude(),
    });
  }

  async list(tenantId: string, query: ListCampaignsQueryDto) {
    if (query.cursor) {
      const cursor = await this.prisma.campaign.findFirst({
        where: { id: query.cursor, tenantId },
        select: { id: true },
      });
      if (!cursor) {
        throw new BadRequestException("Campaign cursor is invalid for this tenant");
      }
    }

    const rows = await this.prisma.campaign.findMany({
      where: {
        tenantId,
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: this.campaignInclude(),
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async findById(tenantId: string, id: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, tenantId },
      include: this.campaignInclude(),
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }
    return campaign;
  }

  async listRecipients(
    tenantId: string,
    campaignId: string,
    query: ListCampaignRecipientsQueryDto,
  ) {
    await this.findById(tenantId, campaignId);

    if (query.cursor) {
      const cursor = await this.prisma.campaignRecipient.findFirst({
        where: { id: query.cursor, campaignId, campaign: { tenantId } },
        select: { id: true },
      });
      if (!cursor) {
        throw new BadRequestException("Campaign recipient cursor is invalid for this campaign");
      }
    }

    const rows = await this.prisma.campaignRecipient.findMany({
      where: {
        campaignId,
        campaign: { tenantId },
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        contact: {
          select: {
            id: true,
            phone: true,
            name: true,
            language: true,
            timezone: true,
            tags: true,
            consentStatus: true,
          },
        },
        message: {
          select: {
            id: true,
            status: true,
            trafficClass: true,
            providerMessageId: true,
          },
        },
      },
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async launch(tenantId: string, id: string) {
    const maxRecipients = this.maxRecipients();

    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "Campaign"
          WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid
          FOR UPDATE
        `);

        const campaign = await transaction.campaign.findFirst({
          where: { id, tenantId },
          include: {
            sender: true,
            template: true,
          },
        });
        if (!campaign) {
          throw new NotFoundException("Campaign not found");
        }

        if (
          campaign.snapshotAt &&
          (campaign.status === CampaignStatus.SCHEDULED ||
            campaign.status === CampaignStatus.RUNNING ||
            campaign.status === CampaignStatus.COMPLETED)
        ) {
          return campaign;
        }
        if (campaign.status !== CampaignStatus.DRAFT) {
          throw new ConflictException(`Campaign in ${campaign.status} state cannot be launched`);
        }

        if (!campaign.sender.active || !campaign.sender.wabaId) {
          throw new UnprocessableEntityException("Campaign sender is inactive or missing its WABA ID");
        }
        this.assertMarketingTemplate(campaign.template, campaign.sender.wabaId);

        const audience = this.readAudience(campaign.audience);
        const tagFilter = this.tagFilter(audience);
        const contactIds = await transaction.contact.findMany({
          where: {
            tenantId,
            consentStatus: ConsentStatus.OPTED_IN,
            ...(audience.language ? { language: audience.language } : {}),
            ...(audience.contactIds ? { id: { in: audience.contactIds } } : {}),
            ...(tagFilter ? { tags: tagFilter } : {}),
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take: maxRecipients + 1,
        });

        if (contactIds.length > maxRecipients) {
          throw new BadRequestException(
            `Campaign audience exceeds CAMPAIGN_MAX_RECIPIENTS (${maxRecipients})`,
          );
        }

        for (let offset = 0; offset < contactIds.length; offset += 1000) {
          const batch = contactIds.slice(offset, offset + 1000);
          await transaction.campaignRecipient.createMany({
            data: batch.map((contact) => ({ campaignId: campaign.id, contactId: contact.id })),
            skipDuplicates: true,
          });
        }

        const now = new Date();
        const shouldSchedule = !!campaign.scheduledAt && campaign.scheduledAt.getTime() > now.getTime();
        const status =
          contactIds.length === 0
            ? CampaignStatus.COMPLETED
            : shouldSchedule
              ? CampaignStatus.SCHEDULED
              : CampaignStatus.RUNNING;

        return transaction.campaign.update({
          where: { id: campaign.id },
          data: {
            status,
            snapshotAt: now,
            totalRecipients: contactIds.length,
            ...(status === CampaignStatus.RUNNING ? { startedAt: now } : {}),
            ...(status === CampaignStatus.COMPLETED ? { completedAt: now } : {}),
          },
          include: this.campaignInclude(),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async pause(tenantId: string, id: string) {
    const result = await this.prisma.campaign.updateMany({
      where: {
        id,
        tenantId,
        status: { in: [CampaignStatus.RUNNING, CampaignStatus.SCHEDULED] },
      },
      data: { status: CampaignStatus.PAUSED },
    });

    if (result.count === 0) {
      const campaign = await this.findById(tenantId, id);
      if (campaign.status === CampaignStatus.PAUSED) {
        return campaign;
      }
      throw new ConflictException(`Campaign in ${campaign.status} state cannot be paused`);
    }

    return this.findById(tenantId, id);
  }

  async resume(tenantId: string, id: string) {
    const campaign = await this.findById(tenantId, id);
    if (campaign.status !== CampaignStatus.PAUSED) {
      throw new ConflictException(`Campaign in ${campaign.status} state cannot be resumed`);
    }

    const now = new Date();
    const status =
      campaign.scheduledAt && campaign.scheduledAt.getTime() > now.getTime()
        ? CampaignStatus.SCHEDULED
        : CampaignStatus.RUNNING;

    const result = await this.prisma.campaign.updateMany({
      where: { id, tenantId, status: CampaignStatus.PAUSED },
      data: {
        status,
        ...(status === CampaignStatus.RUNNING && !campaign.startedAt ? { startedAt: now } : {}),
      },
    });

    if (result.count === 0) {
      const current = await this.findById(tenantId, id);
      throw new ConflictException(`Campaign in ${current.status} state cannot be resumed`);
    }

    return this.findById(tenantId, id);
  }

  async cancel(tenantId: string, id: string) {
    const existing = await this.findById(tenantId, id);
    if (existing.status === CampaignStatus.CANCELLED) {
      return existing;
    }
    if (existing.status === CampaignStatus.COMPLETED || existing.status === CampaignStatus.FAILED) {
      throw new ConflictException(`Campaign in ${existing.status} state cannot be cancelled`);
    }

    const cancelledAt = new Date();
    const transitioned = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.campaign.updateMany({
        where: {
          id,
          tenantId,
          status: {
            in: [
              CampaignStatus.DRAFT,
              CampaignStatus.SCHEDULED,
              CampaignStatus.RUNNING,
              CampaignStatus.PAUSED,
            ],
          },
        },
        data: {
          status: CampaignStatus.CANCELLED,
          cancelledAt,
        },
      });

      if (result.count === 0) {
        return false;
      }

      await transaction.campaignRecipient.updateMany({
        where: { campaignId: id, status: CampaignRecipientStatus.PENDING },
        data: {
          status: CampaignRecipientStatus.CANCELLED,
          processingLeaseUntil: null,
          lastError: "Campaign cancelled before recipient processing",
        },
      });
      return true;
    });

    if (!transitioned) {
      const current = await this.findById(tenantId, id);
      if (current.status === CampaignStatus.CANCELLED) {
        return current;
      }
      throw new ConflictException(`Campaign in ${current.status} state cannot be cancelled`);
    }

    await this.refreshStats(id);
    return this.findById(tenantId, id);
  }

  async refreshStats(campaignId: string): Promise<void> {
    const grouped = await this.prisma.campaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId },
      _count: { _all: true },
    });
    const counts = new Map(grouped.map((row) => [row.status, row._count._all]));
    const pending = counts.get(CampaignRecipientStatus.PENDING) ?? 0;
    const processing = counts.get(CampaignRecipientStatus.PROCESSING) ?? 0;

    const updated = await this.prisma.campaign.updateMany({
      where: { id: campaignId },
      data: {
        queuedRecipients: counts.get(CampaignRecipientStatus.QUEUED) ?? 0,
        skippedRecipients: counts.get(CampaignRecipientStatus.SKIPPED) ?? 0,
        failedRecipients: counts.get(CampaignRecipientStatus.FAILED) ?? 0,
        cancelledRecipients: counts.get(CampaignRecipientStatus.CANCELLED) ?? 0,
      },
    });
    if (updated.count === 0) {
      return;
    }

    if (pending === 0 && processing === 0) {
      await this.prisma.campaign.updateMany({
        where: { id: campaignId, status: CampaignStatus.RUNNING },
        data: { status: CampaignStatus.COMPLETED, completedAt: new Date() },
      });
    }
  }

  async failCampaign(campaignId: string, reason: string): Promise<boolean> {
    const failureReason = reason.slice(0, 2000);
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.campaign.updateMany({
        where: {
          id: campaignId,
          status: { in: [CampaignStatus.RUNNING, CampaignStatus.SCHEDULED] },
        },
        data: {
          status: CampaignStatus.FAILED,
          failureReason,
        },
      });

      if (result.count === 0) {
        return false;
      }

      await transaction.campaignRecipient.updateMany({
        where: { campaignId, status: CampaignRecipientStatus.PENDING },
        data: {
          status: CampaignRecipientStatus.FAILED,
          processingLeaseUntil: null,
          lastError: failureReason,
        },
      });
      return true;
    });
  }

  private async normalizeAudience(
    tenantId: string,
    audience?: CampaignAudienceDto,
  ): Promise<NormalizedCampaignAudience> {
    const allOptedIn = audience?.allOptedIn === true;
    const contactIds = audience?.contactIds?.filter(Boolean) ?? [];
    const hasExplicitContacts = contactIds.length > 0;
    const hasSegment = typeof audience?.segmentId === "string" && audience.segmentId.length > 0;
    const modeCount = Number(allOptedIn) + Number(hasExplicitContacts) + Number(hasSegment);

    if (modeCount !== 1) {
      throw new BadRequestException(
        "Campaign audience must specify exactly one of allOptedIn=true, a non-empty contactIds list, or segmentId",
      );
    }

    const language = audience?.language?.trim();
    const tagsAny = this.normalizeTags(audience?.tagsAny);
    const tagsAll = this.normalizeTags(audience?.tagsAll);

    if (hasSegment) {
      if (language || tagsAny.length > 0 || tagsAll.length > 0) {
        throw new BadRequestException(
          "Campaign audience cannot combine segmentId with language, tagsAny, or tagsAll",
        );
      }

      const segment = await this.segments.resolveActiveForCampaign(tenantId, audience!.segmentId!);
      return {
        allOptedIn: false,
        segmentId: segment.id,
        segmentName: segment.name,
        segmentUpdatedAt: segment.updatedAt.toISOString(),
        ...segment.definition,
      };
    }

    return {
      allOptedIn,
      ...(hasExplicitContacts ? { contactIds } : {}),
      ...(language ? { language } : {}),
      ...(tagsAny.length > 0 ? { tagsAny } : {}),
      ...(tagsAll.length > 0 ? { tagsAll } : {}),
    };
  }

  private readAudience(value: Prisma.JsonValue): NormalizedCampaignAudience {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new UnprocessableEntityException("Campaign audience snapshot configuration is invalid");
    }
    const candidate = value as {
      allOptedIn?: unknown;
      contactIds?: unknown;
      segmentId?: unknown;
      segmentName?: unknown;
      segmentUpdatedAt?: unknown;
      language?: unknown;
      tagsAny?: unknown;
      tagsAll?: unknown;
    };
    const allOptedIn = candidate.allOptedIn === true;
    const contactIds = Array.isArray(candidate.contactIds)
      ? candidate.contactIds.filter((item): item is string => typeof item === "string")
      : undefined;
    const hasContacts = !!contactIds && contactIds.length > 0;
    const segmentId = typeof candidate.segmentId === "string" ? candidate.segmentId : undefined;
    const hasSegment = !!segmentId;
    const modeCount = Number(allOptedIn) + Number(hasContacts) + Number(hasSegment);
    if (modeCount !== 1) {
      throw new UnprocessableEntityException("Campaign audience configuration is ambiguous");
    }

    const tagsAny = this.readStringArray(candidate.tagsAny);
    const tagsAll = this.readStringArray(candidate.tagsAll);
    return {
      allOptedIn,
      ...(hasContacts ? { contactIds } : {}),
      ...(segmentId ? { segmentId } : {}),
      ...(typeof candidate.segmentName === "string" ? { segmentName: candidate.segmentName } : {}),
      ...(typeof candidate.segmentUpdatedAt === "string"
        ? { segmentUpdatedAt: candidate.segmentUpdatedAt }
        : {}),
      ...(typeof candidate.language === "string" && candidate.language.length > 0
        ? { language: candidate.language }
        : {}),
      ...(tagsAny.length > 0 ? { tagsAny } : {}),
      ...(tagsAll.length > 0 ? { tagsAll } : {}),
    };
  }

  private tagFilter(audience: NormalizedCampaignAudience): Prisma.StringNullableListFilter | undefined {
    if (!audience.tagsAny && !audience.tagsAll) {
      return undefined;
    }
    return {
      ...(audience.tagsAny ? { hasSome: audience.tagsAny } : {}),
      ...(audience.tagsAll ? { hasEvery: audience.tagsAll } : {}),
    };
  }

  private normalizeTags(tags?: string[]): string[] {
    return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()))].sort();
  }

  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return this.normalizeTags(value.filter((item): item is string => typeof item === "string"));
  }

  private assertComponentsValid(components: unknown): void {
    try {
      validateCampaignComponents(components);
    } catch (error) {
      if (error instanceof CampaignPersonalizationTemplateError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private assertMarketingTemplate(
    template: { status: string; category: string | null; wabaId: string },
    senderWabaId: string,
  ): void {
    if (template.wabaId !== senderWabaId) {
      throw new UnprocessableEntityException("Campaign template does not belong to the selected sender WABA");
    }
    if (template.status.toUpperCase() !== "APPROVED") {
      throw new UnprocessableEntityException("Campaign template must be APPROVED");
    }
    if (template.category?.toUpperCase() !== "MARKETING") {
      throw new UnprocessableEntityException("Campaigns require a MARKETING template");
    }
  }

  private maxRecipients(): number {
    const value = Number(process.env.CAMPAIGN_MAX_RECIPIENTS ?? 50000);
    return Number.isInteger(value) && value > 0 ? Math.min(value, 50000) : 50000;
  }

  private campaignInclude() {
    return {
      sender: {
        select: {
          id: true,
          providerPhoneNumberId: true,
          displayPhoneNumber: true,
          verifiedName: true,
          wabaId: true,
          active: true,
        },
      },
      template: {
        select: {
          id: true,
          providerTemplateId: true,
          name: true,
          language: true,
          category: true,
          status: true,
          wabaId: true,
        },
      },
    } satisfies Prisma.CampaignInclude;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
