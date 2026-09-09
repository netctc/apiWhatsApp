import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { MessageTrafficClass, OutboxEvent, Prisma } from "../generated/prisma/client.js";
import {
  TraceContextService,
  type TraceCarrier,
} from "../observability/trace-context.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { MessagingQueueService } from "../queue/messaging-queue.service.js";

const OUTBOUND_REQUESTED_EVENT = "message.outbound.requested";

@Injectable()
export class OutboxPublisherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private timer?: NodeJS.Timeout;
  private flushing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: MessagingQueueService,
    @Optional() private readonly traceContext?: TraceContextService,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = Math.max(250, Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000));
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
    void this.flush();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }

    this.flushing = true;
    try {
      const batchSize = Math.max(1, Number(process.env.OUTBOX_BATCH_SIZE ?? 50));
      const events = await this.claimEvents(batchSize);

      for (const event of events) {
        await this.publish(event.id, event.eventType, event.aggregateId, event.payload, event.attempts);
      }
    } catch (error) {
      this.logger.error("Outbox flush failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.flushing = false;
    }
  }

  private async claimEvents(batchSize: number): Promise<OutboxEvent[]> {
    const leaseMs = Math.max(5000, Number(process.env.OUTBOX_LEASE_MS ?? 30000));
    const leaseUntil = new Date(Date.now() + leaseMs);

    return this.prisma.$queryRaw<OutboxEvent[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "OutboxEvent"
        WHERE "publishedAt" IS NULL
          AND "nextAttemptAt" <= NOW()
          AND ("processingLeaseUntil" IS NULL OR "processingLeaseUntil" <= NOW())
        ORDER BY "createdAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "OutboxEvent" AS o
      SET "processingLeaseUntil" = ${leaseUntil},
          "attempts" = o."attempts" + 1,
          "updatedAt" = NOW()
      FROM candidates
      WHERE o."id" = candidates."id"
      RETURNING o.*
    `);
  }

  private async publish(
    eventId: string,
    eventType: string,
    aggregateId: string,
    payload: unknown,
    attempts: number,
  ): Promise<void> {
    try {
      if (eventType !== OUTBOUND_REQUESTED_EVENT) {
        throw new Error(`Unsupported outbox event type: ${eventType}`);
      }

      const messageId = this.extractMessageId(payload) ?? aggregateId;
      const persistedTrafficClass = await this.lookupTrafficClass(messageId);
      const payloadTrafficClass = this.extractTrafficClass(payload);
      if (payloadTrafficClass && payloadTrafficClass !== persistedTrafficClass) {
        throw new Error(
          `Outbox traffic class ${payloadTrafficClass} does not match persisted message class ${persistedTrafficClass}`,
        );
      }

      await this.queue.publishOutboundMessage(
        messageId,
        persistedTrafficClass,
        this.extractTrace(payload),
      );

      await this.prisma.outboxEvent.update({
        where: { id: eventId },
        data: {
          publishedAt: new Date(),
          processingLeaseUntil: null,
          lastError: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryDelayMs = Math.min(60_000, 1000 * 2 ** Math.min(Math.max(attempts - 1, 0), 6));

      await this.prisma.outboxEvent.update({
        where: { id: eventId },
        data: {
          lastError: message.slice(0, 2000),
          nextAttemptAt: new Date(Date.now() + retryDelayMs),
          processingLeaseUntil: null,
        },
      });

      this.logger.warn(`Failed to publish outbox event ${eventId}: ${message}`);
    }
  }

  private extractMessageId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }

    const messageId = (payload as { messageId?: unknown }).messageId;
    return typeof messageId === "string" && messageId.length > 0 ? messageId : undefined;
  }

  private extractTrafficClass(payload: unknown): MessageTrafficClass | undefined {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    const value = (payload as { trafficClass?: unknown }).trafficClass;
    switch (value) {
      case MessageTrafficClass.OTP:
      case MessageTrafficClass.TRANSACTIONAL:
      case MessageTrafficClass.MARKETING:
        return value;
      default:
        return undefined;
    }
  }

  private extractTrace(payload: unknown): TraceCarrier | undefined {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    return this.traceContext?.parseCarrier((payload as { trace?: unknown }).trace);
  }

  private async lookupTrafficClass(messageId: string): Promise<MessageTrafficClass> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { trafficClass: true },
    });
    if (!message) {
      throw new Error(`Outbound message ${messageId} no longer exists`);
    }
    return message.trafficClass;
  }
}
