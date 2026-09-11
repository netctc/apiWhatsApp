import { Module } from "@nestjs/common";
import { InboxEventsModule } from "../inbox-events/inbox-events.module.js";
import { ConversationActivityService } from "./conversation-activity.service.js";
import { ConversationNotesController } from "./conversation-notes.controller.js";
import { ConversationNotesService } from "./conversation-notes.service.js";
import { InboxController } from "./inbox.controller.js";
import { InboxService } from "./inbox.service.js";

@Module({
  imports: [InboxEventsModule],
  controllers: [InboxController, ConversationNotesController],
  providers: [InboxService, ConversationActivityService, ConversationNotesService],
  exports: [InboxService, ConversationActivityService],
})
export class InboxModule {}
