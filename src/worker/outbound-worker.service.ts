import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { MessagingQueueService } from "../queue/messaging-queue.service.js";
import { MessageDispatcherService } from "./message-dispatcher.service.js";

@Injectable()
export class OutboundWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboundWorkerService.name);

  constructor(
    private readonly queue: MessagingQueueService,
    private readonly dispatcher: MessageDispatcherService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.consumeOutboundMessages(
      (job) => this.dispatcher.dispatch(job),
      (job, reason) => this.dispatcher.markRetryExhausted(job, reason),
    );
    this.logger.log("Outbound WhatsApp worker is ready");
  }
}
