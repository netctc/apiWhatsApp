import { jest } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import { MessageTrafficClass } from "../src/generated/prisma/client.js";
import { OutboundMessageType } from "../src/messages/dto/create-message.dto.js";
import { MessagesService } from "../src/messages/messages.service.js";

describe("MessagesService template validation", () => {
  const messageFindFirst = jest.fn();
  const messageCreate = jest.fn();
  const outboxCreate = jest.fn();
  const transaction = jest.fn();
  const assertAllowed = jest.fn();
  const resolveForTenant = jest.fn();
  const assertApproved = jest.fn();

  const service = new MessagesService(
    {
      message: { findFirst: messageFindFirst },
      $transaction: transaction,
    } as never,
    { assertAllowed } as never,
    { resolveForTenant } as never,
    { assertApproved } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    messageFindFirst.mockResolvedValue(null);
    assertAllowed.mockResolvedValue(undefined);
    resolveForTenant.mockResolvedValue({ id: "sender-1", wabaId: "waba-1" });
    transaction.mockImplementation(
      async (callback: (client: unknown) => Promise<unknown>) =>
        callback({
          message: { create: messageCreate },
          outboxEvent: { create: outboxCreate },
        }),
    );
    outboxCreate.mockResolvedValue({});
  });

  it("does not create an outbox event when the selected template is not approved", async () => {
    assertApproved.mockRejectedValue(new UnprocessableEntityException("Template not approved"));

    await expect(
      service.create("tenant-1", {
        to: "+96170123456",
        senderId: "sender-1",
        type: OutboundMessageType.TEMPLATE,
        payload: {
          name: "promo_offer",
          language: "en_US",
        },
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(assertApproved).toHaveBeenCalledWith("tenant-1", "waba-1", {
      name: "promo_offer",
      language: "en_US",
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("persists marketing classification in both the message and outbox intent", async () => {
    assertApproved.mockResolvedValue({ category: "MARKETING" });
    messageCreate.mockResolvedValue({
      id: "message-1",
      trafficClass: MessageTrafficClass.MARKETING,
    });

    await service.create("tenant-1", {
      to: "+96170123456",
      senderId: "sender-1",
      type: OutboundMessageType.TEMPLATE,
      payload: {
        name: "promo_offer",
        language: "en_US",
      },
    });

    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trafficClass: MessageTrafficClass.MARKETING,
      }),
    });
    expect(outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateId: "message-1",
        payload: {
          messageId: "message-1",
          trafficClass: MessageTrafficClass.MARKETING,
        },
      }),
    });
  });
});
