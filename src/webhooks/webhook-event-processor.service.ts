import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
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
      const events = await this.prisma.webhookEvent.findMany({
        where: { processed: false },
        orderBy: { receivedAt: "asc" },
        take: batchSize,
      });

      for (const event of events) {
        try {
          await this.statusService.processWebhookEvent(event.id, event.payload);
        } catch (error) {
          this.logger.error(
            `Failed to process webhook event ${event.id}`,
            error instanceof Error ? error.stack : String(error),
          );
          break;
        }
      }
    } catch (error) {
      this.logger.error("Webhook processor poll failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.processing = false;
    }
  }
}
