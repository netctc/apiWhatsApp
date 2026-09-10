import { jest } from "@jest/globals";
import { MessageType } from "../src/generated/prisma/client.js";
import { ConversationActivityService } from "../src/inbox/conversation-activity.service.js";

describe("ConversationActivityService", () => {
  const service = new ConversationActivityService();

  it("returns the conversation created or reopened by inbound activity", async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ id: "conversation-1" }]);

    const result = await service.recordInbound(
      { $queryRaw: queryRaw } as never,
      {
        tenantId: "11111111-1111-4111-8111-111111111111",
        senderId: "22222222-2222-4222-8222-222222222222",
        contactId: "33333333-3333-4333-8333-333333333333",
        occurredAt: new Date("2026-09-10T08:00:00.000Z"),
      },
    );

    expect(result).toBe("conversation-1");
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("does not create or reopen inbox conversations for template traffic", async () => {
    const contactFindUnique = jest.fn();
    const queryRaw = jest.fn();

    const result = await service.recordOutbound(
      {
        contact: { findUnique: contactFindUnique },
        $queryRaw: queryRaw,
      } as never,
      {
        tenantId: "tenant-1",
        senderId: "sender-1",
        phone: "96170123456",
        messageType: MessageType.TEMPLATE,
        occurredAt: new Date(),
      },
    );

    expect(result).toBeUndefined();
    expect(contactFindUnique).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("links free-form outbound activity with one atomic monotonic conversation upsert", async () => {
    const contactFindUnique = jest.fn().mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" });
    const queryRaw = jest.fn().mockResolvedValue([{ id: "conversation-1" }]);

    const result = await service.recordOutbound(
      {
        contact: { findUnique: contactFindUnique },
        $queryRaw: queryRaw,
      } as never,
      {
        tenantId: "11111111-1111-4111-8111-111111111111",
        senderId: "22222222-2222-4222-8222-222222222222",
        phone: "96170123456",
        messageType: MessageType.TEXT,
        occurredAt: new Date("2026-09-10T08:30:00.000Z"),
      },
    );

    expect(result).toBe("conversation-1");
    expect(contactFindUnique).toHaveBeenCalledWith({
      where: {
        tenantId_phone: {
          tenantId: "11111111-1111-4111-8111-111111111111",
          phone: "96170123456",
        },
      },
      select: { id: true },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);

    const renderedSql = String(queryRaw.mock.calls[0]?.[0]);
    expect(renderedSql).toContain("ON CONFLICT");
    expect(renderedSql).toContain("GREATEST");
  });

  it("returns undefined when outbound activity has no tenant contact", async () => {
    const contactFindUnique = jest.fn().mockResolvedValue(null);
    const queryRaw = jest.fn();

    const result = await service.recordOutbound(
      {
        contact: { findUnique: contactFindUnique },
        $queryRaw: queryRaw,
      } as never,
      {
        tenantId: "tenant-1",
        senderId: "sender-1",
        phone: "96170123456",
        messageType: MessageType.TEXT,
        occurredAt: new Date(),
      },
    );

    expect(result).toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
