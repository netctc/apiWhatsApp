import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { InboxService } from "../../src/inbox/inbox.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "team-agent-routing-integration-secret-0123456789abcdef";
const conversationRoute = (id: string) => `/api/v1/inbox/conversations/${id}`;
const claimRoute = (id: string) => `/api/v1/inbox/conversations/${id}/claim`;
const releaseRoute = (id: string) => `/api/v1/inbox/conversations/${id}/release`;

describe("inbox team-agent routing invariant integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let inbox: InboxService;
  const tenantIds: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let conversationA: string;
  let teamA: string;
  let teamB: string;
  let agentA: string;
  let agentB: string;
  let foreignAgent: string;
  let writerKey: string;
  const originalEnv = new Map<string, string | undefined>();

  async function createKey(tenantId: string, scopes: string[]) {
    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "Team agent routing integration key",
        prefix: generated.prefix,
        keyHash: hashApiKey(generated.rawKey, HASH_SECRET),
        scopes,
      },
    });
    return generated.rawKey;
  }

  function patchConversation(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(conversationRoute(conversationA))
      .set("X-API-Key", writerKey)
      .send(body);
  }

  function post(path: string, agentId: string) {
    return request(app.getHttpServer())
      .post(path)
      .set("X-API-Key", writerKey)
      .send({ agentId });
  }

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required for integration tests`);
    }
    const env = {
      NODE_ENV: "test",
      API_KEY_HASH_SECRET: HASH_SECRET,
      OUTBOUND_QUEUE_NAME: `whatsapp.team-agent-routing.${randomUUID()}`,
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

    for (let index = 0; index < 2; index += 1) {
      const tenant = await prisma.tenant.create({
        data: { name: "Team agent routing tenant", slug: `team-agent-routing-${randomUUID()}` },
      });
      tenantIds.push(tenant.id);
    }
    [tenantA, tenantB] = tenantIds;

    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId: tenantA,
        providerPhoneNumberId: `team-agent-routing-${randomUUID()}`,
        credentialRef: "env:TEAM_AGENT_ROUTING_UNUSED_TOKEN",
        active: true,
      },
    });
    const contact = await prisma.contact.create({
      data: { tenantId: tenantA, phone: `team-agent-routing-${randomUUID()}` },
    });
    conversationA = (await prisma.conversation.create({
      data: {
        tenantId: tenantA,
        senderId: sender.id,
        contactId: contact.id,
        lastMessageAt: new Date(),
      },
    })).id;

    const teams = await Promise.all([
      prisma.inboxTeam.create({ data: { tenantId: tenantA, name: "Routing Support" } }),
      prisma.inboxTeam.create({ data: { tenantId: tenantA, name: "Routing Escalations" } }),
    ]);
    [teamA, teamB] = teams.map((team) => team.id);

    const agents = await Promise.all([
      prisma.inboxAgent.create({ data: { tenantId: tenantA, name: "Routing Agent A" } }),
      prisma.inboxAgent.create({ data: { tenantId: tenantA, name: "Routing Agent B" } }),
      prisma.inboxAgent.create({ data: { tenantId: tenantB, name: "Foreign Routing Agent" } }),
    ]);
    [agentA, agentB, foreignAgent] = agents.map((agent) => agent.id);

    writerKey = await createKey(tenantA, [ApiScope.INBOX_WRITE]);
  });

  beforeEach(async () => {
    await prisma.conversationTeamAssignment.deleteMany({
      where: { tenantId: tenantA, conversationId: conversationA },
    });
    await prisma.conversation.update({
      where: { id: conversationA },
      data: { assignedAgentId: null, status: "OPEN" },
    });
    await prisma.inboxTeamMember.deleteMany({
      where: { tenantId: tenantA, teamId: { in: [teamA, teamB] } },
    });
    await prisma.inboxTeamMember.createMany({
      data: [
        { tenantId: tenantA, teamId: teamA, agentId: agentA },
        { tenantId: tenantA, teamId: teamB, agentId: agentB },
      ],
    });
    await prisma.auditLog.deleteMany({
      where: { tenantId: tenantA, entityType: "Conversation", entityId: conversationA },
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

  it("accepts a valid team and member agent together in one administrative patch", async () => {
    const response = await patchConversation({ assignedTeamId: teamA, assignedAgentId: agentA }).expect(200);

    expect(response.body.assignedAgentId).toBe(agentA);
    expect(response.body.teamAssignment.teamId).toBe(teamA);
    const persisted = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationA },
      include: { teamAssignment: true },
    });
    expect(persisted.assignedAgentId).toBe(agentA);
    expect(persisted.teamAssignment?.teamId).toBe(teamA);
  });

  it("rejects an agent outside the final assigned team and leaves both assignments unchanged", async () => {
    const response = await patchConversation({ assignedTeamId: teamA, assignedAgentId: agentB }).expect(422);
    expect(response.body.message).toBe("Assigned inbox agent is not a member of the assigned team");

    const persisted = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationA },
      include: { teamAssignment: true },
    });
    expect(persisted.assignedAgentId).toBeNull();
    expect(persisted.teamAssignment).toBeNull();
  });

  it("rejects moving a team when the current agent is not a member of the target team", async () => {
    await patchConversation({ assignedTeamId: teamA, assignedAgentId: agentA }).expect(200);

    const response = await patchConversation({ assignedTeamId: teamB }).expect(422);
    expect(response.body.message).toBe("Assigned inbox agent is not a member of the assigned team");

    const persisted = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationA },
      include: { teamAssignment: true },
    });
    expect(persisted.assignedAgentId).toBe(agentA);
    expect(persisted.teamAssignment?.teamId).toBe(teamA);
  });

  it("requires team membership for a new cooperative claim", async () => {
    await patchConversation({ assignedTeamId: teamA }).expect(200);

    const rejected = await post(claimRoute(conversationA), agentB).expect(422);
    expect(rejected.body.message).toBe("Inbox agent is not a member of the assigned team");

    const claimed = await post(claimRoute(conversationA), agentA).expect(200);
    expect(claimed.body.assignedAgentId).toBe(agentA);
  });

  it("keeps historical assignments operable after membership removal", async () => {
    await patchConversation({ assignedTeamId: teamA, assignedAgentId: agentA }).expect(200);
    await prisma.inboxTeamMember.delete({
      where: { teamId_agentId: { teamId: teamA, agentId: agentA } },
    });

    const statusUpdate = await patchConversation({ status: "PENDING" }).expect(200);
    expect(statusUpdate.body.status).toBe("PENDING");

    const repeatClaim = await post(claimRoute(conversationA), agentA).expect(200);
    expect(repeatClaim.body.assignedAgentId).toBe(agentA);

    const released = await post(releaseRoute(conversationA), agentA).expect(200);
    expect(released.body.assignedAgentId).toBeNull();
  });

  it("allows team removal without clearing an existing agent after membership removal", async () => {
    await patchConversation({ assignedTeamId: teamA, assignedAgentId: agentA }).expect(200);
    await prisma.inboxTeamMember.delete({
      where: { teamId_agentId: { teamId: teamA, agentId: agentA } },
    });

    const response = await patchConversation({ assignedTeamId: null }).expect(200);
    expect(response.body.teamAssignment).toBeNull();
    expect(response.body.assignedAgentId).toBe(agentA);
  });

  it("preserves tenant isolation before membership evaluation", async () => {
    const response = await patchConversation({ assignedTeamId: teamA, assignedAgentId: foreignAgent }).expect(422);
    expect(response.body.message).toBe("Assigned inbox agent is not active in this tenant");
    expect(await prisma.conversationTeamAssignment.count({ where: { conversationId: conversationA } })).toBe(0);
  });

  it("rolls back the combined team-agent mutation when audit persistence fails", async () => {
    await expect(inbox.updateConversation(
      {
        tenantId: tenantA,
        apiKeyId: randomUUID(),
        scopes: [ApiScope.INBOX_WRITE],
      },
      conversationA,
      { assignedTeamId: teamA, assignedAgentId: agentA },
    )).rejects.toBeDefined();

    const persisted = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationA },
      include: { teamAssignment: true },
    });
    expect(persisted.assignedAgentId).toBeNull();
    expect(persisted.teamAssignment).toBeNull();
  });
});
