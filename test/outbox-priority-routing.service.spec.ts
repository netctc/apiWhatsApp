import { jest } from "@jest/globals";
import { MessageTrafficClass } from "../src/generated/prisma/client.js";
import { TraceContextService } from "../src/observability/trace-context.service.js";
import { OutboxPublisherService } from "../src/outbox/outbox-publisher.service.js";

describe("OutboxPublisherService traffic routing", () => {
  const messageFindUnique = jest.fn();
  const outboxUpdate = jest.fn();
  const publishOutboundMessage = jest.fn();
  const recordSpan = jest.fn();
  const traceContext = new TraceContextService();

  const service = new OutboxPublisherService(
    {
      message: { findUnique: messageFindUnique },
      outboxEvent: { update: outboxUpdate },
    } as never,
    { publishOutboundMessage } as never,
    traceContext,
    { recordSpan } as never,
  );

  const privateService = service as unknown as {
    publish(
      eventId: string,
      eventType: string,
      aggregateId: string,
      payload: unknown,
      attempts: number,
    ): Promise<void>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    outboxUpdate.mockResolvedValue({});
    publishOutboundMessage.mockResolvedValue(undefined);
  });

  it("routes legacy outbox payloads using the persisted message class", async () => {
    messageFindUnique.mockResolvedValue({ trafficClass: MessageTrafficClass.OTP });

    await privateService.publish(
      "event-1",
      "message.outbound.requested",
      "message-1",
      { messageId: "message-1" },
      1,
    );

    expect(publishOutboundMessage).toHaveBeenCalledWith("message-1", MessageTrafficClass.OTP);
    expect(recordSpan).not.toHaveBeenCalled();
    expect(outboxUpdate).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: expect.objectContaining({
        processingLeaseUntil: null,
        lastError: null,
      }),
    });
  });

  it("creates a producer child span and passes that child as the queue carrier", async () => {
    messageFindUnique.mockResolvedValue({ trafficClass: MessageTrafficClass.TRANSACTIONAL });
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
      traceFlags: "01",
      requestId: "req-123",
    };

    await privateService.publish(
      "event-trace",
      "message.outbound.requested",
      "message-trace",
      {
        messageId: "message-trace",
        trafficClass: MessageTrafficClass.TRANSACTIONAL,
        trace,
      },
      1,
    );

    expect(publishOutboundMessage).toHaveBeenCalledTimes(1);
    const queueCarrier = publishOutboundMessage.mock.calls[0]?.[2] as {
      traceId: string;
      parentSpanId: string;
      traceFlags: string;
      requestId: string;
    };
    expect(queueCarrier).toEqual({
      traceId: trace.traceId,
      parentSpanId: expect.stringMatching(/^[0-9a-f]{16}$/),
      traceFlags: trace.traceFlags,
      requestId: trace.requestId,
    });
    expect(queueCarrier.parentSpanId).not.toBe(trace.parentSpanId);

    expect(recordSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          traceId: trace.traceId,
          spanId: queueCarrier.parentSpanId,
          parentSpanId: trace.parentSpanId,
          traceFlags: trace.traceFlags,
          requestId: trace.requestId,
        }),
        name: "rabbitmq publish whatsapp.outbound",
        kind: 4,
        attributes: {
          "messaging.system": "rabbitmq",
          "messaging.operation.type": "publish",
          "app.message.traffic_class": MessageTrafficClass.TRANSACTIONAL,
          "app.outbox.result": "success",
        },
        statusCode: 0,
      }),
    );
  });

  it("ignores invalid trace metadata rather than blocking message publication", async () => {
    messageFindUnique.mockResolvedValue({ trafficClass: MessageTrafficClass.TRANSACTIONAL });

    await privateService.publish(
      "event-invalid-trace",
      "message.outbound.requested",
      "message-invalid-trace",
      {
        messageId: "message-invalid-trace",
        trace: { traceId: "invalid" },
      },
      1,
    );

    expect(publishOutboundMessage).toHaveBeenCalledWith(
      "message-invalid-trace",
      MessageTrafficClass.TRANSACTIONAL,
    );
    expect(recordSpan).not.toHaveBeenCalled();
  });

  it("records a failed producer span while preserving normal outbox retry behavior", async () => {
    messageFindUnique.mockResolvedValue({ trafficClass: MessageTrafficClass.OTP });
    publishOutboundMessage.mockRejectedValueOnce(new Error("rabbit unavailable"));

    await privateService.publish(
      "event-producer-failure",
      "message.outbound.requested",
      "message-producer-failure",
      {
        messageId: "message-producer-failure",
        trafficClass: MessageTrafficClass.OTP,
        trace: {
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          parentSpanId: "00f067aa0ba902b7",
          traceFlags: "01",
          requestId: "req-456",
        },
      },
      1,
    );

    expect(recordSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "rabbitmq publish whatsapp.outbound",
        kind: 4,
        attributes: expect.objectContaining({ "app.outbox.result": "error" }),
        statusCode: 2,
      }),
    );
    expect(outboxUpdate).toHaveBeenCalledWith({
      where: { id: "event-producer-failure" },
      data: expect.objectContaining({
        lastError: "rabbit unavailable",
        processingLeaseUntil: null,
      }),
    });
  });

  it("does not publish when outbox JSON disagrees with the persisted class", async () => {
    messageFindUnique.mockResolvedValue({ trafficClass: MessageTrafficClass.MARKETING });

    await privateService.publish(
      "event-2",
      "message.outbound.requested",
      "message-2",
      { messageId: "message-2", trafficClass: MessageTrafficClass.OTP },
      1,
    );

    expect(publishOutboundMessage).not.toHaveBeenCalled();
    expect(outboxUpdate).toHaveBeenCalledWith({
      where: { id: "event-2" },
      data: expect.objectContaining({
        lastError: expect.stringContaining("does not match persisted message class MARKETING"),
        processingLeaseUntil: null,
      }),
    });
  });
});
