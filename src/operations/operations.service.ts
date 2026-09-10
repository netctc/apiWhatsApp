import { Injectable } from "@nestjs/common";
import {
  CampaignRecipientStatus,
  CampaignStatus,
  MessageDirection,
  MessageStatus,
  MessageTrafficClass,
  Prisma,
} from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";

interface OutboxBacklogRow {
  pending: number;
  due: number;
  leased: number;
  withErrors: number;
  oldestPendingAgeSeconds: number | null;
}

interface MediaAssetOperationsRow {
  total: number;
  providerUploaded: number;
  failed: number;
  expired: number;
  retainedBinaries: number;
  retainedBytes: number;
  expiringWithin24Hours: number;
}

export interface OperationsSnapshot {
  messages: {
    total: number;
    byStatus: Record<MessageStatus, number>;
    outboundByTrafficClass: Record<MessageTrafficClass, number>;
  };
  campaigns: {
    total: number;
    byStatus: Record<CampaignStatus, number>;
    recipientsByStatus: Record<CampaignRecipientStatus, number>;
  };
  outbox: {
    pending: number;
    due: number;
    leased: number;
    withErrors: number;
    oldestPendingAgeSeconds: number | null;
  };
  mediaAssets: {
    total: number;
    providerUploaded: number;
    failed: number;
    expired: number;
    retainedBinaries: number;
    retainedBytes: number;
    expiringWithin24Hours: number;
  };
  generatedAt: string;
}

@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(tenantId: string): Promise<OperationsSnapshot> {
    const [
      messageRows,
      trafficRows,
      campaignRows,
      recipientRows,
      outboxRows,
      mediaAssetRows,
    ] = await Promise.all([
      this.prisma.message.groupBy({
        by: ["status"],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.message.groupBy({
        by: ["trafficClass"],
        where: { tenantId, direction: MessageDirection.OUTBOUND },
        _count: { _all: true },
      }),
      this.prisma.campaign.groupBy({
        by: ["status"],
        where: { tenantId },
        _count: { _all: true },
      }),
      this.prisma.campaignRecipient.groupBy({
        by: ["status"],
        where: { campaign: { tenantId } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<OutboxBacklogRow[]>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE o."publishedAt" IS NULL)::int AS "pending",
          COUNT(*) FILTER (
            WHERE o."publishedAt" IS NULL
              AND o."nextAttemptAt" <= NOW()
              AND (o."processingLeaseUntil" IS NULL OR o."processingLeaseUntil" <= NOW())
          )::int AS "due",
          COUNT(*) FILTER (
            WHERE o."publishedAt" IS NULL
              AND o."processingLeaseUntil" > NOW()
          )::int AS "leased",
          COUNT(*) FILTER (
            WHERE o."publishedAt" IS NULL
              AND o."lastError" IS NOT NULL
          )::int AS "withErrors",
          EXTRACT(EPOCH FROM (
            NOW() - MIN(o."createdAt") FILTER (WHERE o."publishedAt" IS NULL)
          ))::int AS "oldestPendingAgeSeconds"
        FROM "OutboxEvent" AS o
        INNER JOIN "Message" AS m
          ON m."id" = o."aggregateId"
        WHERE o."aggregateType" = 'Message'
          AND o."eventType" = 'message.outbound.requested'
          AND m."tenantId" = ${tenantId}::uuid
      `),
      this.prisma.$queryRaw<MediaAssetOperationsRow[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS "total",
          COUNT(*) FILTER (WHERE a."providerUploadedAt" IS NOT NULL)::int AS "providerUploaded",
          COUNT(*) FILTER (WHERE a."failedAt" IS NOT NULL)::int AS "failed",
          COUNT(*) FILTER (
            WHERE a."expiresAt" IS NOT NULL
              AND a."expiresAt" <= NOW()
          )::int AS "expired",
          COUNT(*) FILTER (
            WHERE a."storageMode" = 'FILESYSTEM'
              AND a."storageKey" IS NOT NULL
              AND a."storedAt" IS NOT NULL
          )::int AS "retainedBinaries",
          COALESCE(SUM(a."size") FILTER (
            WHERE a."storageMode" = 'FILESYSTEM'
              AND a."storageKey" IS NOT NULL
              AND a."storedAt" IS NOT NULL
          ), 0)::double precision AS "retainedBytes",
          COUNT(*) FILTER (
            WHERE a."expiresAt" > NOW()
              AND a."expiresAt" <= NOW() + INTERVAL '24 hours'
          )::int AS "expiringWithin24Hours"
        FROM "MediaAsset" AS a
        WHERE a."tenantId" = ${tenantId}::uuid
      `),
    ]);

    const messagesByStatus = this.zeroedRecord(MessageStatus);
    for (const row of messageRows) {
      messagesByStatus[row.status] = row._count._all;
    }

    const outboundByTrafficClass = this.zeroedRecord(MessageTrafficClass);
    for (const row of trafficRows) {
      outboundByTrafficClass[row.trafficClass] = row._count._all;
    }

    const campaignsByStatus = this.zeroedRecord(CampaignStatus);
    for (const row of campaignRows) {
      campaignsByStatus[row.status] = row._count._all;
    }

    const recipientsByStatus = this.zeroedRecord(CampaignRecipientStatus);
    for (const row of recipientRows) {
      recipientsByStatus[row.status] = row._count._all;
    }

    const outbox = outboxRows[0] ?? {
      pending: 0,
      due: 0,
      leased: 0,
      withErrors: 0,
      oldestPendingAgeSeconds: null,
    };
    const mediaAssets = mediaAssetRows[0] ?? {
      total: 0,
      providerUploaded: 0,
      failed: 0,
      expired: 0,
      retainedBinaries: 0,
      retainedBytes: 0,
      expiringWithin24Hours: 0,
    };

    return {
      messages: {
        total: this.total(messagesByStatus),
        byStatus: messagesByStatus,
        outboundByTrafficClass,
      },
      campaigns: {
        total: this.total(campaignsByStatus),
        byStatus: campaignsByStatus,
        recipientsByStatus,
      },
      outbox,
      mediaAssets,
      generatedAt: new Date().toISOString(),
    };
  }

  private zeroedRecord<T extends string>(values: Record<string, T>): Record<T, number> {
    return Object.fromEntries(Object.values(values).map((value) => [value, 0])) as Record<T, number>;
  }

  private total<T extends string>(record: Record<T, number>): number {
    return Object.values<number>(record).reduce((sum, value) => sum + value, 0);
  }
}
