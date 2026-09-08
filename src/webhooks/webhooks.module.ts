import { Module } from "@nestjs/common";
import { WebhookEventProcessorService } from "./webhook-event-processor.service.js";
import { WebhookStatusService } from "./webhook-status.service.js";
import { WebhooksController } from "./webhooks.controller.js";

@Module({
  controllers: [WebhooksController],
  providers: [WebhookStatusService, WebhookEventProcessorService],
})
export class WebhooksModule {}
