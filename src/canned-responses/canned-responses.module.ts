import { Module } from "@nestjs/common";
import { InboxEventsModule } from "../inbox-events/inbox-events.module.js";
import { CannedResponsesController } from "./canned-responses.controller.js";
import { CannedResponsesService } from "./canned-responses.service.js";

@Module({
  imports: [InboxEventsModule],
  controllers: [CannedResponsesController],
  providers: [CannedResponsesService],
})
export class CannedResponsesModule {}
