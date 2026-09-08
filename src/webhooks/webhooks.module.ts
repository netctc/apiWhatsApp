import { Module } from "@nestjs/common";
import { WebhookStatusService } from "./webhook-status.service.js";
import { WebhooksController } from "./webhooks.controller.js";

@Module({
  controllers: [WebhooksController],
  providers: [WebhookStatusService],
})
export class WebhooksModule {}
