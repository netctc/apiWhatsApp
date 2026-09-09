import { Module } from "@nestjs/common";
import { MessagesModule } from "../messages/messages.module.js";
import { PhoneNumbersModule } from "../phone-numbers/phone-numbers.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { SegmentsModule } from "../segments/segments.module.js";
import { TemplatesModule } from "../templates/templates.module.js";
import { CampaignAnalyticsService } from "./campaign-analytics.service.js";
import { CampaignProcessorService } from "./campaign-processor.service.js";
import { CampaignsController } from "./campaigns.controller.js";
import { CampaignsService } from "./campaigns.service.js";

@Module({
  imports: [PrismaModule, PhoneNumbersModule, TemplatesModule, SegmentsModule, MessagesModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignAnalyticsService, CampaignProcessorService],
  exports: [CampaignsService, CampaignAnalyticsService],
})
export class CampaignsModule {}
