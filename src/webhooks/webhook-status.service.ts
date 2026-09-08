import { Injectable, Logger } from "@nestjs/common";
import { MessageStatus, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";

interface MetaMessageStatus {
  id: string;
  status: string;
  timestamp?: string;
  errors?: unknown[];
}

const STATUS_RANK: Partial<Record<MessageStatus, number>> = {
  [MessageStatus.CREATED]: 0,
  [MessageStatus.QUEUED]: 1,
  [MessageStatus.PROCESSING]: 2,
  [MessageStatus.SUBMITTED]: 3,
  [MessageStatus.SENT]: 4,
  [MessageStatus.DELIVERED]: 5,
  [MessageStatus.READ]: 6,
};

@Injectable()
export class WebhookStatusService {
  private readonly logger = new Logger(WebhookStatusService.name);

  constructor(private readonly prisma: PrismaService) {}

  async processWebhookEvent(eventId: string, payload: unknown): Promise<void> {
    const statuses = this.extractStatuses(payload);

    for (const providerStatus of statuses) {
      await this.applyStatus(providerStatus);
    }

    await this.prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        processed: true,
        processedAt: new Date(),
        processingLeaseUntil: null,
        lastError: null,
      },
    });
  }

  private async applyStatus(providerStatus: MetaMessageStatus): Promise<void> {
    const targetStatus = this.mapStatus(providerStatus.status);
    if (!targetStatus) {
      return;
    }

    const message = await this.prisma.message.findUnique({
      where: { providerMessageId: providerStatus.id },
    });

    if (!message) {
      this.logger.debug(`Ignoring status for unknown provider message ${providerStatus.id}`);
      return;
    }

    const eventTimestamp = this.parseTimestamp(providerStatus.timestamp) ?? new Date();
    const error = this.extractError(providerStatus.errors);
    const shouldApply = this.shouldApplyStatus(message.status, targetStatus);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.messageStatusEvent.create({
        data: {
          messageId: message.id,
          status: targetStatus,
          payload: this.toJson(providerStatus),
          createdAt: eventTimestamp,
        },
      });

      if (!shouldApply) {
        return;
      }

      await transaction.message.update({
        where: { id: message.id },
        data: {
          status: targetStatus,
          ...(targetStatus === MessageStatus.SENT ? { sentAt: eventTimestamp } : {}),
          ...(targetStatus === MessageStatus.DELIVERED ? { deliveredAt: eventTimestamp } : {}),
          ...(targetStatus === MessageStatus.READ ? { readAt: eventTimestamp } : {}),
          ...(targetStatus === MessageStatus.FAILED
            ? {
                failedAt: eventTimestamp,
                errorCode: error.code,
                errorMessage: error.message,
              }
            : {}),
        },
      });
    });
  }

  private extractStatuses(payload: unknown): MetaMessageStatus[] {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return [];
    }

    const entries = (payload as { entry?: unknown }).entry;
    if (!Array.isArray(entries)) {
      return [];
    }

    const statuses: MetaMessageStatus[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const changes = (entry as { changes?: unknown }).changes;
      if (!Array.isArray(changes)) {
        continue;
      }

      for (const change of changes) {
        if (!change || typeof change !== "object") {
          continue;
        }

        const value = (change as { value?: unknown }).value;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          continue;
        }

        const candidates = (value as { statuses?: unknown }).statuses;
        if (!Array.isArray(candidates)) {
          continue;
        }

        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== "object") {
            continue;
          }

          const status = candidate as {
            id?: unknown;
            status?: unknown;
            timestamp?: unknown;
            errors?: unknown;
          };

          if (typeof status.id !== "string" || typeof status.status !== "string") {
            continue;
          }

          statuses.push({
            id: status.id,
            status: status.status,
            timestamp: typeof status.timestamp === "string" ? status.timestamp : undefined,
            errors: Array.isArray(status.errors) ? status.errors : undefined,
          });
        }
      }
    }

    return statuses;
  }

  private mapStatus(status: string): MessageStatus | undefined {
    switch (status.toLowerCase()) {
      case "sent":
        return MessageStatus.SENT;
      case "delivered":
        return MessageStatus.DELIVERED;
      case "read":
        return MessageStatus.READ;
      case "failed":
        return MessageStatus.FAILED;
      default:
        return undefined;
    }
  }

  private shouldApplyStatus(current: MessageStatus, target: MessageStatus): boolean {
    if (target === MessageStatus.FAILED) {
      return current !== MessageStatus.READ && current !== MessageStatus.DELIVERED;
    }

    if (current === MessageStatus.FAILED || current === MessageStatus.CANCELLED || current === MessageStatus.EXPIRED) {
      return false;
    }

    const currentRank = STATUS_RANK[current] ?? -1;
    const targetRank = STATUS_RANK[target] ?? -1;
    return targetRank >= currentRank;
  }

  private parseTimestamp(timestamp?: string): Date | undefined {
    if (!timestamp) {
      return undefined;
    }

    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return undefined;
    }

    return new Date(seconds * 1000);
  }

  private extractError(errors?: unknown[]): { code: string | null; message: string | null } {
    const first = errors?.[0];
    if (!first || typeof first !== "object") {
      return { code: null, message: null };
    }

    const value = first as {
      code?: unknown;
      title?: unknown;
      message?: unknown;
      error_data?: unknown;
    };

    const details =
      value.error_data && typeof value.error_data === "object"
        ? (value.error_data as { details?: unknown }).details
        : undefined;

    const message = [value.title, value.message, details]
      .find((candidate) => typeof candidate === "string" && candidate.length > 0);

    return {
      code: typeof value.code === "number" || typeof value.code === "string" ? String(value.code) : null,
      message: typeof message === "string" ? message.slice(0, 2000) : null,
    };
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
