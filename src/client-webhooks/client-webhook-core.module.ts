import { Module } from "@nestjs/common";
import { ClientWebhookFanoutService } from "./client-webhook-fanout.service.js";
import { ClientWebhookSecretService } from "./client-webhook-secret.service.js";

@Module({
  providers: [ClientWebhookFanoutService, ClientWebhookSecretService],
  exports: [ClientWebhookFanoutService, ClientWebhookSecretService],
})
export class ClientWebhookCoreModule {}
