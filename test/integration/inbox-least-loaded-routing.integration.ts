import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConversationStatus } from "../../src/generated/prisma/client.js";
import type { InboxRealtimeEvent } from "../../src/inbox-events/inbox-event.types.js";
import { InboxRealtimeService } from "../../src/inbox-events/inbox-realtime.service.js";
import { InboxService } from "../../src/inbox/inbox.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "least-loaded-routing-integration-secret-0123456789abcdef";
const routePath = (id: string) => `/api/v1/inbox/conversations/${id}/route`;

describe("inbox least-loaded routing integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let inbox: InboxService;
  let realtime: InboxRealtimeService;
  let tenantId: string;
  let senderId: string;
  let teamId: string;
  let lowerAgentId: string;
  let higherAgentId: string;
  let writerKey: string;
  let readerKey: string;
  const originalEnv = new Map<string, string | undefined>();

  async function createKey(scopes: string[]) {
    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "Least-loaded routing integration key",
        prefix: generated.prefix,
        keyHash: hashApiKey(generated.rawKey, HASH_SECRET),
        scopes,
      },
    });
    return generated.rawKey;
  }

  async function createConversation(options: {
    assignedAgentId?: string | null;
    status?: ConversationStatus;
    assignTeam?: boolean;
  } = {}) {
    const contact = await prisma.contact.create({
      data: { tenantId, phone: `least-route-${randomUUID()}` },
    });
    const conversation = await prisma.conversation.create({
      data: {
        tenantId,
        senderId,
        contactId: contact.id,
        assignedAgentId: options.assignedAgentId ?? null,
        status: options.status ?? ConversationStatus.OPEN,
        lastMessageAt: new Date(),
      },
    });
    if (options.assignTeam) {
      await prisma.conversationTeamAssignment.create({
        data: { tenantId, conversationId: conversation.id, teamId },
      });
    }
    return conversation.id;
  }

  function route(conversationId: string, key = writerKey) {
    return request(app.getHttpServer())
      .post(routePath(conversationId))
      .set("X-API-Key", key);
  }

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required for integration tests`);
    }
    const env = {
      NODE_ENV: "test",
      API_KEY_HASH_SECRET: HASH_SECRET,
      OUTBOUND_QUEUE_NAME: `whatsapp.least-loaded-routing.${randomUUID()}`,
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
    inbox = app.get(InboxService);
    realtime = app.get(InboxRealtimeService);

    const tenant = await prisma.tenant.create({
      data: { name: "Least-loaded routing tenant", slug: `least-loaded-routing-${randomUUID()}` },
    });
    tenantId = tenant.id;

    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId: `least-loaded-routing-${randomUUID()}`,
        credentialRef: "env:LEAST_LOADED_ROUTING_UNUSED_TOKEN",
        active: true,
      },
    });
    senderId = sender.id;

    const team = await prisma.inboxTeam.create({
      data: { tenantId, name: "Least-loaded Support" },
    });
    teamId = team.id;

    const agents = await Promise.all([
      prisma.inboxAgent.create({ data: { tenantId, name: "Least-loaded Agent One" } }),
      prisma.inboxAgent.create({ data: { tenantId, name: "Least-loaded Agent Two" } }),
    ]);
    [lowerAgentId, higherAgentId] = agents.map((agent) => agent.id).sort();

    writerKey = await createKey([ApiScope.INBOX_WRITE]);
    readerKey = await createKey([ApiScope.INBOX_READ]);
  });

  beforeEach(async () => {
    await prisma.conversation.deleteMany({ where: { tenantId } });
    await prisma.contact.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId, action: "inbox.conversation.routed" } });
    await prisma.inboxTeamMember.deleteMany({ where: { tenantId, teamId } });
    await prisma.inboxAgent.updateMany({ where: { tenantId }, data: { active: true } });
    await prisma.inboxTeam.update({ where: { id: teamId }, data: { active: true } });
    await prisma.inboxTeamMember.createMany({
      data: [
        { tenantId, teamId, agentId: lowerAgentId },
        { tenantId, teamId, agentId: higherAgentId },
      ],
    });
  });

  afterAll(async () => {
    if (prisma && tenantId) {
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    if (app) await app.close();
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("routes to the active team member with the lowest unresolved tenant workload", async () => {
    await createConversation({ assignedAgentId: lowerAgentId, status: ConversationStatus.OPEN });
    await createConversation({ assignedAgentId: lowerAgentId, status: ConversationStatus.PENDING });
    await createConversation({ assignedAgentId: higherAgentId, status: ConversationStatus.PENDING });
    await createConversation({ assignedAgentId: higherAgentId, status: ConversationStatus.RESOLVED });
    const targetId = await createConversation({ assignTeam: true });

    const response = await route(targetId).expect(200);

    expect(response.body.assignedAgentId).toBe(higherAgentId);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId, action: "inbox.conversation.routed", entityId: targetId },
    });
    expect(audit.metadata).toMatchObject({
      strategy: "least_open_pending",
      eligibleAgents: 2,
      selectedLoad: 1,
      assigned: true,
    });
  });

  it("breaks an equal workload tie by ascending agent ID", async () => {
    const targetId = await createConversation({ assignTeam: true });

    const response = await route(targetId).expect(200);

    expect(response.body.assignedAgentId).toBe(lowerAgentId);
  });

  it("serializes two concurrent routes for one team so equal-load agents split the work", async () => {
    const firstId = await createConversation({ assignTeam: true });
    const secondId = await createConversation({ assignTeam: true });

    const [first, second] = await Promise.all([
      route(firstId).expect(200),
      route(secondId).expect(200),
    ]);

    expect(new Set([first.body.assignedAgentId, second.body.assignedAgentId]))
      .toEqual(new Set([lowerAgentId, higherAgentId]));
  });

  it("publishes the selected agent and team through the existing realtime event after a changed route", async () => {
    const targetId = await createConversation({ assignTeam: true });
    let resolveEvent: (event: InboxRealtimeEvent) => void = () => undefined;
    let rejectEvent: (error: Error) => void = () => undefined;
    const eventPromise = new Promise<InboxRealtimeEvent>((resolve, reject) => {
      resolveEvent = resolve;
      rejectEvent = reject;
    });
    const timeout = setTimeout(() => rejectEvent(new Error("Timed out waiting for routing realtime event")), 3000);
    timeout.unref();
    const unsubscribe = await realtime.subscribe(tenantId, (event) => {
      if (event.type === "conversation.updated" && event.data.conversationId === targetId) {
        clearTimeout(timeout);
        resolveEvent(event);
      }
    });

    try {
      const response = await route(targetId).expect(200);
      const event = await eventPromise;
      expect(event.data).toMatchObject({
        conversationId: targetId,
        assignedAgentId: response.body.assignedAgentId,
        assignedTeamId: teamId,
      });
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }
  });

  it("returns an already assigned conversation unchanged without a routing audit write", async () => {
    const targetId = await createConversation({ assignedAgentId: higherAgentId, assignTeam: true });

    const response = await route(targetId).expect(200);

    expect(response.body.assignedAgentId).toBe(higherAgentId);
    expect(await prisma.auditLog.count({
      where: { tenantId, action: "inbox.conversation.routed", entityId: targetId },
    })).toBe(0);
  });

  it("rejects routing when no team is assigned", async () => {
    const targetId = await createConversation();

    const response = await route(targetId).expect(422);

    expect(response.body.message).toBe("Conversation must be assigned to an inbox team before automatic routing");
  });

  it("rejects an inactive assigned team", async () => {
    const targetId = await createConversation({ assignTeam: true });
    await prisma.inboxTeam.update({ where: { id: teamId }, data: { active: false } });

    const response = await route(targetId).expect(422);

    expect(response.body.message).toBe("Assigned inbox team is not active in this tenant");
  });

  it("rejects a team with no active routing members", async () => {
    const targetId = await createConversation({ assignTeam: true });
    await prisma.inboxAgent.updateMany({ where: { id: { in: [lowerAgentId, higherAgentId] } }, data: { active: false } });

    const response = await route(targetId).expect(422);

    expect(response.body.message).toBe("Assigned inbox team has no active routing members");
  });

  it("requires inbox:write scope", async () => {
    const targetId = await createConversation({ assignTeam: true });
    await route(targetId, readerKey).expect(403);
  });

  it("rolls back the selected assignment when audit persistence fails", async () => {
    const targetId = await createConversation({ assignTeam: true });

    await expect(inbox.routeConversation({
      tenantId,
      apiKeyId: randomUUID(),
      scopes: [ApiScope.INBOX_WRITE],
    }, targetId)).rejects.toBeDefined();

    const persisted = await prisma.conversation.findUniqueOrThrow({ where: { id: targetId } });
    expect(persisted.assignedAgentId).toBeNull();
  });
});
