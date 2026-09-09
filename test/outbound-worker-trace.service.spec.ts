import { jest } from "@jest/globals";
import { MessageTrafficClass } from "../src/generated/prisma/client.js";
import { TraceContextService } from "../src/observability/trace-context.service.js";
import type {
  OutboundQueueJob,
  QueueProcessingResult,
} from "../src/queue/messaging-queue.service.js";
import { OutboundWorkerService } from "../src/worker/outbound-worker.service.js";

describe("OutboundWorkerService trace restoration", () => {
  const consumeOutboundMessages = jest.fn();
  const dispatch = jest.fn();
  const markRetryExhausted = jest.fn();
  const trace = new TraceContextService();

  let handler: ((job: OutboundQueueJob) => Promise<QueueProcessingResult>) | undefined;
  let exhausted: ((job: OutboundQueueJob, reason?: string) => Promise<void>) | undefined;

  const service = new OutboundWorkerService(
    { consumeOutboundMessages } as never,
    { dispatch, markRetryExhausted } as never,
    trace,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    handler = undefined;
    exhausted = undefined;
    consumeOutboundMessages.mockImplementation(
      async (
        nextHandler: (job: OutboundQueueJob) => Promise<QueueProcessingResult>,
        nextExhausted: (job: OutboundQueueJob, reason?: string) => Promise<void>,
      ) => {
        handler = nextHandler;
        exhausted = nextExhausted;
      },
    );
  });

  it("continues the queue carrier trace with a new worker span", async () => {
    let observedTraceId: string | undefined;
    let observedParentSpanId: string | undefined;
    let observedRequestId: string | undefined;
    dispatch.mockImplementation(async () => {
      observedTraceId = trace.current()?.traceId;
      observedParentSpanId = trace.current()?.parentSpanId;
      observedRequestId = trace.current()?.requestId;
      return { action: "ack" };
    });

    await service.onApplicationBootstrap();
    expect(handler).toBeDefined();

    await handler?.({
      messageId: "message-1",
      attempt: 0,
      trafficClass: MessageTrafficClass.TRANSACTIONAL,
      trace: {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        parentSpanId: "00f067aa0ba902b7",
        traceFlags: "01",
        requestId: "req-123",
      },
    });

    expect(observedTraceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(observedParentSpanId).toBe("00f067aa0ba902b7");
    expect(observedRequestId).toBe("req-123");
    expect(exhausted).toBeDefined();
  });
});
