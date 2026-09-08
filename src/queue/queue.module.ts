import { Global, Module } from "@nestjs/common";
import { MessagingQueueService } from "./messaging-queue.service.js";

@Global()
@Module({
  providers: [MessagingQueueService],
  exports: [MessagingQueueService],
})
export class QueueModule {}
