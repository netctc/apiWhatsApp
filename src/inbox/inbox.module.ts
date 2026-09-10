import { Module } from "@nestjs/common";
import { ConversationActivityService } from "./conversation-activity.service.js";
import { InboxController } from "./inbox.controller.js";
import { InboxService } from "./inbox.service.js";

@Module({
  controllers: [InboxController],
  providers: [InboxService, ConversationActivityService],
  exports: [InboxService, ConversationActivityService],
})
export class InboxModule {}
