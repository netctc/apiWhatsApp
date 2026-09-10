import { jest } from "@jest/globals";
import { MessageStatus, MessageTrafficClass, MessageType } from "../src/generated/prisma/client.js";
import { MetaSenderResolverService } from "../src/meta/meta-sender-resolver.service.js";
import { MetaWhatsAppClient } from "../src/meta/meta-whatsapp.client.js";
import { TraceContextService } from "../src/observability/trace-context.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { DistributedRateLimiterService } from "../src/worker/distributed-rate-limiter.service.js";
import { MessageDispatcherService } from "../src/worker/message-dispatcher.service.js";

describe("MessageDispatcherService", () => {
  const messageUpdateMany = jest.fn();
  const messageFindUnique = jest.fn();
  const messageUpdate = jest.fn();
  const statusEventCreate = jest.fn();
  const metaSendMessage = jest.fn();
  const resolveSender = jest.fn();
  const waitForOutboundSlot = jest.fn();
  const recordSpan = jest.fn();
  const trace = new TraceContextService();

  const prisma = {
    message: {
      updateMany: messageUpdateMany,
      findUnique: messageFindUnique,
      update: messageUpdate,
    },
    messageStatusEvent: {
      create: statusEventCreate,
    },
  } as unknown as PrismaService;

  const meta = {
    sendMessage: metaSendMessage,
  } as unknown as MetaWhatsAppClient;

  const senderResolver = {
    resolve: resolveSender,
  } as unknown as MetaSenderResolverService;

  const rateLimiter = {
    waitForOutboundSlot,
  } as unknown as DistributedRateLimiterService;

  const service = new MessageDispatcherService(
    prisma,
    meta,
    senderResolver,
    rateLimiter,
    trace,
    { recordSpan } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    statusEventCreate.mockResolvedValue({});
    messageUpdate.mockResolvedValue({});
    waitForOutboundSlot.mockResolvedValue(undefined);
    resolveSender.mockResolvedValue({
      internalSenderId: "ac91b20f-a54f-4a74-8c87-c09e8a5a3ba5",
      phoneNumberId: "27681414235104944",
      accessToken: "test-token",
      rateLimitPerSecond: 75,
    });
  });

  it("does not call Meta or consume retry budget when another worker owns an active message lease", async () => {
    messageUpdateMany.mockResolvedValue({ count: 0 });
    messageFindUnique.mockResolvedValue({
      id: "fcddeed9-3bcc-4e47-a44c-95179141779a",
      status: MessageStatus.PROCESSING,
      providerMessageId: null,
      processingLeaseUntil: new Date(Date.now() + 30000),
    });

    const result = await service.dispatch({
      messageId: "fcddeed9-3bcc-4e47-a44c-95179141779a",
      attempt: 4,
      trafficClass: MessageTrafficClass.TRANSACTIONAL,
    });

    expect(result).toEqual({
      action: "defer",
      reason: "Message is currently leased by another worker",
    });
    expect(resolveSender).not.toHaveBeenCalled();
    expect(metaSendMessage).not.toHaveBeenCalled();
    expect(waitForOutboundSlot).not.toHaveBeenCalled();
    expect(recordSpan).not.toHaveBeenCalled();
  });

  it("submits a successfully claimed message through its tenant sender", async () => {
    const message = claimedMessage();
    const sender = {
      internalSenderId: message.senderId,
      phoneNumberId: "27681414235104944",
      accessToken: "test-token",
      rateLimitPerSecond: 75,
    };

    messageUpdateMany.mockResolvedValue({ count: 1 });
    messageFindUnique.mockResolvedValue(message);
    resolveSender.mockResolvedValue(sender);
    metaSendMessage.mockResolvedValue({
      providerMessageId: "wamid.test-claimed",
      response: { messages: [{ id: "wamid.test-claimed" }] },
    });

    const result = await service.dispatch({
      messageId: message.id,
      attempt: 0,
      trafficClass: MessageTrafficClass.TRANSACTIONAL,
    });

    expect(result).toEqual({ action: "ack" });
    expect(resolveSender).toHaveBeenCalledWith(message.senderId);
    expect(waitForOutboundSlot).toHaveBeenCalledWith(
      sender.phoneNumberId,
      MessageTrafficClass.TRANSACTIONAL,
      75,
    );
    expect(metaSendMessage).toHaveBeenCalledWith(message, sender);
    expect(recordSpan).not.toHaveBeenCalled();
    expect(messageUpdate).toHaveBeenCalledWith({
      where: { id: message.id },
      data: expect.objectContaining({
        status: MessageStatus.SUBMITTED,
        providerMessageId: "wamid.test-claimed",
        processingLeaseUntil: null,
      }),
    });
  });

  it("creates a Meta client child span inside an active worker trace", async () => {
    const message = claimedMessage();
    const sender = {
      internalSenderId: message.senderId,
      phoneNumberId: "27681414235104944",
      accessToken: "test-token",
      rateLimitPerSecond: 75,
    };
    messageUpdateMany.mockResolvedValue({ count: 1 });
    messageFindUnique.mockResolvedValue(message);
    resolveSender.mockResolvedValue(sender);

    let metaTrace: ReturnType<TraceContextService["current"]>;
    metaSendMessage.mockImplementation(async () => {
      metaTrace = trace.current();
      return {
        providerMessageId: "wamid.traced",
        response: { messages: [{ id: "wamid.traced" }] },
      };
    });

    const workerContext = {
      requestId: "req-traced",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "2222222222222222",
      parentSpanId: "1111111111111111",
      traceFlags: "01",
    };
    const result = await trace.run(workerContext, () =>
      service.dispatch({
        messageId: message.id,
        attempt: 0,
        trafficClass: MessageTrafficClass.TRANSACTIONAL,
      }),
    );

    expect(result).toEqual({ action: "ack" });
    expect(metaTrace).toEqual(
      expect.objectContaining({
        traceId: workerContext.traceId,
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        parentSpanId: workerContext.spanId,
        traceFlags: workerContext.traceFlags,
        requestId: workerContext.requestId,
      }),
    );
    expect(metaTrace?.spanId).not.toBe(workerContext.spanId);

    expect(recordSpan).toHaveBeenCalledTimes(1);
    expect(recordSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        context: metaTrace,
        name: "meta.whatsapp send_message",
        kind: 3,
        attributes: {
          "http.request.method": "POST",
          "app.provider": "meta_whatsapp",
          "app.operation": "send_message",
          "app.message.traffic_class": MessageTrafficClass.TRANSACTIONAL,
          "app.meta.result": "success",
        },
        statusCode: 0,
      }),
    );
    const exported = JSON.stringify(
      recordSpan.mock.calls[0]?.[0],
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(exported).not.toContain(message.id);
    expect(exported).not.toContain(message.to);
    expect(exported).not.toContain("Order confirmed");
  });

  it("dead-letters a job whose queue class does not match the persisted message", async () => {
    messageUpdateMany.mockResolvedValue({ count: 1 });
    messageFindUnique.mockResolvedValue({
      id: "0b572713-6bda-4c85-9918-5ebf497f23bc",
      status: MessageStatus.PROCESSING,
      trafficClass: MessageTrafficClass.MARKETING,
      providerMessageId: null,
      processingLeaseUntil: new Date(Date.now() + 30000),
    });

    const result = await service.dispatch({
      messageId: "0b572713-6bda-4c85-9918-5ebf497f23bc",
      attempt: 0,
      trafficClass: MessageTrafficClass.OTP,
    });

    expect(result.action).toBe("dead");
    expect(messageUpdate).toHaveBeenCalledWith({
      where: { id: "0b572713-6bda-4c85-9918-5ebf497f23bc" },
      data: expect.objectContaining({
        status: MessageStatus.FAILED,
        errorCode: "QUEUE_TRAFFIC_CLASS_MISMATCH",
      }),
    });
    expect(resolveSender).not.toHaveBeenCalled();
    expect(waitForOutboundSlot).not.toHaveBeenCalled();
    expect(metaSendMessage).not.toHaveBeenCalled();
    expect(recordSpan).not.toHaveBeenCalled();
  });

  function claimedMessage() {
    return {
      id: "8da44ab2-41d5-42da-8edc-a2c4cb4d2476",
      tenantId: "123e4567-e89b-12d3-a456-426614174000",
      senderId: "ac91b20f-a54f-4a74-8c87-c09e8a5a3ba5",
      direction: "OUTBOUND",
      trafficClass: MessageTrafficClass.TRANSACTIONAL,
      type: MessageType.TEXT,
      status: MessageStatus.PROCESSING,
      to: "+96170123456",
      from: null,
      providerMessageId: null,
      providerTimestamp: null,
      idempotencyKey: "order-48291",
      payload: { body: "Order confirmed" },
      providerResponse: null,
      errorCode: null,
      errorMessage: null,
      attemptCount: 1,
      lastAttemptAt: new Date(),
      processingLeaseUntil: new Date(Date.now() + 30000),
      createdAt: new Date(),
      updatedAt: new Date(),
      submittedAt: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
    };
  }
});
