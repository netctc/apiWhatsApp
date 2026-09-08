import { Module } from "@nestjs/common";
import { PhoneNumbersModule } from "../phone-numbers/phone-numbers.module.js";
import { InboundMessageService } from "./inbound-message.service.js";
import { WebhookEventProcessorService } from "./webhook-event-processor.service.js";
import { WebhookStatusService } from "./webhook-status.service.js";
import { WebhooksController } from "./webhooks.controller.js";

@Module({
  imports: [PhoneNumbersModule],
  controllers: [WebhooksController],
  providers: [InboundMessageService, WebhookStatusService, WebhookEventProcessorService],
})
export class WebhooksModule {}
