import { Module } from "@nestjs/common";
import { InboxEventsModule } from "../inbox-events/inbox-events.module.js";
import { ConversationActivityService } from "./conversation-activity.service.js";
import { ConversationNotesController } from "./conversation-notes.controller.js";
import { ConversationNotesService } from "./conversation-notes.service.js";
import { InboxConversationSkillsController } from "./inbox-conversation-skills.controller.js";
import { InboxConversationSkillsService } from "./inbox-conversation-skills.service.js";
import { InboxController } from "./inbox.controller.js";
import { InboxService } from "./inbox.service.js";
import { InboxResponseSlaEscalationService } from "./inbox-response-sla-escalation.service.js";
import { InboxSkillsController } from "./inbox-skills.controller.js";
import { InboxSkillsService } from "./inbox-skills.service.js";
import { InboxTeamsController } from "./inbox-teams.controller.js";
import { InboxTeamsService } from "./inbox-teams.service.js";

@Module({
  imports: [InboxEventsModule],
  controllers: [
    InboxController,
    ConversationNotesController,
    InboxTeamsController,
    InboxSkillsController,
    InboxConversationSkillsController,
  ],
  providers: [
    InboxService,
    ConversationActivityService,
    InboxResponseSlaEscalationService,
    ConversationNotesService,
    InboxTeamsService,
    InboxSkillsService,
    InboxConversationSkillsService,
  ],
  exports: [
    InboxService,
    ConversationActivityService,
    InboxResponseSlaEscalationService,
    InboxTeamsService,
    InboxSkillsService,
    InboxConversationSkillsService,
  ],
})
export class InboxModule {}
