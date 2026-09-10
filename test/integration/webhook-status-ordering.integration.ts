import {
  MessageDirection,
  MessageStatus,
  MessageType,
} from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import { WebhookStatusService } from "../../src/webhooks/webhook-status.service.js";

function requireDatabase(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
}

function deliveryPayload(id: string, status: string, timestamp: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              statuses: [{ id, status, timestamp }],
            },
          },
        ],
      },
    ],
  };
}

describe("webhook delivery status ordering integration", () => {
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let serviceA: WebhookStatusService;
  let serviceB: WebhookStatusService;
  const messageIds: string[] = [];
  const webhookEventIds: string[] = [];

  beforeAll(async () => {
    requireDatabase();
    prismaA = new PrismaService();
    prismaB = new PrismaService();
    await Promise.all([prismaA.$connect(), prismaB.$connect()]);
    serviceA = new WebhookStatusService(prismaA);
    serviceB = new WebhookStatusService(prismaB);
  });

  afterAll(async () => {
    if (messageIds.length > 0) {
      await prismaA.message.deleteMany({ where: { id: { in: messageIds } } });
    }
    if (webhookEventIds.length > 0) {
      await prismaA.webhookEvent.deleteMany({ where: { id: { in: webhookEventIds } } });
    }
    await Promise.all([prismaA?.$disconnect(), prismaB?.$disconnect()]);
  });

  it("keeps READ authoritative when a delayed SENT webhook arrives afterwards", async () => {
    const providerMessageId = `wamid.ordering.sequential.${Date.now()}`;
    const message = await prismaA.message.create({
      data: {
        direction: MessageDirection.OUTBOUND,
        type: MessageType.TEXT,
        status: MessageStatus.SUBMITTED,
        to: "96170111222",
        providerMessageId,
        payload: { body: "Sequential ordering integration" },
      },
    });
    messageIds.push(message.id);

    const readPayload = deliveryPayload(providerMessageId, "read", "1700000100");
    const sentPayload = deliveryPayload(providerMessageId, "sent", "1700000000");
    const [readEvent, sentEvent] = await Promise.all([
      prismaA.webhookEvent.create({ data: { payload: readPayload } }),
      prismaA.webhookEvent.create({ data: { payload: sentPayload } }),
    ]);
    webhookEventIds.push(readEvent.id, sentEvent.id);

    await serviceA.processWebhookEvent(readEvent.id, readPayload);
    await serviceB.processWebhookEvent(sentEvent.id, sentPayload);

    const persisted = await prismaA.message.findUniqueOrThrow({
      where: { id: message.id },
      include: { statusEvents: { orderBy: { createdAt: "asc" } } },
    });

    expect(persisted.status).toBe(MessageStatus.READ);
    expect(persisted.readAt).toEqual(new Date(1700000100 * 1000));
    expect(persisted.statusEvents.map((event) => event.status)).toEqual([
      MessageStatus.SENT,
      MessageStatus.READ,
    ]);
  });

  it("serializes concurrent READ and delayed SENT transitions across independent Prisma clients", async () => {
    const cases = 20;

    for (let index = 0; index < cases; index += 1) {
      const providerMessageId = `wamid.ordering.concurrent.${Date.now()}.${index}`;
      const message = await prismaA.message.create({
        data: {
          direction: MessageDirection.OUTBOUND,
          type: MessageType.TEXT,
          status: MessageStatus.SUBMITTED,
          to: "96170111222",
          providerMessageId,
          payload: { body: `Concurrent ordering integration ${index}` },
        },
      });
      messageIds.push(message.id);

      const readPayload = deliveryPayload(providerMessageId, "read", String(1700000200 + index));
      const sentPayload = deliveryPayload(providerMessageId, "sent", String(1699999000 + index));
      const [readEvent, sentEvent] = await Promise.all([
        prismaA.webhookEvent.create({ data: { payload: readPayload } }),
        prismaA.webhookEvent.create({ data: { payload: sentPayload } }),
      ]);
      webhookEventIds.push(readEvent.id, sentEvent.id);

      await Promise.all([
        serviceA.processWebhookEvent(readEvent.id, readPayload),
        serviceB.processWebhookEvent(sentEvent.id, sentPayload),
      ]);

      const persisted = await prismaA.message.findUniqueOrThrow({
        where: { id: message.id },
        include: { statusEvents: true },
      });

      expect(persisted.status).toBe(MessageStatus.READ);
      expect(persisted.readAt).toEqual(new Date((1700000200 + index) * 1000));
      expect(persisted.statusEvents).toHaveLength(2);
      expect(new Set(persisted.statusEvents.map((event) => event.status))).toEqual(
        new Set([MessageStatus.SENT, MessageStatus.READ]),
      );
    }
  });
});
