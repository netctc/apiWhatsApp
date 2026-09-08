import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { Prisma, WebhookEvent } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { WebhookStatusService } from "./webhook-status.service.js";

@Injectable()
export class WebhookEventProcessorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WebhookEventProcessorService.name);
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly statusService: WebhookStatusService,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = Math.max(250, Number(process.env.WEBHOOK_PROCESSOR_INTERVAL_MS ?? 500));
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
      const batchSize = Math.max(1, Number(process.env.WEBHOOK_PROCESSOR_BATCH_SIZE ?? 50));
      const events = await this.claimEvents(batchSize);

      for (const event of events) {
        try {
          await this.statusService.processWebhookEvent(event.id, event.payload);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retryDelayMs = Math.min(60_000, 1000 * 2 ** Math.min(Math.max(event.attemptCount - 1, 0), 6));

          await this.prisma.webhookEvent.update({
            where: { id: event.id },
            data: {
              lastError: message.slice(0, 2000),
              nextAttemptAt: new Date(Date.now() + retryDelayMs),
              processingLeaseUntil: null,
            },
          });

          this.logger.error(
            `Failed to process webhook event ${event.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    } catch (error) {
      this.logger.error("Webhook processor poll failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.processing = false;
    }
  }

  private async claimEvents(batchSize: number): Promise<WebhookEvent[]> {
    const leaseMs = Math.max(5000, Number(process.env.WEBHOOK_PROCESSOR_LEASE_MS ?? 30000));
    const leaseUntil = new Date(Date.now() + leaseMs);

    return this.prisma.$queryRaw<WebhookEvent[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "WebhookEvent"
        WHERE "processed" = false
          AND "nextAttemptAt" <= NOW()
          AND ("processingLeaseUntil" IS NULL OR "processingLeaseUntil" <= NOW())
        ORDER BY "receivedAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "WebhookEvent" AS w
      SET "processingLeaseUntil" = ${leaseUntil},
          "attemptCount" = w."attemptCount" + 1
      FROM candidates
      WHERE w."id" = candidates."id"
      RETURNING w.*
    `);
  }
}
