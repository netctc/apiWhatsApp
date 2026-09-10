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
  const recordSpan = jest.fn();
  const trace = new TraceContextService();

  let handler: ((job: OutboundQueueJob) => Promise<QueueProcessingResult>) | undefined;
  let exhausted: ((job: OutboundQueueJob, reason?: string) => Promise<void>) | undefined;

  const service = new OutboundWorkerService(
    { consumeOutboundMessages } as never,
    { dispatch, markRetryExhausted } as never,
    trace,
    { recordSpan } as never,
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

  it("continues the queue carrier trace with a new exported worker span", async () => {
    let observedTraceId: string | undefined;
    let observedSpanId: string | undefined;
    let observedParentSpanId: string | undefined;
    let observedRequestId: string | undefined;
    dispatch.mockImplementation(async () => {
      observedTraceId = trace.current()?.traceId;
      observedSpanId = trace.current()?.spanId;
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
    expect(observedSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(observedParentSpanId).toBe("00f067aa0ba902b7");
    expect(observedRequestId).toBe("req-123");
    expect(recordSpan).toHaveBeenCalledTimes(1);
    expect(recordSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: observedSpanId,
          parentSpanId: "00f067aa0ba902b7",
        }),
        name: "whatsapp.outbound.process",
        kind: 5,
        attributes: {
          "messaging.system": "rabbitmq",
          "messaging.operation.type": "process",
          "app.message.traffic_class": MessageTrafficClass.TRANSACTIONAL,
          "app.queue.attempt": 1,
          "app.queue.result": "ack",
        },
        statusCode: 0,
      }),
    );
    expect(exhausted).toBeDefined();
  });
});
