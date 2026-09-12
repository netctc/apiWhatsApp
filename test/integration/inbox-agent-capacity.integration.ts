import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConversationStatus } from "../../src/generated/prisma/client.js";
import { InboxService } from "../../src/inbox/inbox.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "inbox-agent-capacity-integration-secret-0123456789abcdef";

describe("inbox agent conversation capacity integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let inbox: InboxService;
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
      data: { tenantId, phone: `capacity-${randomUUID()}` },
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
      OUTBOUND_QUEUE_NAME: `whatsapp.inbox-agent-capacity.${randomUUID()}`,
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

    const tenant = await prisma.tenant.create({
      data: { name: "Inbox agent capacity tenant", slug: `inbox-agent-capacity-${randomUUID()}` },
    });
    tenantId = tenant.id;

    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId: `inbox-agent-capacity-${randomUUID()}`,
        credentialRef: "env:INBOX_AGENT_CAPACITY_UNUSED_TOKEN",
        active: true,
      },
    });
    senderId = sender.id;

    const team = await prisma.inboxTeam.create({
      data: { tenantId, name: "Capacity Support" },
    });
    teamId = team.id;

    const agents = await Promise.all([
      prisma.inboxAgent.create({ data: { tenantId, name: "Capacity Agent A" } }),
      prisma.inboxAgent.create({ data: { tenantId, name: "Capacity Agent B" } }),
    ]);
    [agentA, agentB] = agents.map((agent) => agent.id).sort();

    const generated = generateApiKey();
    writerKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "Inbox capacity integration key",
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
      data: { active: true, maxConcurrentConversations: null },
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

  it("exposes nullable bounded capacity through the agent API and enforces the database check", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/v1/inbox/agents")
      .set("X-API-Key", writerKey)
      .send({ name: "Bounded Capacity Agent", maxConcurrentConversations: 4 })
      .expect(201);
    expect(created.body.maxConcurrentConversations).toBe(4);

    const listed = await request(app.getHttpServer())
      .get("/api/v1/inbox/agents")
      .set("X-API-Key", writerKey)
      .expect(200);
    expect(listed.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.body.id, maxConcurrentConversations: 4 }),
    ]));

    const unlimited = await request(app.getHttpServer())
      .patch(agentPath(created.body.id))
      .set("X-API-Key", writerKey)
      .send({ maxConcurrentConversations: null })
      .expect(200);
    expect(unlimited.body.maxConcurrentConversations).toBeNull();

    await request(app.getHttpServer())
      .patch(agentPath(created.body.id))
      .set("X-API-Key", writerKey)
      .send({ maxConcurrentConversations: -1 })
      .expect(400);
    await request(app.getHttpServer())
      .patch(agentPath(created.body.id))
      .set("X-API-Key", writerKey)
      .send({ maxConcurrentConversations: 10001 })
      .expect(400);

    await expect(prisma.inboxAgent.create({
      data: { tenantId, name: "Invalid database capacity", maxConcurrentConversations: -1 },
    })).rejects.toBeDefined();
  });

  it("rejects a new administrative assignment at capacity and admits it after workload resolves", async () => {
    await prisma.inboxAgent.update({
      where: { id: agentA },
      data: { maxConcurrentConversations: 1 },
    });
    const loadId = await createConversation({ assignedAgentId: agentA, status: ConversationStatus.OPEN });
    const targetId = await createConversation();

    const rejected = await patchConversation(targetId, { assignedAgentId: agentA }).expect(422);
    expect(rejected.body.message).toBe("Assigned inbox agent has no remaining conversation capacity");

    await prisma.conversation.update({
      where: { id: loadId },
      data: { status: ConversationStatus.RESOLVED, resolvedAt: new Date() },
    });
    const admitted = await patchConversation(targetId, { assignedAgentId: agentA }).expect(200);
    expect(admitted.body.assignedAgentId).toBe(agentA);
  });

  it("enforces capacity on new claims but keeps repeat-holder claims idempotent", async () => {
    await prisma.inboxAgent.update({
      where: { id: agentA },
      data: { maxConcurrentConversations: 0 },
    });
    const unassignedId = await createConversation();

    const rejected = await claim(unassignedId, agentA).expect(422);
    expect(rejected.body.message).toBe("Inbox agent has no remaining conversation capacity");

    const heldId = await createConversation({ assignedAgentId: agentA });
    const repeated = await claim(heldId, agentA).expect(200);
    expect(repeated.body.assignedAgentId).toBe(agentA);
    expect(await prisma.auditLog.count({
      where: { tenantId, action: "inbox.conversation.claimed", entityId: heldId },
    })).toBe(0);
  });

  it("filters full agents before least-loaded routing and rejects when every eligible member is full", async () => {
    await prisma.inboxAgent.updateMany({
      where: { id: { in: [agentA, agentB] } },
      data: { maxConcurrentConversations: 1 },
    });
    await createConversation({ assignedAgentId: agentA, status: ConversationStatus.OPEN });
    const firstTarget = await createConversation({ assignTeam: true });

    const routed = await route(firstTarget).expect(200);
    expect(routed.body.assignedAgentId).toBe(agentB);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId, action: "inbox.conversation.routed", entityId: firstTarget },
    });
    expect(audit.metadata).toMatchObject({
      eligibleAgents: 1,
      capacityLimitedAgents: 1,
      selectedLoad: 0,
      assigned: true,
    });

    const secondTarget = await createConversation({ assignTeam: true });
    const rejected = await route(secondTarget).expect(422);
    expect(rejected.body.message).toBe(
      "Assigned inbox team has no routing members with remaining conversation capacity",
    );
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: secondTarget } })).assignedAgentId)
      .toBeNull();
  });

  it("serializes concurrent assignments so a capacity-one agent cannot be overbooked", async () => {
    await prisma.inboxAgent.update({
      where: { id: agentA },
      data: { maxConcurrentConversations: 1 },
    });
    const firstId = await createConversation();
    const secondId = await createConversation();

    const [first, second] = await Promise.all([
      patchConversation(firstId, { assignedAgentId: agentA }),
      patchConversation(secondId, { assignedAgentId: agentA }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 422]);

    expect(await prisma.conversation.count({
      where: {
        tenantId,
        assignedAgentId: agentA,
        status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
      },
    })).toBe(1);
  });

  it("allows non-retroactive capacity reductions and holder release while over capacity", async () => {
    await prisma.inboxAgent.update({
      where: { id: agentA },
      data: { maxConcurrentConversations: 2 },
    });
    const firstId = await createConversation({ assignedAgentId: agentA });
    await createConversation({ assignedAgentId: agentA });

    const reduced = await request(app.getHttpServer())
      .patch(agentPath(agentA))
      .set("X-API-Key", writerKey)
      .send({ maxConcurrentConversations: 1 })
      .expect(200);
    expect(reduced.body.maxConcurrentConversations).toBe(1);

    await patchConversation(firstId, { status: ConversationStatus.PENDING }).expect(200);
    const released = await request(app.getHttpServer())
      .post(releasePath(firstId))
      .set("X-API-Key", writerKey)
      .send({ agentId: agentA })
      .expect(200);
    expect(released.body.assignedAgentId).toBeNull();
  });

  it("rolls back a capacity-approved assignment when audit persistence fails", async () => {
    await prisma.inboxAgent.update({
      where: { id: agentA },
      data: { maxConcurrentConversations: 1 },
    });
    const targetId = await createConversation();

    await expect(inbox.updateConversation({
      tenantId,
      apiKeyId: randomUUID(),
      scopes: [ApiScope.INBOX_WRITE],
    }, targetId, { assignedAgentId: agentA })).rejects.toBeDefined();

    const persisted = await prisma.conversation.findUniqueOrThrow({ where: { id: targetId } });
    expect(persisted.assignedAgentId).toBeNull();
  });
});
