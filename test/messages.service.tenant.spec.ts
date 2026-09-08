import { jest } from "@jest/globals";
import { MessageDirection, MessageStatus, MessageType } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { OutboundMessageType } from "../src/messages/dto/create-message.dto.js";
import { MessagesService } from "../src/messages/messages.service.js";

describe("MessagesService tenant isolation", () => {
  const messageCreate = jest.fn<() => Promise<unknown>>();
  const messageFindFirst = jest.fn<() => Promise<unknown>>();
  const outboxCreate = jest.fn<() => Promise<unknown>>();
  const transaction = jest.fn<(callback: (client: unknown) => Promise<unknown>) => Promise<unknown>>();

  const transactionClient = {
    message: { create: messageCreate },
    outboxEvent: { create: outboxCreate },
  };

  const prisma = {
    message: { findFirst: messageFindFirst },
    $transaction: transaction,
  } as unknown as PrismaService;

  const service = new MessagesService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.mockImplementation(async (callback) => callback(transactionClient));
    outboxCreate.mockResolvedValue({});
  });

  it("persists the authenticated tenant ID on outbound messages", async () => {
    const tenantId = "6f9f0438-956d-4e74-bb4c-a56895470aa7";
    messageCreate.mockResolvedValue({
      id: "ada7f3e5-3e99-42d9-87fc-c5318334d0d4",
      tenantId,
      direction: MessageDirection.OUTBOUND,
      type: MessageType.TEXT,
      status: MessageStatus.QUEUED,
      to: "+96170123456",
      idempotencyKey: null,
      payload: { body: "Hello" },
      createdAt: new Date(),
    });

    await service.create(tenantId, {
      to: "+96170123456",
      type: OutboundMessageType.TEXT,
      payload: { body: "Hello" },
    });

    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        direction: MessageDirection.OUTBOUND,
        status: MessageStatus.QUEUED,
        type: MessageType.TEXT,
      }),
    });
    expect(outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: "Message",
        aggregateId: "ada7f3e5-3e99-42d9-87fc-c5318334d0d4",
      }),
    });
  });

  it("queries a message by both tenant ID and message ID", async () => {
    messageFindFirst.mockResolvedValue(null);

    const result = await service.findById(
      "tenant-a-id",
      "e078ff11-f03d-4aa0-bf52-ff1e760cdde7",
    );

    expect(result).toBeNull();
    expect(messageFindFirst).toHaveBeenCalledWith({
      where: {
        id: "e078ff11-f03d-4aa0-bf52-ff1e760cdde7",
        tenantId: "tenant-a-id",
      },
      include: {
        statusEvents: { orderBy: { createdAt: "asc" } },
      },
    });
  });

  it("looks up idempotency keys within the authenticated tenant", async () => {
    const existing = {
      id: "50c6e78a-7446-465d-b4a9-192537851219",
      tenantId: "tenant-b-id",
      idempotencyKey: "logical-message-1",
      status: MessageStatus.QUEUED,
    };
    messageFindFirst.mockResolvedValue(existing);

    const result = await service.create("tenant-b-id", {
      to: "+96170123456",
      type: OutboundMessageType.TEXT,
      payload: { body: "Hello" },
      idempotencyKey: "logical-message-1",
    });

    expect(result).toBe(existing);
    expect(messageFindFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-b-id",
        idempotencyKey: "logical-message-1",
      },
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
