import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import type { InboxRealtimeEvent } from "../../src/inbox-events/inbox-event.types.js";
import { InboxRealtimeService } from "../../src/inbox-events/inbox-realtime.service.js";
import { InboxService } from "../../src/inbox/inbox.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "conversation-team-integration-secret-0123456789abcdef";
const conversationRoute = (id: string) => `/api/v1/inbox/conversations/${id}`;
const conversationsRoute = "/api/v1/inbox/conversations";

describe("inbox conversation team assignment integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let inbox: InboxService;
  let realtime: InboxRealtimeService;
  const tenantIds: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let senderA: string;
  let conversationA: string;
  let foreignConversation: string;
  let teamA: string;
  let teamB: string;
  let inactiveTeam: string;
  let foreignTeam: string;
  let writerKey: string;
  let readerKey: string;
  let unrelatedKey: string;
  const originalEnv = new Map<string, string | undefined>();

  async function createKey(tenantId: string, scopes: string[]) {
    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "Conversation team integration key",
        prefix: generated.prefix,
        keyHash: hashApiKey(generated.rawKey, HASH_SECRET),
        scopes,
      },
    });
    return generated.rawKey;
  }

  async function createConversation(tenantId: string, senderId: string) {
    const contact = await prisma.contact.create({
      data: { tenantId, phone: `conversation-team-${randomUUID()}` },
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

  function patchConversation(id: string, key: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(conversationRoute(id))
      .set("X-API-Key", key)
      .send(body);
  }

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required for integration tests`);
    }
    const env = {
      NODE_ENV: "test",
      API_KEY_HASH_SECRET: HASH_SECRET,
      OUTBOUND_QUEUE_NAME: `whatsapp.conversation-team.${randomUUID()}`,
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

    for (let index = 0; index < 2; index += 1) {
      const tenant = await prisma.tenant.create({
        data: { name: "Conversation team tenant", slug: `conversation-team-${randomUUID()}` },
      });
      tenantIds.push(tenant.id);
    }
    [tenantA, tenantB] = tenantIds;

    const senders = [];
    for (const tenantId of tenantIds) {
      senders.push(await prisma.whatsAppPhoneNumber.create({
        data: {
          tenantId,
          providerPhoneNumberId: `conversation-team-${randomUUID()}`,
          credentialRef: "env:CONVERSATION_TEAM_UNUSED_TOKEN",
          active: true,
        },
      }));
    }
    senderA = senders[0].id;
    conversationA = (await createConversation(tenantA, senderA)).id;
    foreignConversation = (await createConversation(tenantB, senders[1].id)).id;

    const teams = await Promise.all([
      prisma.inboxTeam.create({ data: { tenantId: tenantA, name: "Support" } }),
      prisma.inboxTeam.create({ data: { tenantId: tenantA, name: "Escalations" } }),
      prisma.inboxTeam.create({ data: { tenantId: tenantA, name: "Inactive", active: false } }),
      prisma.inboxTeam.create({ data: { tenantId: tenantB, name: "Foreign" } }),
    ]);
    [teamA, teamB, inactiveTeam, foreignTeam] = teams.map((team) => team.id);

    writerKey = await createKey(tenantA, [ApiScope.INBOX_WRITE]);
    readerKey = await createKey(tenantA, [ApiScope.INBOX_READ]);
    unrelatedKey = await createKey(tenantA, [ApiScope.MESSAGES_READ]);
  });

  beforeEach(async () => {
    await prisma.conversationTeamAssignment.deleteMany({
      where: { tenantId: tenantA, conversationId: conversationA },
    });
    await prisma.auditLog.deleteMany({
      where: {
        tenantId: tenantA,
        entityType: "Conversation",
        entityId: conversationA,
        action: "inbox.conversation.updated",
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

  it("assigns and reassigns an active tenant team and publishes realtime after commit", async () => {
    const events: InboxRealtimeEvent[] = [];
    const unsubscribe = await realtime.subscribe(tenantA, (event) => {
      if (event.type === "conversation.updated" && event.data.conversationId === conversationA) {
        events.push(event);
      }
    });

    try {
      const assigned = await patchConversation(conversationA, writerKey, { assignedTeamId: teamA }).expect(200);
      expect(assigned.body.teamAssignment.teamId).toBe(teamA);
      expect(assigned.body.teamAssignment.team.id).toBe(teamA);
      expect(events.at(-1)?.data.assignedTeamId).toBe(teamA);

      const reassigned = await patchConversation(conversationA, writerKey, { assignedTeamId: teamB }).expect(200);
      expect(reassigned.body.teamAssignment.teamId).toBe(teamB);
      expect(events.at(-1)?.data.assignedTeamId).toBe(teamB);

      expect(await prisma.conversationTeamAssignment.count({
        where: { tenantId: tenantA, conversationId: conversationA, teamId: teamB },
      })).toBe(1);
      expect(await prisma.auditLog.count({
        where: { tenantId: tenantA, entityId: conversationA, action: "inbox.conversation.updated" },
      })).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  it("rejects inactive and foreign teams for assignment", async () => {
    await patchConversation(conversationA, writerKey, { assignedTeamId: inactiveTeam }).expect(422);
    await patchConversation(conversationA, writerKey, { assignedTeamId: foreignTeam }).expect(422);
    expect(await prisma.conversationTeamAssignment.count({ where: { conversationId: conversationA } })).toBe(0);
  });

  it("allows unassignment after the assigned team is deactivated", async () => {
    await patchConversation(conversationA, writerKey, { assignedTeamId: teamA }).expect(200);
    await prisma.inboxTeam.update({ where: { id: teamA }, data: { active: false } });

    const unassigned = await patchConversation(conversationA, writerKey, { assignedTeamId: null }).expect(200);
    expect(unassigned.body.teamAssignment).toBeNull();
    expect(await prisma.conversationTeamAssignment.count({ where: { conversationId: conversationA } })).toBe(0);

    await prisma.inboxTeam.update({ where: { id: teamA }, data: { active: true } });
  });

  it("filters assigned and unassigned conversations and rejects contradictory filters", async () => {
    await patchConversation(conversationA, writerKey, { assignedTeamId: teamA }).expect(200);
    const unassignedConversation = await createConversation(tenantA, senderA);

    const assigned = await request(app.getHttpServer())
      .get(`${conversationsRoute}?assignedTeamId=${teamA}`)
      .set("X-API-Key", readerKey)
      .expect(200);
    expect(assigned.body.items.some((item: { id: string }) => item.id === conversationA)).toBe(true);
    expect(assigned.body.items.every((item: { teamAssignment: { teamId: string } | null }) => item.teamAssignment?.teamId === teamA)).toBe(true);

    const unassigned = await request(app.getHttpServer())
      .get(`${conversationsRoute}?unassignedTeam=true`)
      .set("X-API-Key", readerKey)
      .expect(200);
    expect(unassigned.body.items.some((item: { id: string }) => item.id === unassignedConversation.id)).toBe(true);
    expect(unassigned.body.items.every((item: { teamAssignment: unknown }) => item.teamAssignment === null)).toBe(true);

    await request(app.getHttpServer())
      .get(`${conversationsRoute}?assignedTeamId=${teamA}&unassignedTeam=true`)
      .set("X-API-Key", readerKey)
      .expect(400);
  });

  it("keeps cross-tenant conversations indistinguishable from missing conversations", async () => {
    await patchConversation(foreignConversation, writerKey, { assignedTeamId: teamA }).expect(404);
  });

  it("enforces inbox scopes on team assignment", async () => {
    await patchConversation(conversationA, readerKey, { assignedTeamId: teamA }).expect(403);
    await patchConversation(conversationA, unrelatedKey, { assignedTeamId: teamA }).expect(403);
  });

  it("rejects cross-tenant assignment at the PostgreSQL foreign-key boundary", async () => {
    await expect(prisma.conversationTeamAssignment.create({
      data: {
        tenantId: tenantA,
        conversationId: conversationA,
        teamId: foreignTeam,
      },
    })).rejects.toBeDefined();
    expect(await prisma.conversationTeamAssignment.count({ where: { conversationId: conversationA } })).toBe(0);
  });

  it("rolls back team assignment when the audit insert fails", async () => {
    await expect(inbox.updateConversation(
      {
        tenantId: tenantA,
        apiKeyId: randomUUID(),
        scopes: [ApiScope.INBOX_WRITE],
      },
      conversationA,
      { assignedTeamId: teamA },
    )).rejects.toBeDefined();

    expect(await prisma.conversationTeamAssignment.count({ where: { conversationId: conversationA } })).toBe(0);
  });

  it("deleting a team removes only its assignment and preserves the conversation", async () => {
    const disposableTeam = await prisma.inboxTeam.create({
      data: { tenantId: tenantA, name: `Disposable ${randomUUID()}` },
    });
    const conversation = await createConversation(tenantA, senderA);
    await prisma.conversationTeamAssignment.create({
      data: {
        tenantId: tenantA,
        conversationId: conversation.id,
        teamId: disposableTeam.id,
      },
    });

    await prisma.inboxTeam.delete({ where: { id: disposableTeam.id } });

    expect(await prisma.conversationTeamAssignment.count({ where: { conversationId: conversation.id } })).toBe(0);
    expect(await prisma.conversation.count({ where: { id: conversation.id, tenantId: tenantA } })).toBe(1);
  });

  it("serializes concurrent administrative team assignments without duplicate assignment rows", async () => {
    const conversation = await createConversation(tenantA, senderA);

    const [left, right] = await Promise.all([
      patchConversation(conversation.id, writerKey, { assignedTeamId: teamA }),
      patchConversation(conversation.id, writerKey, { assignedTeamId: teamB }),
    ]);

    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const persisted = await prisma.conversationTeamAssignment.findUniqueOrThrow({
      where: { conversationId: conversation.id },
    });
    expect([teamA, teamB]).toContain(persisted.teamId);
    expect(await prisma.conversationTeamAssignment.count({ where: { conversationId: conversation.id } })).toBe(1);
  });
});
