import {
  ForbiddenException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  CampaignRecipient,
  CampaignRecipientStatus,
  CampaignStatus,
  Prisma,
} from "../generated/prisma/client.js";
import { OutboundMessageType } from "../messages/dto/create-message.dto.js";
import { MessagesService } from "../messages/messages.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  CampaignPersonalizationTemplateError,
  CampaignPersonalizationValueError,
  isCampaignPersonalizationEnabled,
  renderCampaignComponents,
} from "./campaign-personalization.util.js";
import { CampaignsService } from "./campaigns.service.js";

@Injectable()
export class CampaignProcessorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CampaignProcessorService.name);
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessagesService,
    private readonly campaigns: CampaignsService,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = Math.max(250, Number(process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS ?? 500));
    this.timer = setInterval(() => void this.processPending(), intervalMs);
    this.timer.unref();
    void this.processPending();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async processPending(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      await this.promoteScheduledCampaigns();
      const batchSize = this.positiveInteger(process.env.CAMPAIGN_PROCESSOR_BATCH_SIZE, 100);
      const recipients = await this.claimRecipients(batchSize);
      const touchedCampaigns = new Set<string>();

      for (const recipient of recipients) {
        touchedCampaigns.add(recipient.campaignId);
        try {
          await this.processRecipient(recipient);
        } catch (error) {
          this.logger.error(
            `Campaign recipient ${recipient.id} processing failed unexpectedly`,
            error instanceof Error ? error.stack : String(error),
          );
          await this.retryOrFail(recipient, error);
        }
      }

      for (const campaignId of touchedCampaigns) {
        await this.campaigns.refreshStats(campaignId);
      }
    } catch (error) {
      this.logger.error(
        "Campaign processor poll failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.processing = false;
    }
  }

  private async promoteScheduledCampaigns(): Promise<void> {
    const now = new Date();
    await this.prisma.campaign.updateMany({
      where: {
        status: CampaignStatus.SCHEDULED,
        scheduledAt: { lte: now },
      },
      data: {
        status: CampaignStatus.RUNNING,
        startedAt: now,
      },
    });
  }

  private async claimRecipients(batchSize: number): Promise<CampaignRecipient[]> {
    const leaseMs = Math.max(
      5000,
      this.positiveInteger(process.env.CAMPAIGN_PROCESSOR_LEASE_MS, 30000),
    );
    const leaseUntil = new Date(Date.now() + leaseMs);

    return this.prisma.$queryRaw<CampaignRecipient[]>(Prisma.sql`
      WITH candidates AS (
        SELECT r."id"
        FROM "CampaignRecipient" AS r
        INNER JOIN "Campaign" AS c ON c."id" = r."campaignId"
        WHERE (
            (
              r."status" = 'PENDING'
              AND r."nextAttemptAt" <= NOW()
              AND (r."processingLeaseUntil" IS NULL OR r."processingLeaseUntil" <= NOW())
              AND c."status" = 'RUNNING'
            )
            OR (
              r."status" = 'PROCESSING'
              AND r."processingLeaseUntil" <= NOW()
            )
          )
        ORDER BY r."createdAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE OF r SKIP LOCKED
      )
      UPDATE "CampaignRecipient" AS r
      SET "status" = 'PROCESSING',
          "attemptCount" = r."attemptCount" + 1,
          "processingLeaseUntil" = ${leaseUntil},
          "updatedAt" = NOW()
      FROM candidates
      WHERE r."id" = candidates."id"
      RETURNING r.*
    `);
  }

  private async processRecipient(claim: CampaignRecipient): Promise<void> {
    const recipient = await this.prisma.campaignRecipient.findUnique({
      where: { id: claim.id },
      include: {
        contact: true,
        campaign: {
          include: {
            sender: true,
            template: true,
          },
        },
      },
    });
    if (!recipient) {
      return;
    }

    const campaign = recipient.campaign;
    const idempotencyKey = this.recipientIdempotencyKey(campaign.id, recipient.contactId);
    const existingMessageId = await this.findExistingMessageId(campaign.tenantId, idempotencyKey);
    if (existingMessageId) {
      await this.completeAsQueued(claim, existingMessageId);
      return;
    }

    if (campaign.status !== CampaignStatus.RUNNING) {
      await this.completeForCampaignState(claim, campaign.status, campaign.failureReason);
      return;
    }

    const configurationError = this.configurationError(campaign);
    if (configurationError) {
      const transitioned = await this.campaigns.failCampaign(campaign.id, configurationError);
      if (transitioned) {
        await this.completeClaim(claim, {
          status: CampaignRecipientStatus.FAILED,
          lastError: configurationError,
        });
      } else {
        await this.completeForCurrentCampaignState(claim, campaign.id, configurationError);
      }
      return;
    }

    try {
      const components = Array.isArray(campaign.components)
        ? isCampaignPersonalizationEnabled(campaign.audience)
          ? this.renderComponents(campaign.components, recipient.contact)
          : campaign.components
        : undefined;
      const message = await this.messages.create(campaign.tenantId, {
        to: recipient.contact.phone,
        senderId: campaign.senderId,
        type: OutboundMessageType.TEMPLATE,
        idempotencyKey,
        payload: {
          name: campaign.template.name,
          language: campaign.template.language,
          ...(components ? { components } : {}),
        },
      });

      await this.completeAsQueued(claim, message.id);
    } catch (error) {
      if (error instanceof CampaignPersonalizationValueError) {
        await this.completeClaim(claim, {
          status: CampaignRecipientStatus.SKIPPED,
          lastError: error.message.slice(0, 2000),
        });
        return;
      }

      if (error instanceof CampaignPersonalizationTemplateError) {
        const reason = error.message.slice(0, 2000);
        const transitioned = await this.campaigns.failCampaign(campaign.id, reason);
        if (transitioned) {
          await this.completeClaim(claim, {
            status: CampaignRecipientStatus.FAILED,
            lastError: reason,
          });
        } else {
          await this.completeForCurrentCampaignState(claim, campaign.id, reason);
        }
        return;
      }

      if (error instanceof ForbiddenException) {
        await this.completeClaim(claim, {
          status: CampaignRecipientStatus.SKIPPED,
          lastError: error.message.slice(0, 2000),
        });
        return;
      }

      if (error instanceof UnprocessableEntityException) {
        const reason = error.message.slice(0, 2000);
        const transitioned = await this.campaigns.failCampaign(campaign.id, reason);
        if (transitioned) {
          await this.completeClaim(claim, {
            status: CampaignRecipientStatus.FAILED,
            lastError: reason,
          });
        } else {
          await this.completeForCurrentCampaignState(claim, campaign.id, reason);
        }
        return;
      }

      await this.retryOrFail(claim, error);
    }
  }

  private renderComponents(
    components: unknown[],
    contact: {
      name: string | null;
      phone: string;
      language: string | null;
      timezone: string | null;
      metadata: Prisma.JsonValue | null;
    },
  ): unknown[] {
    const rendered = renderCampaignComponents(components, contact);
    if (!Array.isArray(rendered)) {
      throw new CampaignPersonalizationTemplateError("Campaign components must render to an array");
    }
    return rendered;
  }

  private configurationError(campaign: {
    sender: { active: boolean; wabaId: string | null };
    template: { status: string; category: string | null; wabaId: string };
  }): string | undefined {
    if (!campaign.sender.active || !campaign.sender.wabaId) {
      return "Campaign sender is inactive or missing its WABA ID";
    }
    if (campaign.template.wabaId !== campaign.sender.wabaId) {
      return "Campaign template no longer belongs to the sender WABA";
    }
    if (campaign.template.status.toUpperCase() !== "APPROVED") {
      return `Campaign template is no longer APPROVED (${campaign.template.status})`;
    }
    if (campaign.template.category?.toUpperCase() !== "MARKETING") {
      return "Campaign template is no longer categorized as MARKETING";
    }
    return undefined;
  }

  private async findExistingMessageId(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<string | undefined> {
    const message = await this.prisma.message.findFirst({
      where: { tenantId, idempotencyKey },
      select: { id: true },
    });
    return message?.id;
  }

  private recipientIdempotencyKey(campaignId: string, contactId: string): string {
    return `campaign:${campaignId}:contact:${contactId}`;
  }

  private async completeAsQueued(claim: CampaignRecipient, messageId: string): Promise<void> {
    await this.completeClaim(claim, {
      status: CampaignRecipientStatus.QUEUED,
      messageId,
      queuedAt: new Date(),
      lastError: null,
    });
  }

  private async completeForCurrentCampaignState(
    claim: CampaignRecipient,
    campaignId: string,
    fallbackReason: string,
  ): Promise<void> {
    const current = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true, failureReason: true },
    });

    if (!current) {
      return;
    }

    await this.completeForCampaignState(
      claim,
      current.status,
      current.failureReason ?? fallbackReason,
    );
  }

  private async completeForCampaignState(
    claim: CampaignRecipient,
    status: CampaignStatus,
    failureReason?: string | null,
  ): Promise<void> {
    if (status === CampaignStatus.CANCELLED) {
      await this.completeClaim(claim, {
        status: CampaignRecipientStatus.CANCELLED,
        lastError: "Campaign cancelled while recipient was in flight",
      });
      return;
    }

    if (status === CampaignStatus.FAILED) {
      await this.completeClaim(claim, {
        status: CampaignRecipientStatus.FAILED,
        lastError: failureReason ?? "Campaign failed while recipient was in flight",
      });
      return;
    }

    if (status === CampaignStatus.PAUSED || status === CampaignStatus.SCHEDULED) {
      await this.completeClaim(claim, {
        status: CampaignRecipientStatus.PENDING,
        nextAttemptAt: new Date(),
        lastError: null,
      });
      return;
    }

    if (status === CampaignStatus.COMPLETED) {
      await this.completeClaim(claim, {
        status: CampaignRecipientStatus.CANCELLED,
        lastError: "Campaign completed before this recipient claim could finish",
      });
      return;
    }

    await this.completeClaim(claim, {
      status: CampaignRecipientStatus.PENDING,
      nextAttemptAt: new Date(),
      lastError: null,
    });
  }

  private async retryOrFail(claim: CampaignRecipient, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const maxAttempts = this.positiveInteger(process.env.CAMPAIGN_RECIPIENT_MAX_ATTEMPTS, 5);

    if (claim.attemptCount >= maxAttempts) {
      await this.completeClaim(claim, {
        status: CampaignRecipientStatus.FAILED,
        lastError: message.slice(0, 2000),
      });
      return;
    }

    const delayMs = Math.min(60000, 1000 * 2 ** Math.min(Math.max(claim.attemptCount - 1, 0), 6));
    await this.completeClaim(claim, {
      status: CampaignRecipientStatus.PENDING,
      nextAttemptAt: new Date(Date.now() + delayMs),
      lastError: message.slice(0, 2000),
    });
  }

  private async completeClaim(
    claim: CampaignRecipient,
    data: {
      status: CampaignRecipientStatus;
      nextAttemptAt?: Date;
      lastError?: string | null;
      messageId?: string;
      queuedAt?: Date;
    },
  ): Promise<void> {
    await this.prisma.campaignRecipient.updateMany({
      where: {
        id: claim.id,
        status: CampaignRecipientStatus.PROCESSING,
        processingLeaseUntil: claim.processingLeaseUntil,
      },
      data: {
        ...data,
        processingLeaseUntil: null,
      },
    });
  }

  private positiveInteger(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
