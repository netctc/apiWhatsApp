import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { InboxTeamsService } from "../../src/inbox/inbox-teams.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "inbox-teams-integration-secret-0123456789abcdef";
const teamsRoute = "/api/v1/inbox/teams";
const teamRoute = (id: string) => `${teamsRoute}/${id}`;
const memberRoute = (teamId: string, agentId: string) => `${teamRoute(teamId)}/members/${agentId}`;

describe("inbox teams integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let teams: InboxTeamsService;
  const tenantIds: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let agentA: string;
  let agentB: string;
  let inactiveAgent: string;
  let foreignAgent: string;
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
        name: "Inbox teams integration key",
        prefix: generated.prefix,
        keyHash: hashApiKey(generated.rawKey, HASH_SECRET),
        scopes,
      },
    });
    return generated.rawKey;
  }

  function postTeam(key: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(teamsRoute)
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
      OUTBOUND_QUEUE_NAME: `whatsapp.inbox-teams.${randomUUID()}`,
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
    teams = app.get(InboxTeamsService);

    for (let index = 0; index < 2; index += 1) {
      const tenant = await prisma.tenant.create({
        data: { name: "Inbox teams tenant", slug: `inbox-teams-${randomUUID()}` },
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

    foreignTeam = (await prisma.inboxTeam.create({
      data: { tenantId: tenantB, name: "Foreign Team" },
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

  it("creates, lists, reads, updates, and deactivates a tenant team", async () => {
    const created = await postTeam(writerKey, {
      name: "Customer Support",
      description: "Primary queue owners",
    }).expect(201);

    expect(created.body.tenantId).toBe(tenantA);
    expect(created.body.name).toBe("Customer Support");

    const listed = await request(app.getHttpServer())
      .get(teamsRoute)
      .set("X-API-Key", readerKey)
      .expect(200);
    expect(listed.body.some((team: { id: string }) => team.id === created.body.id)).toBe(true);

    const detail = await request(app.getHttpServer())
      .get(teamRoute(created.body.id))
      .set("X-API-Key", readerKey)
      .expect(200);
    expect(detail.body.members).toEqual([]);

    const updated = await request(app.getHttpServer())
      .patch(teamRoute(created.body.id))
      .set("X-API-Key", writerKey)
      .send({ name: "Tier 1 Support", description: "", active: false })
      .expect(200);
    expect(updated.body.name).toBe("Tier 1 Support");
    expect(updated.body.description).toBeNull();
    expect(updated.body.active).toBe(false);

    const inactiveList = await request(app.getHttpServer())
      .get(`${teamsRoute}?active=false`)
      .set("X-API-Key", readerKey)
      .expect(200);
    expect(inactiveList.body.some((team: { id: string }) => team.id === created.body.id)).toBe(true);
  });

  it("adds and removes members idempotently with change-only audit records", async () => {
    const created = await postTeam(writerKey, { name: `Support ${randomUUID()}` }).expect(201);
    const teamId = created.body.id as string;

    const first = await request(app.getHttpServer())
      .put(memberRoute(teamId, agentA))
      .set("X-API-Key", writerKey)
      .expect(200);
    expect(first.body.members).toHaveLength(1);
    expect(first.body.members[0].agent.id).toBe(agentA);

    await request(app.getHttpServer())
      .put(memberRoute(teamId, agentA))
      .set("X-API-Key", writerKey)
      .expect(200);

    expect(await prisma.inboxTeamMember.count({ where: { tenantId: tenantA, teamId, agentId: agentA } })).toBe(1);
    expect(await prisma.auditLog.count({
      where: {
        tenantId: tenantA,
        action: "inbox.team.member.added",
        entityId: `${teamId}:${agentA}`,
      },
    })).toBe(1);

    await request(app.getHttpServer())
      .delete(memberRoute(teamId, agentA))
      .set("X-API-Key", writerKey)
      .expect(200);
    await request(app.getHttpServer())
      .delete(memberRoute(teamId, agentA))
      .set("X-API-Key", writerKey)
      .expect(200);

    expect(await prisma.inboxTeamMember.count({ where: { tenantId: tenantA, teamId, agentId: agentA } })).toBe(0);
    expect(await prisma.auditLog.count({
      where: {
        tenantId: tenantA,
        action: "inbox.team.member.removed",
        entityId: `${teamId}:${agentA}`,
      },
    })).toBe(1);
  });

  it("rejects inactive and foreign agents for new membership", async () => {
    const teamId = (await postTeam(writerKey, { name: `Admissions ${randomUUID()}` }).expect(201)).body.id as string;

    await request(app.getHttpServer())
      .put(memberRoute(teamId, inactiveAgent))
      .set("X-API-Key", writerKey)
      .expect(422);
    await request(app.getHttpServer())
      .put(memberRoute(teamId, foreignAgent))
      .set("X-API-Key", writerKey)
      .expect(422);

    expect(await prisma.inboxTeamMember.count({ where: { teamId } })).toBe(0);
  });

  it("keeps existing memberships when an agent or team is later deactivated", async () => {
    const teamId = (await postTeam(writerKey, { name: `Retention ${randomUUID()}` }).expect(201)).body.id as string;
    await request(app.getHttpServer())
      .put(memberRoute(teamId, agentB))
      .set("X-API-Key", writerKey)
      .expect(200);

    await prisma.inboxAgent.update({ where: { id: agentB }, data: { active: false } });
    await request(app.getHttpServer())
      .patch(teamRoute(teamId))
      .set("X-API-Key", writerKey)
      .send({ active: false })
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(teamRoute(teamId))
      .set("X-API-Key", readerKey)
      .expect(200);
    expect(detail.body.active).toBe(false);
    expect(detail.body.members).toHaveLength(1);
    expect(detail.body.members[0].agent.active).toBe(false);

    await prisma.inboxAgent.update({ where: { id: agentB }, data: { active: true } });
  });

  it("enforces tenant isolation for reads and mutations", async () => {
    await request(app.getHttpServer())
      .get(teamRoute(foreignTeam))
      .set("X-API-Key", readerKey)
      .expect(404);
    await request(app.getHttpServer())
      .patch(teamRoute(foreignTeam))
      .set("X-API-Key", writerKey)
      .send({ active: false })
      .expect(404);
    await request(app.getHttpServer())
      .put(memberRoute(foreignTeam, agentA))
      .set("X-API-Key", writerKey)
      .expect(404);
    await request(app.getHttpServer())
      .delete(memberRoute(foreignTeam, agentA))
      .set("X-API-Key", writerKey)
      .expect(404);
  });

  it("enforces inbox scopes on team reads and writes", async () => {
    await request(app.getHttpServer())
      .get(teamsRoute)
      .set("X-API-Key", writerKey)
      .expect(403);
    await request(app.getHttpServer())
      .get(teamsRoute)
      .set("X-API-Key", unrelatedKey)
      .expect(403);
    await postTeam(readerKey, { name: "Forbidden Team" }).expect(403);
    await postTeam(unrelatedKey, { name: "Forbidden Team" }).expect(403);
  });

  it("enforces cross-tenant membership at the PostgreSQL foreign-key boundary", async () => {
    const teamId = (await prisma.inboxTeam.create({
      data: { tenantId: tenantA, name: `Database Guard ${randomUUID()}` },
    })).id;

    await expect(prisma.inboxTeamMember.create({
      data: {
        tenantId: tenantA,
        teamId,
        agentId: foreignAgent,
      },
    })).rejects.toBeDefined();

    expect(await prisma.inboxTeamMember.count({ where: { teamId, agentId: foreignAgent } })).toBe(0);
  });

  it("rolls back membership when the audit insert fails", async () => {
    const teamId = (await prisma.inboxTeam.create({
      data: { tenantId: tenantA, name: `Rollback ${randomUUID()}` },
    })).id;

    await expect(teams.addMember(
      {
        tenantId: tenantA,
        apiKeyId: randomUUID(),
        scopes: [ApiScope.INBOX_WRITE],
      },
      teamId,
      agentA,
    )).rejects.toBeDefined();

    expect(await prisma.inboxTeamMember.count({ where: { tenantId: tenantA, teamId, agentId: agentA } })).toBe(0);
  });
});
