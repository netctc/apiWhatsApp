import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConversationStatus } from "../../src/generated/prisma/client.js";
import { InboxConversationSkillsService } from "../../src/inbox/inbox-conversation-skills.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "conversation-skill-routing-integration-secret-0123456789abcdef";
const conversationPath = (id: string) => `/api/v1/inbox/conversations/${id}`;
const skillPath = (conversationId: string, skillId: string) =>
  `/api/v1/inbox/conversations/${conversationId}/skills/${skillId}`;
const claimPath = (id: string) => `/api/v1/inbox/conversations/${id}/claim`;
const releasePath = (id: string) => `/api/v1/inbox/conversations/${id}/release`;
const routePath = (id: string) => `/api/v1/inbox/conversations/${id}/route`;

describe("inbox conversation skill routing integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let requirements: InboxConversationSkillsService;
  let tenantId: string;
  let foreignTenantId: string;
  let senderId: string;
  let teamId: string;
  let agentA: string;
  let agentB: string;
  let skillA: string;
  let skillB: string;
  let foreignSkillId: string;
  let writerKey: string;
  let readerKey: string;
  const originalEnv = new Map<string, string | undefined>();

  async function createKey(scopes: string[]) {
    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "Conversation skill routing integration key",
        prefix: generated.prefix,
        keyHash: hashApiKey(generated.rawKey, HASH_SECRET),
        scopes,
      },
    });
    return generated.rawKey;
  }

  async function createConversation(assignTeam = true) {
    const contact = await prisma.contact.create({
      data: { tenantId, phone: `conversation-skill-${randomUUID()}` },
    });
    const conversation = await prisma.conversation.create({
      data: {
        tenantId,
        senderId,
        contactId: contact.id,
        lastMessageAt: new Date(),
      },
    });
    if (assignTeam) {
      await prisma.conversationTeamAssignment.create({
        data: { tenantId, conversationId: conversation.id, teamId },
      });
    }
    return conversation.id;
  }

  function putRequirement(conversationId: string, skillId: string, minLevel: number, key = writerKey) {
    return request(app.getHttpServer())
      .put(skillPath(conversationId, skillId))
      .set("X-API-Key", key)
      .send({ minLevel });
  }

  function patchConversation(conversationId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(conversationPath(conversationId))
      .set("X-API-Key", writerKey)
      .send(body);
  }

  function postAgent(path: string, agentId: string) {
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
      OUTBOUND_QUEUE_NAME: `whatsapp.conversation-skill-routing.${randomUUID()}`,
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
    requirements = app.get(InboxConversationSkillsService);

    const [tenant, foreignTenant] = await Promise.all([
      prisma.tenant.create({
        data: { name: "Conversation skill routing tenant", slug: `conversation-skill-${randomUUID()}` },
      }),
      prisma.tenant.create({
        data: { name: "Foreign conversation skill tenant", slug: `foreign-conversation-skill-${randomUUID()}` },
      }),
    ]);
    tenantId = tenant.id;
    foreignTenantId = foreignTenant.id;

    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId: `conversation-skill-${randomUUID()}`,
        credentialRef: "env:CONVERSATION_SKILL_UNUSED_TOKEN",
        active: true,
      },
    });
    senderId = sender.id;

    const team = await prisma.inboxTeam.create({ data: { tenantId, name: "Skill Routing Team" } });
    teamId = team.id;
    const agents = await Promise.all([
      prisma.inboxAgent.create({ data: { tenantId, name: "Skill Routing Agent A" } }),
      prisma.inboxAgent.create({ data: { tenantId, name: "Skill Routing Agent B" } }),
    ]);
    [agentA, agentB] = agents.map((agent) => agent.id);

    const skills = await Promise.all([
      prisma.inboxSkill.create({ data: { tenantId, name: "Billing" } }),
      prisma.inboxSkill.create({ data: { tenantId, name: "Returns" } }),
      prisma.inboxSkill.create({ data: { tenantId: foreignTenantId, name: "Foreign Skill" } }),
    ]);
    [skillA, skillB, foreignSkillId] = skills.map((skill) => skill.id);

    writerKey = await createKey([ApiScope.INBOX_WRITE, ApiScope.INBOX_READ]);
    readerKey = await createKey([ApiScope.INBOX_READ]);
  });

  beforeEach(async () => {
    await prisma.conversation.deleteMany({ where: { tenantId } });
    await prisma.contact.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({
      where: {
        tenantId,
        action: { startsWith: "inbox.conversation.skill." },
      },
    });
    await prisma.inboxTeamMember.deleteMany({ where: { tenantId, teamId } });
    await prisma.inboxTeamMember.createMany({
      data: [
        { tenantId, teamId, agentId: agentA },
        { tenantId, teamId, agentId: agentB },
      ],
    });
    await prisma.inboxAgentSkill.deleteMany({ where: { tenantId } });
    await prisma.inboxAgentSkill.createMany({
      data: [
        { tenantId, agentId: agentA, skillId: skillA, level: 5 },
        { tenantId, agentId: agentA, skillId: skillB, level: 4 },
        { tenantId, agentId: agentB, skillId: skillA, level: 5 },
        { tenantId, agentId: agentB, skillId: skillB, level: 2 },
      ],
    });
    await prisma.inboxSkill.updateMany({
      where: { id: { in: [skillA, skillB] } },
      data: { active: true },
    });
    await prisma.inboxAgent.updateMany({
      where: { id: { in: [agentA, agentB] } },
      data: { active: true },
    });
  });

  afterAll(async () => {
    if (prisma && tenantId && foreignTenantId) {
      await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, foreignTenantId] } } });
    }
    if (app) await app.close();
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("creates, exposes, updates, and removes an idempotent conversation requirement", async () => {
    const conversationId = await createConversation();

    const created = await putRequirement(conversationId, skillA, 3).expect(200);
    expect(created.body).toHaveLength(1);
    expect(created.body[0]).toMatchObject({ skillId: skillA, minLevel: 3 });
    expect(created.body[0].skill).toMatchObject({ id: skillA, name: "Billing", active: true });

    await putRequirement(conversationId, skillA, 3).expect(200);
    expect(await prisma.conversationSkillRequirement.count({ where: { conversationId, skillId: skillA } })).toBe(1);
    expect(await prisma.auditLog.count({
      where: { tenantId, entityId: `${conversationId}:${skillA}`, action: "inbox.conversation.skill.required" },
    })).toBe(1);

    const detail = await request(app.getHttpServer())
      .get(conversationPath(conversationId))
      .set("X-API-Key", writerKey)
      .expect(200);
    expect(detail.body.skillRequirements).toHaveLength(1);
    expect(detail.body.skillRequirements[0]).toMatchObject({ skillId: skillA, minLevel: 3 });

    const updated = await putRequirement(conversationId, skillA, 4).expect(200);
    expect(updated.body[0].minLevel).toBe(4);

    const removed = await request(app.getHttpServer())
      .delete(skillPath(conversationId, skillA))
      .set("X-API-Key", writerKey)
      .expect(200);
    expect(removed.body).toEqual([]);
  });

  it("enforces HTTP and PostgreSQL minimum-level and tenant constraints", async () => {
    const conversationId = await createConversation();

    await putRequirement(conversationId, skillA, 0).expect(400);
    await expect(prisma.conversationSkillRequirement.create({
      data: { tenantId, conversationId, skillId: skillA, minLevel: 0 },
    })).rejects.toBeDefined();
    await expect(prisma.conversationSkillRequirement.create({
      data: { tenantId, conversationId, skillId: foreignSkillId, minLevel: 1 },
    })).rejects.toBeDefined();
  });

  it("requires inbox:write to mutate requirements", async () => {
    const conversationId = await createConversation();
    await putRequirement(conversationId, skillA, 1, readerKey).expect(403);
  });

  it("enforces all current requirements on explicit assignment and cooperative claim", async () => {
    const administrative = await createConversation();
    await putRequirement(administrative, skillA, 4).expect(200);
    await putRequirement(administrative, skillB, 3).expect(200);

    const rejected = await patchConversation(administrative, { assignedAgentId: agentB }).expect(422);
    expect(rejected.body.message).toBe("Assigned inbox agent does not satisfy conversation skill requirements");
    const accepted = await patchConversation(administrative, { assignedAgentId: agentA }).expect(200);
    expect(accepted.body.assignedAgentId).toBe(agentA);

    const cooperative = await createConversation();
    await putRequirement(cooperative, skillB, 3).expect(200);
    const rejectedClaim = await postAgent(claimPath(cooperative), agentB).expect(422);
    expect(rejectedClaim.body.message).toBe("Inbox agent does not satisfy conversation skill requirements");
    const acceptedClaim = await postAgent(claimPath(cooperative), agentA).expect(200);
    expect(acceptedClaim.body.assignedAgentId).toBe(agentA);
  });

  it("fails new admission closed when a required skill is inactive", async () => {
    const conversationId = await createConversation();
    await putRequirement(conversationId, skillA, 1).expect(200);
    await prisma.inboxSkill.update({ where: { id: skillA }, data: { active: false } });

    const response = await patchConversation(conversationId, { assignedAgentId: agentA }).expect(422);
    expect(response.body.message).toBe("Conversation has inactive required inbox skills");
  });

  it("filters least-loaded routing through every required skill before workload selection", async () => {
    const targetId = await createConversation();
    await putRequirement(targetId, skillA, 4).expect(200);
    await putRequirement(targetId, skillB, 3).expect(200);

    for (let index = 0; index < 3; index += 1) {
      const loadedId = await createConversation(false);
      await prisma.conversation.update({ where: { id: loadedId }, data: { assignedAgentId: agentA } });
    }

    const response = await request(app.getHttpServer())
      .post(routePath(targetId))
      .set("X-API-Key", writerKey)
      .expect(200);

    expect(response.body.assignedAgentId).toBe(agentA);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId, action: "inbox.conversation.routed", entityId: targetId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.metadata).toMatchObject({ requiredSkills: 2, eligibleAgents: 1 });
  });

  it("rejects automatic routing when no active team member satisfies all requirements", async () => {
    const targetId = await createConversation();
    await putRequirement(targetId, skillB, 5).expect(200);

    const response = await request(app.getHttpServer())
      .post(routePath(targetId))
      .set("X-API-Key", writerKey)
      .expect(422);

    expect(response.body.message).toBe("Assigned inbox team has no active members satisfying required skills");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: targetId } })).assignedAgentId).toBeNull();
  });

  it("keeps current holders operable after requirements become stricter", async () => {
    const conversationId = await createConversation();
    await putRequirement(conversationId, skillB, 4).expect(200);
    await patchConversation(conversationId, { assignedAgentId: agentA }).expect(200);
    await putRequirement(conversationId, skillB, 5).expect(200);

    const status = await patchConversation(conversationId, { status: ConversationStatus.PENDING }).expect(200);
    expect(status.body.assignedAgentId).toBe(agentA);
    const repeatClaim = await postAgent(claimPath(conversationId), agentA).expect(200);
    expect(repeatClaim.body.assignedAgentId).toBe(agentA);
    const released = await postAgent(releasePath(conversationId), agentA).expect(200);
    expect(released.body.assignedAgentId).toBeNull();
  });

  it("rolls back a requirement mutation when audit persistence fails", async () => {
    const conversationId = await createConversation();

    await expect(requirements.setRequirement(
      { tenantId, apiKeyId: randomUUID(), scopes: [ApiScope.INBOX_WRITE] },
      conversationId,
      skillA,
      { minLevel: 2 },
    )).rejects.toBeDefined();

    expect(await prisma.conversationSkillRequirement.count({ where: { conversationId, skillId: skillA } })).toBe(0);
  });
});
