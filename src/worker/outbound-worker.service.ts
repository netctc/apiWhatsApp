import { Injectable, Logger, OnApplicationBootstrap, Optional } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import { OtlpTraceExporterService } from "../observability/otlp-trace-exporter.service.js";
import { TraceContextService } from "../observability/trace-context.service.js";
import {
  MessagingQueueService,
  type OutboundQueueJob,
  type QueueProcessingResult,
} from "../queue/messaging-queue.service.js";
import { MessageDispatcherService } from "./message-dispatcher.service.js";

@Injectable()
export class OutboundWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboundWorkerService.name);

  constructor(
    private readonly queue: MessagingQueueService,
    private readonly dispatcher: MessageDispatcherService,
    @Optional() private readonly traceContext?: TraceContextService,
    @Optional() private readonly otlp?: OtlpTraceExporterService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.consumeOutboundMessages(
      (job) => this.withDispatchTrace(job, () => this.dispatcher.dispatch(job)),
      (job, reason) =>
        this.withWorkerTrace(
          job,
          "whatsapp.outbound.retry_exhausted",
          () => this.dispatcher.markRetryExhausted(job, reason),
          () => ({ result: "exhausted", statusCode: 2 }),
        ),
    );
    this.logger.log("Outbound WhatsApp worker is ready");
  }

  private withDispatchTrace(
    job: OutboundQueueJob,
    callback: () => Promise<QueueProcessingResult>,
  ): Promise<QueueProcessingResult> {
    return this.withWorkerTrace(
      job,
      "whatsapp.outbound.process",
      callback,
      (result) => ({
        result: result.action,
        statusCode: result.action === "retry" || result.action === "dead" ? 2 : 0,
      }),
    );
  }

  private async withWorkerTrace<T>(
    job: OutboundQueueJob,
    spanName: string,
    callback: () => Promise<T>,
    outcome: (result: T) => { result: string; statusCode: 0 | 2 },
  ): Promise<T> {
    const execute = async (): Promise<T> => {
      const trace = this.traceContext?.current();
      const startedAtUnixNano = BigInt(Date.now()) * 1_000_000n;
      const startedAt = performance.now();
      try {
        const result = await callback();
        const completed = outcome(result);
        this.recordWorkerSpan(
          job,
          trace,
          spanName,
          startedAtUnixNano,
          startedAt,
          completed.result,
          completed.statusCode,
        );
        return result;
      } catch (error) {
        this.recordWorkerSpan(
          job,
          trace,
          spanName,
          startedAtUnixNano,
          startedAt,
          "exception",
          2,
        );
        throw error;
      }
    };

    return this.traceContext ? this.traceContext.runFromParent(job.trace, execute) : execute();
  }

  private recordWorkerSpan(
    job: OutboundQueueJob,
    trace: ReturnType<TraceContextService["current"]>,
    spanName: string,
    startedAtUnixNano: bigint,
    startedAt: number,
    result: string,
    statusCode: 0 | 2,
  ): void {
    if (!trace) {
      return;
    }
    const durationNano = BigInt(
      Math.max(0, Math.round((performance.now() - startedAt) * 1_000_000)),
    );
    this.otlp?.recordSpan({
      context: trace,
      name: spanName,
      kind: 5,
      startTimeUnixNano: startedAtUnixNano,
      endTimeUnixNano: startedAtUnixNano + durationNano,
      attributes: {
        "messaging.system": "rabbitmq",
        "messaging.operation.type": "process",
        "app.message.traffic_class": job.trafficClass,
        "app.queue.attempt": job.attempt + 1,
        "app.queue.result": result,
      },
      statusCode,
    });
  }
}
