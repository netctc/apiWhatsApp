import { jest } from "@jest/globals";
import { MessageStatus } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { WebhookStatusService } from "../src/webhooks/webhook-status.service.js";

describe("WebhookStatusService", () => {
  const messageFindUnique = jest.fn();
  const messageUpdate = jest.fn();
  const statusEventCreate = jest.fn();
  const webhookUpdate = jest.fn();

  const transaction = jest.fn(async (callback: (client: unknown) => Promise<unknown>) =>
    callback({
      messageStatusEvent: { create: statusEventCreate },
      message: { update: messageUpdate },
    }),
  );

  const prisma = {
    message: { findUnique: messageFindUnique },
    webhookEvent: { update: webhookUpdate },
    $transaction: transaction,
  } as unknown as PrismaService;

  const service = new WebhookStatusService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    statusEventCreate.mockResolvedValue({});
    messageUpdate.mockResolvedValue({});
    webhookUpdate.mockResolvedValue({});
  });

  it("advances a delivered message to read using the provider timestamp", async () => {
    messageFindUnique.mockResolvedValue({
      id: "7f6fd8fe-476a-4c7a-af8c-498528ecbf5a",
      status: MessageStatus.DELIVERED,
    });

    await service.processWebhookEvent(
      "7ab3f1da-fd64-42e4-89b6-f028c2591306",
      deliveryPayload("wamid.test-1", "read", "1700000000"),
    );

    expect(statusEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: MessageStatus.READ,
        createdAt: new Date(1700000000 * 1000),
      }),
    });

    expect(messageUpdate).toHaveBeenCalledWith({
      where: { id: "7f6fd8fe-476a-4c7a-af8c-498528ecbf5a" },
      data: expect.objectContaining({
        status: MessageStatus.READ,
        readAt: new Date(1700000000 * 1000),
      }),
    });

    expect(webhookUpdate).toHaveBeenCalledWith({
      where: { id: "7ab3f1da-fd64-42e4-89b6-f028c2591306" },
      data: expect.objectContaining({ processed: true }),
    });
  });

  it("records but does not apply a delayed sent event after the message is already read", async () => {
    messageFindUnique.mockResolvedValue({
      id: "ac196dfc-e62c-4e5b-aeb2-29f1ff6d9095",
      status: MessageStatus.READ,
    });

    await service.processWebhookEvent(
      "4351c373-6491-481a-af8b-ebfb85d7463b",
      deliveryPayload("wamid.test-2", "sent", "1700000001"),
    );

    expect(statusEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: MessageStatus.SENT }),
    });
    expect(messageUpdate).not.toHaveBeenCalled();
    expect(webhookUpdate).toHaveBeenCalled();
  });

  it("persists Meta failure details when a submitted message fails", async () => {
    messageFindUnique.mockResolvedValue({
      id: "fc91b640-d290-42ad-89cc-30f76122098c",
      status: MessageStatus.SUBMITTED,
    });

    const payload = deliveryPayload("wamid.test-3", "failed", "1700000002", [
      {
        code: 131047,
        title: "Re-engagement message",
        error_data: { details: "A template is required outside the customer service window." },
      },
    ]);

    await service.processWebhookEvent("e1ca2912-e4bf-4623-9dca-687242882740", payload);

    expect(messageUpdate).toHaveBeenCalledWith({
      where: { id: "fc91b640-d290-42ad-89cc-30f76122098c" },
      data: expect.objectContaining({
        status: MessageStatus.FAILED,
        errorCode: "131047",
        errorMessage: "Re-engagement message",
        failedAt: new Date(1700000002 * 1000),
      }),
    });
  });
});

function deliveryPayload(id: string, status: string, timestamp: string, errors?: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              statuses: [
                {
                  id,
                  status,
                  timestamp,
                  ...(errors ? { errors } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
