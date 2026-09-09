import { Injectable, Logger, OnApplicationBootstrap, Optional } from "@nestjs/common";
import { TraceContextService } from "../observability/trace-context.service.js";
import {
  MessagingQueueService,
  type OutboundQueueJob,
} from "../queue/messaging-queue.service.js";
import { MessageDispatcherService } from "./message-dispatcher.service.js";

@Injectable()
export class OutboundWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboundWorkerService.name);

  constructor(
    private readonly queue: MessagingQueueService,
    private readonly dispatcher: MessageDispatcherService,
    @Optional() private readonly traceContext?: TraceContextService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.consumeOutboundMessages(
      (job) => this.withTrace(job, () => this.dispatcher.dispatch(job)),
      (job, reason) => this.withTrace(job, () => this.dispatcher.markRetryExhausted(job, reason)),
    );
    this.logger.log("Outbound WhatsApp worker is ready");
  }

  private withTrace<T>(job: OutboundQueueJob, callback: () => T): T {
    return this.traceContext ? this.traceContext.runFromParent(job.trace, callback) : callback();
  }
}
