import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { ClientWebhookCoreModule } from "./client-webhook-core.module.js";
import { ClientWebhooksController } from "./client-webhooks.controller.js";
import { ClientWebhooksService } from "./client-webhooks.service.js";

@Module({
  imports: [PrismaModule, ClientWebhookCoreModule],
  controllers: [ClientWebhooksController],
  providers: [ClientWebhooksService],
})
export class ClientWebhooksModule {}
