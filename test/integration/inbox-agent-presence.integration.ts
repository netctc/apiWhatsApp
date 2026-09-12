import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import {
  ConversationStatus,
  InboxAgentPresenceStatus,
} from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "inbox-agent-presence-integration-secret-0123456789abcdef";

describe("inbox agent presence integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let senderId: string;
  let teamId: string;
  let agentA: string;
  let agentB: string;
  let writerKey: string;
  const originalEnv = new Map<string, string | undefined>();

  const conversationPath = (id: string) => `/api/v1/inbox/conversations/${id}`;
  const claimPath = (id: string) => `/api/v1/inbox/conversations/${id}/claim`;
  const routePath = (id: string) => `/api/v1/inbox/conversations/${id}/route`;
  const releasePath = (id: string) => `/api/v1/inbox/conversations/${id}/release`;
  const agentPath = (id: string) => `/api/v1/inbox/agents/${id}`;

  async function createConversation(options: {
    assignedAgentId?: string | null;
    status?: ConversationStatus;
    assignTeam?: boolean;
  } = {}) {
    const contact = await prisma.contact.create({
      data: { tenantId, phone: `presence-${randomUUID()}` },
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

  function patchConversation(id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(conversationPath(id))
      .set("X-API-Key", writerKey)
      .send(body);
  }

  function claim(id: string, targetAgentId: string) {
    return request(app.getHttpServer())
      .post(claimPath(id))
      .set("X-API-Key", writerKey)
      .send({ agentId: targetAgentId });
  }

  function route(id: string) {
    return request(app.getHttpServer())
      .post(routePath(id))
      .set("X-API-Key", writerKey);
  }

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required for integration tests`);
    }
    const env = {
      NODE_ENV: "test",
      API_KEY_HASH_SECRET: HASH_SECRET,
      OUTBOUND_QUEUE_NAME: `whatsapp.inbox-agent-presence.${randomUUID()}`,
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

    const tenant = await prisma.tenant.create({
      data: { name: "Inbox agent presence tenant", slug: `inbox-agent-presence-${randomUUID()}` },
    });
    tenantId = tenant.id;

    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId: `inbox-agent-presence-${randomUUID()}`,
        credentialRef: "env:INBOX_AGENT_PRESENCE_UNUSED_TOKEN",
        active: true,
      },
    });
    senderId = sender.id;

    const team = await prisma.inboxTeam.create({
      data: { tenantId, name: "Presence Support" },
    });
    teamId = team.id;

    const agents = await Promise.all([
      prisma.inboxAgent.create({ data: { tenantId, name: "Presence Agent A" } }),
      prisma.inboxAgent.create({ data: { tenantId, name: "Presence Agent B" } }),
    ]);
    [agentA, agentB] = agents.map((agent) => agent.id).sort();

    const generated = generateApiKey();
    writerKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "Inbox presence integration key",
        prefix: generated.prefix,
        keyHash: hashApiKey(generated.rawKey, HASH_SECRET),
        scopes: [ApiScope.INBOX_READ, ApiScope.INBOX_WRITE],
      },
    });
  });

  beforeEach(async () => {
    await prisma.conversation.deleteMany({ where: { tenantId } });
    await prisma.contact.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.inboxTeamMember.deleteMany({ where: { tenantId, teamId } });
    await prisma.inboxAgent.deleteMany({
      where: { tenantId, id: { notIn: [agentA, agentB] } },
    });
    await prisma.inboxAgent.updateMany({
      where: { tenantId, id: { in: [agentA, agentB] } },
      data: {
        active: true,
        presenceStatus: InboxAgentPresenceStatus.AVAILABLE,
        maxConcurrentConversations: null,
      },
    });
    await prisma.inboxTeam.update({ where: { id: teamId }, data: { active: true } });
    await prisma.inboxTeamMember.createMany({
      data: [
        { tenantId, teamId, agentId: agentA },
        { tenantId, teamId, agentId: agentB },
      ],
    });
  });

  afterAll(async () => {
    if (prisma && tenantId) {
      await prisma.conversation.deleteMany({ where: { tenantId } });
      await prisma.contact.deleteMany({ where: { tenantId } });
      await prisma.inboxTeamMember.deleteMany({ where: { tenantId } });
      await prisma.inboxTeam.deleteMany({ where: { tenantId } });
      await prisma.inboxAgent.deleteMany({ where: { tenantId } });
      await prisma.whatsAppPhoneNumber.deleteMany({ where: { tenantId } });
      await prisma.auditLog.deleteMany({ where: { tenantId } });
      await prisma.apiKey.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    if (app) await app.close();
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("defaults new agents to AVAILABLE and refreshes presenceUpdatedAt on explicit presence writes", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/inbox/agents")
      .set("X-API-Key", writerKey)
      .send({ name: "Presence API Agent" })
      .expect(201);

    expect(created.body.presenceStatus).toBe(InboxAgentPresenceStatus.AVAILABLE);
    expect(typeof created.body.presenceUpdatedAt).toBe("string");
    const initialTimestamp = Date.parse(created.body.presenceUpdatedAt);
    expect(Number.isFinite(initialTimestamp)).toBe(true);

    await delay(5);
    const away = await request(app.getHttpServer())
      .patch(agentPath(created.body.id))
      .set("X-API-Key", writerKey)
      .send({ presenceStatus: InboxAgentPresenceStatus.AWAY })
      .expect(200);
    expect(away.body.presenceStatus).toBe(InboxAgentPresenceStatus.AWAY);
    expect(Date.parse(away.body.presenceUpdatedAt)).toBeGreaterThan(initialTimestamp);

    const listed = await request(app.getHttpServer())
      .get("/api/v1/inbox/agents")
      .set("X-API-Key", writerKey)
      .expect(200);
    expect(listed.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: created.body.id,
        presenceStatus: InboxAgentPresenceStatus.AWAY,
      }),
    ]));

    await request(app.getHttpServer())
      .patch(agentPath(created.body.id))
      .set("X-API-Key", writerKey)
      .send({ presenceStatus: "BUSY" })
      .expect(400);
  });

  it("rejects a new administrative assignment while the target is AWAY and admits it once AVAILABLE", async () => {
    await prisma.inboxAgent.update({
      where: { id: agentA },
      data: { presenceStatus: InboxAgentPresenceStatus.AWAY },
    });
    const targetId = await createConversation();

    const rejected = await patchConversation(targetId, { assignedAgentId: agentA }).expect(422);
    expect(rejected.body.message).toBe("Assigned inbox agent is not available for new conversations");

    await prisma.inboxAgent.update({
      where: { id: agentA },
      data: { presenceStatus: InboxAgentPresenceStatus.AVAILABLE },
    });
    const admitted = await patchConversation(targetId, { assignedAgentId: agentA }).expect(200);
    expect(admitted.body.assignedAgentId).toBe(agentA);
  });

  it("rejects new claims while OFFLINE but keeps a repeat-holder claim idempotent", async () => {
    await prisma.inboxAgent.update({
      where: { id: agentA },
      data: { presenceStatus: InboxAgentPresenceStatus.OFFLINE },
    });
    const unassignedId = await createConversation();

    const rejected = await claim(unassignedId, agentA).expect(422);
    expect(rejected.body.message).toBe("Inbox agent is not available for new conversations");

    const heldId = await createConversation({ assignedAgentId: agentA });
    const repeated = await claim(heldId, agentA).expect(200);
    expect(repeated.body.assignedAgentId).toBe(agentA);
    expect(await prisma.auditLog.count({
      where: { tenantId, action: "inbox.conversation.claimed", entityId: heldId },
    })).toBe(0);
  });

  it("excludes unavailable members before least-load selection", async () => {
    await prisma.inboxAgent.update({
      where: { id: agentB },
      data: { presenceStatus: InboxAgentPresenceStatus.AWAY },
    });
    await createConversation({ assignedAgentId: agentA, status: ConversationStatus.OPEN });
    await createConversation({ assignedAgentId: agentA, status: ConversationStatus.PENDING });
    const targetId = await createConversation({ assignTeam: true });

    const routed = await route(targetId).expect(200);
    expect(routed.body.assignedAgentId).toBe(agentA);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId, action: "inbox.conversation.routed", entityId: targetId },
    });
    expect(audit.metadata).toMatchObject({
      availableAgents: 1,
      presenceUnavailableAgents: 1,
      eligibleAgents: 1,
      selectedLoad: 2,
      assigned: true,
    });
  });

  it("rejects automatic routing when every active member is unavailable", async () => {
    await prisma.inboxAgent.update({
      where: { id: agentA },
      data: { presenceStatus: InboxAgentPresenceStatus.AWAY },
    });
    await prisma.inboxAgent.update({
      where: { id: agentB },
      data: { presenceStatus: InboxAgentPresenceStatus.OFFLINE },
    });
    const targetId = await createConversation({ assignTeam: true });

    const rejected = await route(targetId).expect(422);
    expect(rejected.body.message).toBe("Assigned inbox team has no available routing members");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: targetId } })).assignedAgentId)
      .toBeNull();
  });

  it("applies presence before capacity and routes to an AVAILABLE agent with remaining capacity", async () => {
    await prisma.inboxAgent.update({
      where: { id: agentA },
      data: {
        presenceStatus: InboxAgentPresenceStatus.AWAY,
        maxConcurrentConversations: null,
      },
    });
    await prisma.inboxAgent.update({
      where: { id: agentB },
      data: {
        presenceStatus: InboxAgentPresenceStatus.AVAILABLE,
        maxConcurrentConversations: 1,
      },
    });
    const targetId = await createConversation({ assignTeam: true });

    const routed = await route(targetId).expect(200);
    expect(routed.body.assignedAgentId).toBe(agentB);

    const secondTarget = await createConversation({ assignTeam: true });
    const rejected = await route(secondTarget).expect(422);
    expect(rejected.body.message).toBe(
      "Assigned inbox team has no routing members with remaining conversation capacity",
    );
  });

  it("keeps presence changes non-retroactive and allows holder mutation and release", async () => {
    const heldId = await createConversation({ assignedAgentId: agentA });
    await request(app.getHttpServer())
      .patch(agentPath(agentA))
      .set("X-API-Key", writerKey)
      .send({ presenceStatus: InboxAgentPresenceStatus.OFFLINE })
      .expect(200);

    await patchConversation(heldId, { status: ConversationStatus.PENDING }).expect(200);
    const released = await request(app.getHttpServer())
      .post(releasePath(heldId))
      .set("X-API-Key", writerKey)
      .send({ agentId: agentA })
      .expect(200);
    expect(released.body.assignedAgentId).toBeNull();
  });

  it("rejects foreign-tenant agents without leaking their presence state", async () => {
    const foreignTenant = await prisma.tenant.create({
      data: { name: "Presence foreign tenant", slug: `presence-foreign-${randomUUID()}` },
    });
    const foreignAgent = await prisma.inboxAgent.create({
      data: {
        tenantId: foreignTenant.id,
        name: "Foreign Presence Agent",
        presenceStatus: InboxAgentPresenceStatus.AVAILABLE,
      },
    });
    const targetId = await createConversation();

    try {
      const rejected = await patchConversation(targetId, { assignedAgentId: foreignAgent.id }).expect(422);
      expect(rejected.body.message).toBe("Assigned inbox agent is not active in this tenant");
      expect((await prisma.conversation.findUniqueOrThrow({ where: { id: targetId } })).assignedAgentId)
        .toBeNull();
    } finally {
      await prisma.inboxAgent.deleteMany({ where: { tenantId: foreignTenant.id } });
      await prisma.tenant.delete({ where: { id: foreignTenant.id } });
    }
  });
});
