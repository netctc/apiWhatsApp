import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
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
      const events = await this.prisma.outboxEvent.findMany({
        where: {
          publishedAt: null,
          nextAttemptAt: { lte: new Date() },
        },
        orderBy: { createdAt: "asc" },
        take: batchSize,
      });

      for (const event of events) {
        await this.publish(event.id, event.eventType, event.aggregateId, event.payload, event.attempts);
      }
    } catch (error) {
      this.logger.error("Outbox flush failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.flushing = false;
    }
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
      await this.queue.publishOutboundMessage(messageId);

      await this.prisma.outboxEvent.update({
        where: { id: eventId },
        data: {
          publishedAt: new Date(),
          lastError: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryDelayMs = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));

      await this.prisma.outboxEvent.update({
        where: { id: eventId },
        data: {
          attempts: { increment: 1 },
          lastError: message.slice(0, 2000),
          nextAttemptAt: new Date(Date.now() + retryDelayMs),
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
}
