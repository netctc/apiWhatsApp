import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { InboxSkillsService } from "../../src/inbox/inbox-skills.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "inbox-skills-integration-secret-0123456789abcdef";
const skillsRoute = "/api/v1/inbox/skills";
const skillRoute = (id: string) => `${skillsRoute}/${id}`;
const assignmentRoute = (skillId: string, agentId: string) => `${skillRoute(skillId)}/agents/${agentId}`;

describe("inbox skills integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let skills: InboxSkillsService;
  const tenantIds: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let agentA: string;
  let agentB: string;
  let inactiveAgent: string;
  let foreignAgent: string;
  let foreignSkill: string;
  let writerKey: string;
  let readerKey: string;
  let unrelatedKey: string;
  const originalEnv = new Map<string, string | undefined>();

  async function createKey(tenantId: string, scopes: string[]) {
    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "Inbox skills integration key",
        prefix: generated.prefix,
        keyHash: hashApiKey(generated.rawKey, HASH_SECRET),
        scopes,
      },
    });
    return generated.rawKey;
  }

  function postSkill(key: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(skillsRoute)
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
      OUTBOUND_QUEUE_NAME: `whatsapp.inbox-skills.${randomUUID()}`,
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
    skills = app.get(InboxSkillsService);

    for (let index = 0; index < 2; index += 1) {
      const tenant = await prisma.tenant.create({
        data: { name: "Inbox skills tenant", slug: `inbox-skills-${randomUUID()}` },
      });
      tenantIds.push(tenant.id);
    }
    [tenantA, tenantB] = tenantIds;

    const agents = await Promise.all([
      prisma.inboxAgent.create({ data: { tenantId: tenantA, name: "Agent A" } }),
      prisma.inboxAgent.create({ data: { tenantId: tenantA, name: "Agent B" } }),
      prisma.inboxAgent.create({ data: { tenantId: tenantA, name: "Inactive Agent", active: false } }),
      prisma.inboxAgent.create({ data: { tenantId: tenantB, name: "Foreign Agent" } }),
    ]);
    [agentA, agentB, inactiveAgent, foreignAgent] = agents.map((agent) => agent.id);

    foreignSkill = (await prisma.inboxSkill.create({
      data: { tenantId: tenantB, name: "Foreign Skill" },
    })).id;

    writerKey = await createKey(tenantA, [ApiScope.INBOX_WRITE]);
    readerKey = await createKey(tenantA, [ApiScope.INBOX_READ]);
    unrelatedKey = await createKey(tenantA, [ApiScope.MESSAGES_READ]);
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

  it("creates, lists, reads, updates, and deactivates a tenant skill", async () => {
    const created = await postSkill(writerKey, {
      name: "Billing",
      description: "Payment and invoice questions",
    }).expect(201);

    expect(created.body.tenantId).toBe(tenantA);
    expect(created.body.name).toBe("Billing");

    const listed = await request(app.getHttpServer())
      .get(skillsRoute)
      .set("X-API-Key", readerKey)
      .expect(200);
    expect(listed.body.some((skill: { id: string }) => skill.id === created.body.id)).toBe(true);

    const detail = await request(app.getHttpServer())
      .get(skillRoute(created.body.id))
      .set("X-API-Key", readerKey)
      .expect(200);
    expect(detail.body.assignments).toEqual([]);

    const updated = await request(app.getHttpServer())
      .patch(skillRoute(created.body.id))
      .set("X-API-Key", writerKey)
      .send({ name: "Advanced Billing", description: "", active: false })
      .expect(200);
    expect(updated.body.name).toBe("Advanced Billing");
    expect(updated.body.description).toBeNull();
    expect(updated.body.active).toBe(false);

    const inactiveList = await request(app.getHttpServer())
      .get(`${skillsRoute}?active=false`)
      .set("X-API-Key", readerKey)
      .expect(200);
    expect(inactiveList.body.some((skill: { id: string }) => skill.id === created.body.id)).toBe(true);
  });

  it("assigns and changes proficiency with idempotent change-only audits", async () => {
    const skillId = (await postSkill(writerKey, { name: `Returns ${randomUUID()}` }).expect(201)).body.id as string;

    const first = await request(app.getHttpServer())
      .put(assignmentRoute(skillId, agentA))
      .set("X-API-Key", writerKey)
      .send({ level: 2 })
      .expect(200);
    expect(first.body.assignments).toHaveLength(1);
    expect(first.body.assignments[0].agent.id).toBe(agentA);
    expect(first.body.assignments[0].level).toBe(2);

    await request(app.getHttpServer())
      .put(assignmentRoute(skillId, agentA))
      .set("X-API-Key", writerKey)
      .send({ level: 2 })
      .expect(200);

    const changed = await request(app.getHttpServer())
      .put(assignmentRoute(skillId, agentA))
      .set("X-API-Key", writerKey)
      .send({ level: 5 })
      .expect(200);
    expect(changed.body.assignments[0].level).toBe(5);

    expect(await prisma.inboxAgentSkill.count({ where: { tenantId: tenantA, skillId, agentId: agentA } })).toBe(1);
    expect(await prisma.auditLog.count({
      where: {
        tenantId: tenantA,
        action: "inbox.skill.agent.assigned",
        entityId: `${skillId}:${agentA}`,
      },
    })).toBe(1);
    expect(await prisma.auditLog.count({
      where: {
        tenantId: tenantA,
        action: "inbox.skill.agent.level.updated",
        entityId: `${skillId}:${agentA}`,
      },
    })).toBe(1);
  });

  it("enforces proficiency bounds in HTTP validation and PostgreSQL", async () => {
    const skillId = (await postSkill(writerKey, { name: `Bounds ${randomUUID()}` }).expect(201)).body.id as string;

    for (const invalidLevel of [0, 6, 1.5]) {
      await request(app.getHttpServer())
        .put(assignmentRoute(skillId, agentA))
        .set("X-API-Key", writerKey)
        .send({ level: invalidLevel })
        .expect(400);
    }

    await expect(prisma.inboxAgentSkill.create({
      data: {
        tenantId: tenantA,
        skillId,
        agentId: agentA,
        level: 0,
      },
    })).rejects.toBeDefined();
    expect(await prisma.inboxAgentSkill.count({ where: { skillId, agentId: agentA } })).toBe(0);
  });

  it("rejects inactive skills, inactive agents, and foreign agents for new assignments", async () => {
    const activeSkill = (await postSkill(writerKey, { name: `Admissions ${randomUUID()}` }).expect(201)).body.id as string;
    const inactiveSkill = (await prisma.inboxSkill.create({
      data: { tenantId: tenantA, name: `Inactive ${randomUUID()}`, active: false },
    })).id;

    await request(app.getHttpServer())
      .put(assignmentRoute(inactiveSkill, agentA))
      .set("X-API-Key", writerKey)
      .send({ level: 2 })
      .expect(422);
    await request(app.getHttpServer())
      .put(assignmentRoute(activeSkill, inactiveAgent))
      .set("X-API-Key", writerKey)
      .send({ level: 2 })
      .expect(422);
    await request(app.getHttpServer())
      .put(assignmentRoute(activeSkill, foreignAgent))
      .set("X-API-Key", writerKey)
      .send({ level: 2 })
      .expect(422);
  });

  it("retains and permits maintenance of existing proficiency after deactivation", async () => {
    const skillId = (await postSkill(writerKey, { name: `Retention ${randomUUID()}` }).expect(201)).body.id as string;
    await request(app.getHttpServer())
      .put(assignmentRoute(skillId, agentB))
      .set("X-API-Key", writerKey)
      .send({ level: 2 })
      .expect(200);

    await prisma.inboxAgent.update({ where: { id: agentB }, data: { active: false } });
    await prisma.inboxSkill.update({ where: { id: skillId }, data: { active: false } });

    const changed = await request(app.getHttpServer())
      .put(assignmentRoute(skillId, agentB))
      .set("X-API-Key", writerKey)
      .send({ level: 4 })
      .expect(200);
    expect(changed.body.active).toBe(false);
    expect(changed.body.assignments[0].level).toBe(4);
    expect(changed.body.assignments[0].agent.active).toBe(false);

    await prisma.inboxAgent.update({ where: { id: agentB }, data: { active: true } });
  });

  it("removes proficiency idempotently with one audit record", async () => {
    const skillId = (await postSkill(writerKey, { name: `Removal ${randomUUID()}` }).expect(201)).body.id as string;
    await request(app.getHttpServer())
      .put(assignmentRoute(skillId, agentA))
      .set("X-API-Key", writerKey)
      .send({ level: 3 })
      .expect(200);

    await request(app.getHttpServer())
      .delete(assignmentRoute(skillId, agentA))
      .set("X-API-Key", writerKey)
      .expect(200);
    await request(app.getHttpServer())
      .delete(assignmentRoute(skillId, agentA))
      .set("X-API-Key", writerKey)
      .expect(200);

    expect(await prisma.inboxAgentSkill.count({ where: { skillId, agentId: agentA } })).toBe(0);
    expect(await prisma.auditLog.count({
      where: {
        tenantId: tenantA,
        action: "inbox.skill.agent.removed",
        entityId: `${skillId}:${agentA}`,
      },
    })).toBe(1);
  });

  it("enforces tenant isolation for skill reads and mutations", async () => {
    await request(app.getHttpServer())
      .get(skillRoute(foreignSkill))
      .set("X-API-Key", readerKey)
      .expect(404);
    await request(app.getHttpServer())
      .patch(skillRoute(foreignSkill))
      .set("X-API-Key", writerKey)
      .send({ active: false })
      .expect(404);
    await request(app.getHttpServer())
      .put(assignmentRoute(foreignSkill, agentA))
      .set("X-API-Key", writerKey)
      .send({ level: 2 })
      .expect(404);
    await request(app.getHttpServer())
      .delete(assignmentRoute(foreignSkill, agentA))
      .set("X-API-Key", writerKey)
      .expect(404);
  });

  it("enforces inbox scopes on skill reads and writes", async () => {
    await request(app.getHttpServer())
      .get(skillsRoute)
      .set("X-API-Key", writerKey)
      .expect(403);
    await request(app.getHttpServer())
      .get(skillsRoute)
      .set("X-API-Key", unrelatedKey)
      .expect(403);
    await postSkill(readerKey, { name: "Forbidden Skill" }).expect(403);
    await postSkill(unrelatedKey, { name: "Forbidden Skill" }).expect(403);
  });

  it("enforces cross-tenant proficiency at the PostgreSQL foreign-key boundary", async () => {
    const skillId = (await prisma.inboxSkill.create({
      data: { tenantId: tenantA, name: `Database Guard ${randomUUID()}` },
    })).id;

    await expect(prisma.inboxAgentSkill.create({
      data: {
        tenantId: tenantA,
        skillId,
        agentId: foreignAgent,
        level: 3,
      },
    })).rejects.toBeDefined();

    expect(await prisma.inboxAgentSkill.count({ where: { skillId, agentId: foreignAgent } })).toBe(0);
  });

  it("rolls back a new proficiency when the audit insert fails", async () => {
    const skillId = (await prisma.inboxSkill.create({
      data: { tenantId: tenantA, name: `Rollback ${randomUUID()}` },
    })).id;

    await expect(skills.setAgentSkill(
      {
        tenantId: tenantA,
        apiKeyId: randomUUID(),
        scopes: [ApiScope.INBOX_WRITE],
      },
      skillId,
      agentA,
      { level: 2 },
    )).rejects.toBeDefined();

    expect(await prisma.inboxAgentSkill.count({ where: { tenantId: tenantA, skillId, agentId: agentA } })).toBe(0);
  });
});
