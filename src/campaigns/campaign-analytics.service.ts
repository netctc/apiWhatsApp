import { Injectable, NotFoundException } from "@nestjs/common";
import {
  CampaignRecipientStatus,
  CampaignStatus,
  MessageStatus,
  Prisma,
} from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";

export interface CampaignMessageMilestones {
  created: number;
  submitted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}

export interface CampaignAnalyticsResponse {
  campaign: {
    id: string;
    name: string;
    status: CampaignStatus;
    totalRecipients: number;
    snapshotAt: Date | null;
    startedAt: Date | null;
    completedAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  orchestration: {
    snapshotRecipients: number;
    byStatus: Record<CampaignRecipientStatus, number>;
    terminalRecipients: number;
  };
  messages: {
    milestones: CampaignMessageMilestones;
    currentStatus: Record<MessageStatus, number>;
  };
  rates: {
    messageCreationRate: number | null;
    submissionRate: number | null;
    deliveryRate: number | null;
    readRate: number | null;
    failureRate: number | null;
  };
  consistency: {
    snapshotMatchesStoredTotal: boolean;
  };
  generatedAt: Date;
}

interface CurrentMessageStatusRow {
  status: MessageStatus;
  count: number;
}

@Injectable()
export class CampaignAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: string, campaignId: string): Promise<CampaignAnalyticsResponse> {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, tenantId },
      select: {
        id: true,
        name: true,
        status: true,
        totalRecipients: true,
        snapshotAt: true,
        startedAt: true,
        completedAt: true,
        cancelledAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    const [recipientRows, milestoneRows, currentStatusRows] = await Promise.all([
      this.prisma.campaignRecipient.groupBy({
        by: ["status"],
        where: { campaignId },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<CampaignMessageMilestones[]>(Prisma.sql`
        SELECT
          COUNT(r."messageId")::int AS "created",
          COUNT(*) FILTER (WHERE m."submittedAt" IS NOT NULL)::int AS "submitted",
          COUNT(*) FILTER (WHERE m."sentAt" IS NOT NULL)::int AS "sent",
          COUNT(*) FILTER (WHERE m."deliveredAt" IS NOT NULL)::int AS "delivered",
          COUNT(*) FILTER (WHERE m."readAt" IS NOT NULL)::int AS "read",
          COUNT(*) FILTER (WHERE m."failedAt" IS NOT NULL)::int AS "failed"
        FROM "CampaignRecipient" AS r
        LEFT JOIN "Message" AS m ON m."id" = r."messageId"
        WHERE r."campaignId" = ${campaignId}::uuid
      `),
      this.prisma.$queryRaw<CurrentMessageStatusRow[]>(Prisma.sql`
        SELECT m."status"::text AS "status", COUNT(*)::int AS "count"
        FROM "CampaignRecipient" AS r
        INNER JOIN "Message" AS m ON m."id" = r."messageId"
        WHERE r."campaignId" = ${campaignId}::uuid
        GROUP BY m."status"
      `),
    ]);

    const recipientCounts = this.recipientCounts(recipientRows);
    const snapshotRecipients = Object.values(recipientCounts).reduce((sum, count) => sum + count, 0);
    const milestones = milestoneRows[0] ?? {
      created: 0,
      submitted: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
    };
    const currentMessageStatus = this.messageStatusCounts(currentStatusRows);

    return {
      campaign,
      orchestration: {
        snapshotRecipients,
        byStatus: recipientCounts,
        terminalRecipients:
          recipientCounts.QUEUED +
          recipientCounts.SKIPPED +
          recipientCounts.FAILED +
          recipientCounts.CANCELLED,
      },
      messages: {
        milestones,
        currentStatus: currentMessageStatus,
      },
      rates: {
        messageCreationRate: this.rate(milestones.created, snapshotRecipients),
        submissionRate: this.rate(milestones.submitted, milestones.created),
        deliveryRate: this.rate(milestones.delivered, milestones.submitted),
        readRate: this.rate(milestones.read, milestones.delivered),
        failureRate: this.rate(milestones.failed, milestones.created),
      },
      consistency: {
        snapshotMatchesStoredTotal: snapshotRecipients === campaign.totalRecipients,
      },
      generatedAt: new Date(),
    };
  }

  private recipientCounts(
    rows: Array<{ status: CampaignRecipientStatus; _count: { _all: number } }>,
  ): Record<CampaignRecipientStatus, number> {
    const counts = Object.fromEntries(
      Object.values(CampaignRecipientStatus).map((status) => [status, 0]),
    ) as Record<CampaignRecipientStatus, number>;

    for (const row of rows) {
      counts[row.status] = row._count._all;
    }
    return counts;
  }

  private messageStatusCounts(rows: CurrentMessageStatusRow[]): Record<MessageStatus, number> {
    const counts = Object.fromEntries(
      Object.values(MessageStatus).map((status) => [status, 0]),
    ) as Record<MessageStatus, number>;

    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  private rate(numerator: number, denominator: number): number | null {
    if (denominator <= 0) {
      return null;
    }
    return Math.round((numerator / denominator) * 10000) / 100;
  }
}
