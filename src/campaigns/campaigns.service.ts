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
import { TemplatesService } from "../templates/templates.service.js";
import type { CampaignAudienceDto } from "./dto/campaign-audience.dto.js";
import { CreateCampaignDto } from "./dto/create-campaign.dto.js";
import { ListCampaignRecipientsQueryDto } from "./dto/list-campaign-recipients-query.dto.js";
import { ListCampaignsQueryDto } from "./dto/list-campaigns-query.dto.js";

interface NormalizedCampaignAudience {
  allOptedIn: boolean;
  contactIds?: string[];
  language?: string;
}

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly phoneNumbers: PhoneNumbersService,
    private readonly templates: TemplatesService,
  ) {}

  async create(tenantId: string, dto: CreateCampaignDto) {
    const audience = this.normalizeAudience(dto.audience);
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
        name: dto.name.trim(),
        audience: this.toJson(audience),
        components: dto.components ? this.toJson(dto.components) : undefined,
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

        if (campaign.status === CampaignStatus.SCHEDULED || campaign.status === CampaignStatus.RUNNING) {
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
        const contactIds = await transaction.contact.findMany({
          where: {
            tenantId,
            consentStatus: ConsentStatus.OPTED_IN,
            ...(audience.language ? { language: audience.language } : {}),
            ...(audience.contactIds ? { id: { in: audience.contactIds } } : {}),
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
    const campaign = await this.findById(tenantId, id);
    if (campaign.status !== CampaignStatus.RUNNING && campaign.status !== CampaignStatus.SCHEDULED) {
      throw new ConflictException(`Campaign in ${campaign.status} state cannot be paused`);
    }
    return this.prisma.campaign.update({
      where: { id },
      data: { status: CampaignStatus.PAUSED },
      include: this.campaignInclude(),
    });
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

    return this.prisma.campaign.update({
      where: { id },
      data: {
        status,
        ...(status === CampaignStatus.RUNNING && !campaign.startedAt ? { startedAt: now } : {}),
      },
      include: this.campaignInclude(),
    });
  }

  async cancel(tenantId: string, id: string) {
    const campaign = await this.findById(tenantId, id);
    if (
      campaign.status === CampaignStatus.COMPLETED ||
      campaign.status === CampaignStatus.CANCELLED ||
      campaign.status === CampaignStatus.FAILED
    ) {
      if (campaign.status === CampaignStatus.CANCELLED) {
        return campaign;
      }
      throw new ConflictException(`Campaign in ${campaign.status} state cannot be cancelled`);
    }

    await this.prisma.$transaction(async (transaction) => {
      await transaction.campaign.update({
        where: { id },
        data: {
          status: CampaignStatus.CANCELLED,
          cancelledAt: new Date(),
        },
      });
      await transaction.campaignRecipient.updateMany({
        where: { campaignId: id, status: CampaignRecipientStatus.PENDING },
        data: {
          status: CampaignRecipientStatus.CANCELLED,
          processingLeaseUntil: null,
          lastError: "Campaign cancelled before recipient processing",
        },
      });
    });

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

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) {
      return;
    }

    const shouldComplete =
      campaign.status === CampaignStatus.RUNNING && pending === 0 && processing === 0;

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        queuedRecipients: counts.get(CampaignRecipientStatus.QUEUED) ?? 0,
        skippedRecipients: counts.get(CampaignRecipientStatus.SKIPPED) ?? 0,
        failedRecipients: counts.get(CampaignRecipientStatus.FAILED) ?? 0,
        cancelledRecipients: counts.get(CampaignRecipientStatus.CANCELLED) ?? 0,
        ...(shouldComplete ? { status: CampaignStatus.COMPLETED, completedAt: new Date() } : {}),
      },
    });
  }

  async failCampaign(campaignId: string, reason: string): Promise<void> {
    await this.prisma.campaign.updateMany({
      where: {
        id: campaignId,
        status: { in: [CampaignStatus.RUNNING, CampaignStatus.SCHEDULED] },
      },
      data: {
        status: CampaignStatus.FAILED,
        failureReason: reason.slice(0, 2000),
      },
    });
  }

  private normalizeAudience(audience: CampaignAudienceDto): NormalizedCampaignAudience {
    const allOptedIn = audience?.allOptedIn === true;
    const contactIds = audience?.contactIds?.filter(Boolean) ?? [];
    const hasExplicitContacts = contactIds.length > 0;

    if (allOptedIn === hasExplicitContacts) {
      throw new BadRequestException(
        "Campaign audience must specify exactly one of allOptedIn=true or a non-empty contactIds list",
      );
    }

    const language = audience.language?.trim();
    return {
      allOptedIn,
      ...(hasExplicitContacts ? { contactIds } : {}),
      ...(language ? { language } : {}),
    };
  }

  private readAudience(value: Prisma.JsonValue): NormalizedCampaignAudience {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new UnprocessableEntityException("Campaign audience snapshot configuration is invalid");
    }
    const candidate = value as {
      allOptedIn?: unknown;
      contactIds?: unknown;
      language?: unknown;
    };
    const allOptedIn = candidate.allOptedIn === true;
    const contactIds = Array.isArray(candidate.contactIds)
      ? candidate.contactIds.filter((item): item is string => typeof item === "string")
      : undefined;
    const hasContacts = !!contactIds && contactIds.length > 0;
    if (allOptedIn === hasContacts) {
      throw new UnprocessableEntityException("Campaign audience configuration is ambiguous");
    }
    return {
      allOptedIn,
      ...(hasContacts ? { contactIds } : {}),
      ...(typeof candidate.language === "string" && candidate.language.length > 0
        ? { language: candidate.language }
        : {}),
    };
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
