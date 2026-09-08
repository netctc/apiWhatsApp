import { jest } from "@jest/globals";
import { MessageStatus, MessageType } from "../src/generated/prisma/client.js";
import { MetaSenderResolverService } from "../src/meta/meta-sender-resolver.service.js";
import { MetaWhatsAppClient } from "../src/meta/meta-whatsapp.client.js";
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

  const service = new MessageDispatcherService(prisma, meta, senderResolver, rateLimiter);

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

  it("does not call Meta when another worker owns an active message lease", async () => {
    messageUpdateMany.mockResolvedValue({ count: 0 });
    messageFindUnique.mockResolvedValue({
      id: "fcddeed9-3bcc-4e47-a44c-95179141779a",
      status: MessageStatus.PROCESSING,
      providerMessageId: null,
      processingLeaseUntil: new Date(Date.now() + 30000),
    });

    const result = await service.dispatch({
      messageId: "fcddeed9-3bcc-4e47-a44c-95179141779a",
      attempt: 0,
    });

    expect(result).toEqual({
      action: "retry",
      reason: "Message is currently leased by another worker",
    });
    expect(resolveSender).not.toHaveBeenCalled();
    expect(metaSendMessage).not.toHaveBeenCalled();
    expect(waitForOutboundSlot).not.toHaveBeenCalled();
  });

  it("submits a successfully claimed message through its tenant sender", async () => {
    const message = {
      id: "8da44ab2-41d5-42da-8edc-a2c4cb4d2476",
      tenantId: "123e4567-e89b-12d3-a456-426614174000",
      senderId: "ac91b20f-a54f-4a74-8c87-c09e8a5a3ba5",
      direction: "OUTBOUND",
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
    });

    expect(result).toEqual({ action: "ack" });
    expect(resolveSender).toHaveBeenCalledWith(message.senderId);
    expect(waitForOutboundSlot).toHaveBeenCalledWith(sender.phoneNumberId, 75);
    expect(metaSendMessage).toHaveBeenCalledWith(message, sender);
    expect(messageUpdate).toHaveBeenCalledWith({
      where: { id: message.id },
      data: expect.objectContaining({
        status: MessageStatus.SUBMITTED,
        providerMessageId: "wamid.test-claimed",
        processingLeaseUntil: null,
      }),
    });
  });
});
