import { Module } from "@nestjs/common";
import { InboxEventsController } from "./inbox-events.controller.js";
import { InboxRealtimeService } from "./inbox-realtime.service.js";

@Module({
  controllers: [InboxEventsController],
  providers: [InboxRealtimeService],
  exports: [InboxRealtimeService],
})
export class InboxEventsModule {}
