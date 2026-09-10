import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { ClientWebhookCoreModule } from "./client-webhook-core.module.js";
import { ClientWebhookDeliveryProcessorService } from "./client-webhook-delivery-processor.service.js";
import { ClientWebhookHttpService } from "./client-webhook-http.service.js";

@Module({
  imports: [PrismaModule, ClientWebhookCoreModule],
  providers: [ClientWebhookHttpService, ClientWebhookDeliveryProcessorService],
})
export class ClientWebhookDeliveryModule {}
