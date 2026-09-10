import { jest } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";
import { MessageTrafficClass, MessageType } from "../src/generated/prisma/client.js";
import { OutboundMessageType } from "../src/messages/dto/create-message.dto.js";
import { MessagesService } from "../src/messages/messages.service.js";

describe("MessagesService media validation", () => {
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

  it("rejects invalid image media before opening a persistence transaction", async () => {
    await expect(
      service.create("tenant-1", {
        to: "+96170123456",
        type: OutboundMessageType.IMAGE,
        payload: {
          id: "123",
          link: "https://cdn.example.com/image.jpg",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(transaction).not.toHaveBeenCalled();
    expect(messageCreate).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it("persists a normalized document payload as transactional traffic", async () => {
    messageCreate.mockResolvedValue({ id: "message-1" });

    await service.create("tenant-1", {
      to: "+96170123456",
      type: OutboundMessageType.DOCUMENT,
      payload: {
        id: " 456789 ",
        caption: " Invoice 48291 ",
        filename: " invoice-48291.pdf ",
      },
    });

    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: MessageType.DOCUMENT,
        trafficClass: MessageTrafficClass.TRANSACTIONAL,
        payload: {
          id: "456789",
          caption: "Invoice 48291",
          filename: "invoice-48291.pdf",
        },
      }),
    });
    expect(outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateId: "message-1",
        payload: {
          messageId: "message-1",
          trafficClass: MessageTrafficClass.TRANSACTIONAL,
        },
      }),
    });
    expect(assertApproved).not.toHaveBeenCalled();
  });
});
