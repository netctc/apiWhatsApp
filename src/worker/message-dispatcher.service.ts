import { Injectable, Logger } from "@nestjs/common";
import { MessageStatus, Prisma } from "../generated/prisma/client.js";
import { MetaApiError } from "../meta/meta-api.error.js";
import { MetaWhatsAppClient } from "../meta/meta-whatsapp.client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { OutboundQueueJob, QueueProcessingResult } from "../queue/messaging-queue.service.js";
import { DistributedRateLimiterService } from "./distributed-rate-limiter.service.js";

const TERMINAL_OR_SUBMITTED_STATUSES = new Set<MessageStatus>([
  MessageStatus.SUBMITTED,
  MessageStatus.SENT,
  MessageStatus.DELIVERED,
  MessageStatus.READ,
  MessageStatus.FAILED,
  MessageStatus.CANCELLED,
  MessageStatus.EXPIRED,
]);

@Injectable()
export class MessageDispatcherService {
  private readonly logger = new Logger(MessageDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaWhatsAppClient,
    private readonly rateLimiter: DistributedRateLimiterService,
  ) {}

  async dispatch(job: OutboundQueueJob): Promise<QueueProcessingResult> {
    const message = await this.prisma.message.findUnique({ where: { id: job.messageId } });
    if (!message) {
      this.logger.warn(`Ignoring queue job for missing message ${job.messageId}`);
      return { action: "ack" };
    }

    if (message.providerMessageId || TERMINAL_OR_SUBMITTED_STATUSES.has(message.status)) {
      return { action: "ack" };
    }

    await this.prisma.message.update({
      where: { id: message.id },
      data: {
        status: MessageStatus.PROCESSING,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        errorCode: null,
        errorMessage: null,
        statusEvents: {
          create: {
            status: MessageStatus.PROCESSING,
            payload: { attempt: job.attempt + 1 },
          },
        },
      },
    });

    try {
      await this.rateLimiter.waitForOutboundSlot();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Rate limiter unavailable";
      await this.markRetryableFailure(message.id, "RATE_LIMITER_UNAVAILABLE", reason, job.attempt);
      return { action: "retry", reason };
    }

    try {
      const result = await this.meta.sendMessage(message);
      await this.prisma.message.update({
        where: { id: message.id },
        data: {
          status: MessageStatus.SUBMITTED,
          providerMessageId: result.providerMessageId,
          providerResponse: this.toJson(result.response),
          submittedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          statusEvents: {
            create: {
              status: MessageStatus.SUBMITTED,
              payload: { providerMessageId: result.providerMessageId },
            },
          },
        },
      });
      return { action: "ack" };
    } catch (error) {
      if (error instanceof MetaApiError) {
        const errorCode = this.metaErrorCode(error);
        if (error.retryable) {
          await this.markRetryableFailure(message.id, errorCode, error.message, job.attempt, error.response);
          return { action: "retry", reason: error.message };
        }

        await this.markFailed(message.id, errorCode, error.message, error.response);
        return { action: "dead", reason: error.message };
      }

      const reason = error instanceof Error ? error.message : "Outbound message mapping failed";
      await this.markFailed(message.id, "OUTBOUND_VALIDATION_ERROR", reason);
      return { action: "dead", reason };
    }
  }

  async markRetryExhausted(job: OutboundQueueJob, reason?: string): Promise<void> {
    const message = await this.prisma.message.findUnique({ where: { id: job.messageId } });
    if (!message || TERMINAL_OR_SUBMITTED_STATUSES.has(message.status)) {
      return;
    }

    await this.markFailed(
      message.id,
      "RETRY_EXHAUSTED",
      reason ?? `Outbound retry policy exhausted after ${job.attempt + 1} attempts`,
    );
  }

  private async markRetryableFailure(
    messageId: string,
    errorCode: string,
    errorMessage: string,
    attempt: number,
    response?: unknown,
  ): Promise<void> {
    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        status: MessageStatus.QUEUED,
        errorCode,
        errorMessage: errorMessage.slice(0, 2000),
        statusEvents: {
          create: {
            status: MessageStatus.QUEUED,
            payload: this.toJson({
              retry: true,
              attempt: attempt + 1,
              errorCode,
              errorMessage,
              response,
            }),
          },
        },
      },
    });
  }

  private async markFailed(
    messageId: string,
    errorCode: string,
    errorMessage: string,
    response?: unknown,
  ): Promise<void> {
    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        status: MessageStatus.FAILED,
        errorCode,
        errorMessage: errorMessage.slice(0, 2000),
        failedAt: new Date(),
        ...(response !== undefined ? { providerResponse: this.toJson(response) } : {}),
        statusEvents: {
          create: {
            status: MessageStatus.FAILED,
            payload: this.toJson({ errorCode, errorMessage, response }),
          },
        },
      },
    });
  }

  private metaErrorCode(error: MetaApiError): string {
    if (error.code !== undefined) {
      return `META_${error.code}${error.subcode !== undefined ? `_${error.subcode}` : ""}`;
    }
    if (error.httpStatus !== undefined) {
      return `HTTP_${error.httpStatus}`;
    }
    return "META_API_ERROR";
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
