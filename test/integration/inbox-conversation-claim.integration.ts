import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import type { InboxRealtimeEvent } from "../../src/inbox-events/inbox-event.types.js";
import { InboxRealtimeService } from "../../src/inbox-events/inbox-realtime.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "inbox-claim-integration-secret-0123456789abcdef";
const claimRoute = (id: string) => `/api/v1/inbox/conversations/${id}/claim`;
const releaseRoute = (id: string) => `/api/v1/inbox/conversations/${id}/release`;
const conversationRoute = (id: string) => `/api/v1/inbox/conversations/${id}`;

describe("inbox conversation claim and release integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let realtime: InboxRealtimeService;
  const tenantIds: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let senderA: string;
  let conversationA: string;
  let foreignConversation: string;
  let agentA: string;
  let agentB: string;
  let inactiveAgent: string;
  let foreignAgent: string;
  let writerKey: string;
  let readerKey: string;
  const originalEnv = new Map<string, string | undefined>();

  async function createKey(tenantId: string, scopes: string[]) {
    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "Inbox claim integration key",
        prefix: generated.prefix,
        keyHash: hashApiKey(generated.rawKey, HASH_SECRET),
        scopes,
      },
    });
    return generated.rawKey;
  }

  async function createConversation(tenantId: string, senderId: string) {
    const contact = await prisma.contact.create({
      data: { tenantId, phone: `claim-${randomUUID()}` },
    });
    return prisma.conversation.create({
      data: {
        tenantId,
        senderId,
        contactId: contact.id,
        lastMessageAt: new Date(),
      },
    });
  }

  function post(path: string, key: string, agentId: string) {
    return request(app.getHttpServer())
      .post(path)
      .set("X-API-Key", key)
      .send({ agentId });
  }

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required for integration tests`);
    }
    const env = {
      NODE_ENV: "test",
      API_KEY_HASH_SECRET: HASH_SECRET,
      OUTBOUND_QUEUE_NAME: `whatsapp.inbox-claim.${randomUUID()}`,
      OUTBOX_POLL_INTERVAL_MS: "60000",
      WEBHOOK_PROCESSOR_INTERVAL_MS: "60000",
      CAMPAIGN_PROCESSOR_INTERVAL_MS: "60000",
    };
    for (const [name, value] of Object.entries(env)) {
      originalEnv.set(name, process.env[name]);
      process.env[name] = value;
    }

    const { AppModule } = await import("../../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
    realtime = app.get(InboxRealtimeService);

    for (let index = 0; index < 2; index += 1) {
      const tenant = await prisma.tenant.create({
        data: { name: "Inbox claim tenant", slug: `inbox-claim-${randomUUID()}` },
      });
      tenantIds.push(tenant.id);
    }
    [tenantA, tenantB] = tenantIds;

    const senderRows = [];
    for (const tenantId of tenantIds) {
      senderRows.push(await prisma.whatsAppPhoneNumber.create({
        data: {
          tenantId,
          providerPhoneNumberId: `claim-${randomUUID()}`,
          credentialRef: "env:INBOX_CLAIM_UNUSED_TOKEN",
          active: true,
        },
      }));
    }
    senderA = senderRows[0].id;
    conversationA = (await createConversation(tenantA, senderA)).id;
    foreignConversation = (await createConversation(tenantB, senderRows[1].id)).id;

    const agents = await Promise.all([
      prisma.inboxAgent.create({ data: { tenantId: tenantA, name: "Agent A" } }),
      prisma.inboxAgent.create({ data: { tenantId: tenantA, name: "Agent B" } }),
      prisma.inboxAgent.create({ data: { tenantId: tenantA, name: "Inactive Agent", active: false } }),
      prisma.inboxAgent.create({ data: { tenantId: tenantB, name: "Foreign Agent" } }),
    ]);
    [agentA, agentB, inactiveAgent, foreignAgent] = agents.map((agent) => agent.id);

    writerKey = await createKey(tenantA, [ApiScope.INBOX_WRITE]);
    readerKey = await createKey(tenantA, [ApiScope.INBOX_READ]);
  });

  beforeEach(async () => {
    await prisma.conversation.update({
      where: { id: conversationA },
      data: { assignedAgentId: null },
    });
    await prisma.auditLog.deleteMany({
      where: {
        tenantId: tenantA,
        entityType: "Conversation",
        entityId: conversationA,
        action: { in: ["inbox.conversation.claimed", "inbox.conversation.released"] },
      },
    });
  });

  afterAll(async () => {
    if (prisma && tenantIds.length > 0) {
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (app) await app.close();
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("allows exactly one winner when two active agents claim concurrently", async () => {
    const [left, right] = await Promise.all([
      post(claimRoute(conversationA), writerKey, agentA),
      post(claimRoute(conversationA), writerKey, agentB),
    ]);

    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const winner = left.status === 200 ? left : right;
    const loser = left.status === 409 ? left : right;
    expect([agentA, agentB]).toContain(winner.body.assignedAgentId);
    expect(loser.body.message).toBe("Conversation is already assigned to another inbox agent");

    const persisted = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationA } });
    expect(persisted.assignedAgentId).toBe(winner.body.assignedAgentId);
    expect(await prisma.auditLog.count({
      where: { tenantId: tenantA, entityId: conversationA, action: "inbox.conversation.claimed" },
    })).toBe(1);
  });

  it("emits realtime and audit records only when claim or release changes assignment", async () => {
    const events: InboxRealtimeEvent[] = [];
    const unsubscribe = await realtime.subscribe(tenantA, (event) => {
      if (event.type === "conversation.updated" && event.data.conversationId === conversationA) {
        events.push(event);
      }
    });

    try {
      await post(claimRoute(conversationA), writerKey, agentA).expect(200);
      await post(claimRoute(conversationA), writerKey, agentA).expect(200);
      await post(releaseRoute(conversationA), writerKey, agentA).expect(200);
      await post(releaseRoute(conversationA), writerKey, agentA).expect(200);
      await waitFor(() => events.length >= 2);
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(2);
    expect(events[0].data.assignedAgentId).toBe(agentA);
    expect(events[1].data.assignedAgentId).toBeNull();
    expect(await prisma.auditLog.count({
      where: { tenantId: tenantA, entityId: conversationA, action: "inbox.conversation.claimed" },
    })).toBe(1);
    expect(await prisma.auditLog.count({
      where: { tenantId: tenantA, entityId: conversationA, action: "inbox.conversation.released" },
    })).toBe(1);
  });

  it("rejects inactive or foreign agents and prevents another agent from releasing the holder", async () => {
    await post(claimRoute(conversationA), writerKey, inactiveAgent).expect(422);
    await post(claimRoute(conversationA), writerKey, foreignAgent).expect(422);

    await post(claimRoute(conversationA), writerKey, agentA).expect(200);
    const conflict = await post(releaseRoute(conversationA), writerKey, agentB).expect(409);
    expect(conflict.body.message).toBe("Conversation is assigned to another inbox agent");

    const persisted = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationA } });
    expect(persisted.assignedAgentId).toBe(agentA);
  });

  it("keeps cross-tenant conversations indistinguishable from missing conversations", async () => {
    await post(claimRoute(foreignConversation), writerKey, agentA).expect(404);
    await post(releaseRoute(foreignConversation), writerKey, agentA).expect(404);
  });

  it("requires inbox:write and validates the agent identifier", async () => {
    await post(claimRoute(conversationA), readerKey, agentA).expect(403);
    await request(app.getHttpServer())
      .post(claimRoute(conversationA))
      .set("X-API-Key", writerKey)
      .send({ agentId: "not-a-uuid" })
      .expect(400);
  });

  it("preserves explicit administrative reassignment after a cooperative claim", async () => {
    await post(claimRoute(conversationA), writerKey, agentA).expect(200);

    const reassigned = await request(app.getHttpServer())
      .patch(conversationRoute(conversationA))
      .set("X-API-Key", writerKey)
      .send({ assignedAgentId: agentB })
      .expect(200);

    expect(reassigned.body.assignedAgentId).toBe(agentB);
    const persisted = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationA } });
    expect(persisted.assignedAgentId).toBe(agentB);
  });

  it("serializes a cooperative claim against administrative reassignment without losing the admin update", async () => {
    const [claim, admin] = await Promise.all([
      post(claimRoute(conversationA), writerKey, agentA),
      request(app.getHttpServer())
        .patch(conversationRoute(conversationA))
        .set("X-API-Key", writerKey)
        .send({ assignedAgentId: agentB }),
    ]);

    expect(admin.status).toBe(200);
    expect([200, 409]).toContain(claim.status);
    const persisted = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationA } });
    expect(persisted.assignedAgentId).toBe(agentB);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for realtime inbox event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
