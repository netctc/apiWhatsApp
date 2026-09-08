import { Module } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service.js";

@Module({
  providers: [OutboxPublisherService],
})
export class OutboxModule {}
