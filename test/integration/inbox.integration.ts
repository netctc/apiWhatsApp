import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createHmac } from "node:crypto";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import {
  ConversationPriority,
  ConversationStatus,
  MessageDirection,
  MessageStatus,
} from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const PHONE = "96171111222";
const API_KEY_HASH_SECRET = "inbox-integration-api-key-hash-secret-0123456789";
const META_APP_SECRET = "inbox-integration-meta-app-secret";

function requireInfrastructure(): void {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for integration tests`);
    }
  }
}

function signedWebhook(
  providerPhoneNumberId: string,
  providerMessageId: string,
  timestamp: string,
  text: string,
): { raw: string; signature: string } {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: `${providerPhoneNumberId}1`,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+961 71 111 222",
                phone_number_id: providerPhoneNumberId,
              },
              contacts: [
                {
                  profile: { name: "Inbox Integration Customer" },
                  wa_id: PHONE,
                },
              ],
              messages: [
                {
                  from: PHONE,
                  id: providerMessageId,
                  timestamp,
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  return {
    raw,
    signature: `sha256=${createHmac("sha256", META_APP_SECRET).update(raw).digest("hex")}`,
  };
}

async function waitForInbound(
  prisma: PrismaService,
  providerMessageId: string,
  timeoutMs = 10000,
): Promise<{ id: string; conversationId: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = await prisma.message.findUnique({
      where: { providerMessageId },
      select: { id: true, conversationId: true, status: true },
    });
    if (message?.conversationId && message.status === MessageStatus.RECEIVED) {
      return { id: message.id, conversationId: message.conversationId };
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for inbound inbox message ${providerMessageId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("agent inbox integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let apiKey: string;
  let senderId: string;
  let providerPhoneNumberId: string;

  beforeAll(async () => {
    requireInfrastructure();

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_APP_SECRET = META_APP_SECRET;
    process.env.META_WEBHOOK_VERIFY_TOKEN = "inbox-integration-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "inbox-integration-meta-access-token";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.inbox.integration.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "250";
    process.env.WEBHOOK_PROCESSOR_INTERVAL_MS = "50";
    process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS = "1000";

    const { AppModule } = await import("../../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `Inbox Integration Tenant ${suffix}`,
        slug: `inbox-integration-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "inbox-integration",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [
          ApiScope.INBOX_READ,
          ApiScope.INBOX_WRITE,
          ApiScope.MESSAGES_READ,
          ApiScope.MESSAGES_WRITE,
        ],
      },
    });

    providerPhoneNumberId = `inbox${Date.now()}`;
    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId,
        wabaId: `${providerPhoneNumberId}1`,
        displayPhoneNumber: "+961 71 111 222",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        active: true,
        isDefault: true,
      },
    });
    senderId = sender.id;
  });

  afterAll(async () => {
    if (prisma && tenantId) {
      const messages = await prisma.message.findMany({
        where: { tenantId },
        select: { id: true },
      });
      const messageIds = messages.map((message) => message.id);
      if (messageIds.length > 0) {
        await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: messageIds } } });
        await prisma.message.deleteMany({ where: { id: { in: messageIds } } });
      }
      await prisma.conversationNote.deleteMany({ where: { tenantId } });
      await prisma.conversation.deleteMany({ where: { tenantId } });
      await prisma.inboxAgent.deleteMany({ where: { tenantId } });
      await prisma.contact.deleteMany({ where: { tenantId } });
      await prisma.whatsAppPhoneNumber.deleteMany({ where: { tenantId } });
      await prisma.auditLog.deleteMany({ where: { tenantId } });
      await prisma.apiKey.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await app?.close();
  });

  it("creates, operates, reopens, and reuses one tenant conversation", async () => {
    const firstProviderMessageId = `wamid.inbox.first.${Date.now()}`;
    const firstTimestamp = String(Math.floor(Date.now() / 1000));
    const firstWebhook = signedWebhook(
      providerPhoneNumberId,
      firstProviderMessageId,
      firstTimestamp,
      "I need help with my order",
    );

    await request(app.getHttpServer())
      .post("/api/v1/webhooks/meta/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", firstWebhook.signature)
      .send(firstWebhook.raw)
      .expect(200);

    const firstInbound = await waitForInbound(prisma, firstProviderMessageId);
    const conversationId = firstInbound.conversationId;

    let conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    expect(conversation.tenantId).toBe(tenantId);
    expect(conversation.senderId).toBe(senderId);
    expect(conversation.status).toBe(ConversationStatus.OPEN);
    expect(conversation.unreadCount).toBe(1);
    expect(conversation.lastInboundAt).not.toBeNull();

    await request(app.getHttpServer())
      .post(`/api/v1/inbox/conversations/${conversationId}/read`)
      .set("X-API-Key", apiKey)
      .expect(201);

    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.unreadCount).toBe(0);

    const agent = await request(app.getHttpServer())
      .post("/api/v1/inbox/agents")
      .set("X-API-Key", apiKey)
      .send({
        name: "Integration Agent",
        externalId: `agent-${Date.now()}`,
        email: "integration-agent@example.com",
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/inbox/conversations/${conversationId}`)
      .set("X-API-Key", apiKey)
      .send({
        assignedAgentId: agent.body.id,
        priority: ConversationPriority.HIGH,
        status: ConversationStatus.PENDING,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/inbox/conversations/${conversationId}/notes`)
      .set("X-API-Key", apiKey)
      .send({ body: "Customer requested expedited handling." })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/inbox/conversations/${conversationId}`)
      .set("X-API-Key", apiKey)
      .send({ status: ConversationStatus.RESOLVED })
      .expect(200);

    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.status).toBe(ConversationStatus.RESOLVED);
    expect(conversation.resolvedAt).not.toBeNull();

    const secondProviderMessageId = `wamid.inbox.second.${Date.now()}`;
    const secondTimestamp = String(Number(firstTimestamp) + 1);
    const secondWebhook = signedWebhook(
      providerPhoneNumberId,
      secondProviderMessageId,
      secondTimestamp,
      "I have one more question",
    );

    await request(app.getHttpServer())
      .post("/api/v1/webhooks/meta/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", secondWebhook.signature)
      .send(secondWebhook.raw)
      .expect(200);

    const secondInbound = await waitForInbound(prisma, secondProviderMessageId);
    expect(secondInbound.conversationId).toBe(conversationId);

    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.status).toBe(ConversationStatus.OPEN);
    expect(conversation.resolvedAt).toBeNull();
    expect(conversation.unreadCount).toBe(1);

    const outbound = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `inbox-outbound-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        senderId,
        type: "TEXT",
        payload: { body: "We are checking that for you now." },
      })
      .expect(202);

    const outboundMessage = await prisma.message.findUniqueOrThrow({
      where: { id: outbound.body.messageId },
    });
    expect(outboundMessage.direction).toBe(MessageDirection.OUTBOUND);
    expect(outboundMessage.conversationId).toBe(conversationId);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/inbox/conversations/${conversationId}`)
      .set("X-API-Key", apiKey)
      .expect(200);
    expect(detail.body.assignedAgent.id).toBe(agent.body.id);
    expect(detail.body.priority).toBe(ConversationPriority.HIGH);
    expect(detail.body.notes).toHaveLength(1);
    expect(detail.body.notes[0].body).toBe("Customer requested expedited handling.");

    const history = await request(app.getHttpServer())
      .get(`/api/v1/inbox/conversations/${conversationId}/messages?limit=10`)
      .set("X-API-Key", apiKey)
      .expect(200);
    expect(history.body.items).toHaveLength(3);
    expect(new Set(history.body.items.map((message: { conversationId?: string }) => message.conversationId))).toEqual(
      new Set([conversationId]),
    );
  });
});
