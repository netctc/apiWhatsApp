import { Module } from "@nestjs/common";
import { InboxModule } from "../inbox/inbox.module.js";
import { PhoneNumbersModule } from "../phone-numbers/phone-numbers.module.js";
import { TemplatesModule } from "../templates/templates.module.js";
import { InboundMessageService } from "./inbound-message.service.js";
import { TemplateStatusWebhookService } from "./template-status-webhook.service.js";
import { WebhookEventProcessorService } from "./webhook-event-processor.service.js";
import { WebhookStatusService } from "./webhook-status.service.js";
import { WebhooksController } from "./webhooks.controller.js";

@Module({
  imports: [InboxModule, PhoneNumbersModule, TemplatesModule],
  controllers: [WebhooksController],
  providers: [
    InboundMessageService,
    TemplateStatusWebhookService,
    WebhookStatusService,
    WebhookEventProcessorService,
  ],
})
export class WebhooksModule {}
