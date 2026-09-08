import { jest } from "@jest/globals";
import { MessageDirection, MessageStatus, MessageType } from "../src/generated/prisma/client.js";
import { InboundMessageService } from "../src/webhooks/inbound-message.service.js";

const TENANT_ID = "123e4567-e89b-12d3-a456-426614174000";
const SENDER_ID = "a5f4b844-1d12-437f-b7e5-702dd592da9d";

describe("InboundMessageService", () => {
  const messageFindUnique = jest.fn();
  const messageCreate = jest.fn();
  const contactUpsert = jest.fn();
  const contactUpdateMany = jest.fn();
  const findByProviderPhoneNumberId = jest.fn();

  const transaction = {
    message: {
      findUnique: messageFindUnique,
      create: messageCreate,
    },
    contact: {
      upsert: contactUpsert,
      updateMany: contactUpdateMany,
    },
  };

  const runTransaction = jest.fn(
    async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction),
  );
  const prisma = {
    $transaction: runTransaction,
    message: { findUnique: messageFindUnique },
  };
  const phoneNumbers = { findByProviderPhoneNumberId };
  const service = new InboundMessageService(prisma as never, phoneNumbers as never);

  beforeEach(() => {
    jest.clearAllMocks();
    findByProviderPhoneNumberId.mockResolvedValue({ id: SENDER_ID, tenantId: TENANT_ID });
    messageFindUnique.mockResolvedValue(null);
    contactUpsert.mockResolvedValue({ id: "contact-1" });
    contactUpdateMany.mockResolvedValue({ count: 1 });
    messageCreate.mockResolvedValue({ id: "message-1" });
  });

  it("resolves the tenant from metadata.phone_number_id and opens a 24-hour service window", async () => {
    const inboundAt = new Date(1700000000 * 1000);
    const expiresAt = new Date(inboundAt.getTime() + 24 * 60 * 60 * 1000);

    await service.process(inboundPayload("wamid.inbound-1", "1700000000"));

    expect(findByProviderPhoneNumberId).toHaveBeenCalledWith("27681414235104944");
    expect(contactUpsert).toHaveBeenCalledWith({
      where: { tenantId_phone: { tenantId: TENANT_ID, phone: "96170123456" } },
      create: expect.objectContaining({
        tenantId: TENANT_ID,
        phone: "96170123456",
        name: "Jane Doe",
        lastInboundAt: inboundAt,
        serviceWindowExpiresAt: expiresAt,
      }),
      update: { name: "Jane Doe" },
    });
    expect(contactUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "contact-1" }),
      data: {
        lastInboundAt: inboundAt,
        serviceWindowExpiresAt: expiresAt,
      },
    });
    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        senderId: SENDER_ID,
        direction: MessageDirection.INBOUND,
        type: MessageType.TEXT,
        status: MessageStatus.RECEIVED,
        from: "96170123456",
        to: "16505553333",
        providerMessageId: "wamid.inbound-1",
        providerTimestamp: inboundAt,
      }),
    });
  });

  it("does not duplicate an inbound provider message", async () => {
    messageFindUnique.mockResolvedValue({ id: "existing-message" });

    await service.process(inboundPayload("wamid.duplicate", "1700000001"));

    expect(contactUpsert).not.toHaveBeenCalled();
    expect(messageCreate).not.toHaveBeenCalled();
  });
});

function inboundPayload(messageId: string, timestamp: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "16505553333",
                phone_number_id: "27681414235104944",
              },
              contacts: [
                {
                  profile: { name: "Jane Doe" },
                  wa_id: "96170123456",
                },
              ],
              messages: [
                {
                  from: "96170123456",
                  id: messageId,
                  timestamp,
                  type: "text",
                  text: { body: "Hello" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
