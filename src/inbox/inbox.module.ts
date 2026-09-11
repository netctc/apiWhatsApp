import { Module } from "@nestjs/common";
import { InboxEventsModule } from "../inbox-events/inbox-events.module.js";
import { ConversationActivityService } from "./conversation-activity.service.js";
import { ConversationNotesController } from "./conversation-notes.controller.js";
import { ConversationNotesService } from "./conversation-notes.service.js";
import { InboxController } from "./inbox.controller.js";
import { InboxService } from "./inbox.service.js";
import { InboxTeamsController } from "./inbox-teams.controller.js";
import { InboxTeamsService } from "./inbox-teams.service.js";

@Module({
  imports: [InboxEventsModule],
  controllers: [InboxController, ConversationNotesController, InboxTeamsController],
  providers: [InboxService, ConversationActivityService, ConversationNotesService, InboxTeamsService],
  exports: [InboxService, ConversationActivityService, InboxTeamsService],
})
export class InboxModule {}
