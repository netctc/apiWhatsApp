import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { CannedResponsesService } from "../../src/canned-responses/canned-responses.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const root = "/api/v1/inbox/canned-responses";
const hashSecret = "canned-pagination-test-hash-secret-0123456789";
const epoch = Date.parse("2026-01-01T12:00:00.123Z");
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const itemIds = (response: { body: { items: { id: string }[] } }) => response.body.items.map((item) => item.id);

describe("canned response pagination across mutable filters", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let apiKey: string;
  let tenants: string[];

  const get = (query: string) => request(app.getHttpServer()).get(`${root}?${query}`).set("X-API-Key", apiKey);
  const patch = (value: number, body: Record<string, unknown>) => request(app.getHttpServer())
    .patch(`${root}/${id(value)}`).set("X-API-Key", apiKey).send({ expectedRevision: 1, ...body });

  async function seed(active = true, tied = true): Promise<void> {
    await prisma.inboxCannedResponse.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({
        id: id(index + 1), tenantId, shortcut: `reply_${index + 1}`,
        title: "Pagination fixture", body: "Private fixture text", active,
        createdAt: new Date(epoch + (tied ? 0 : index)),
      })),
    });
  }

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required`);
    }
    Object.assign(process.env, {
      NODE_ENV: "test", API_KEY_HASH_SECRET: hashSecret, META_GRAPH_API_VERSION: "v99.0",
      META_APP_SECRET: "canned-pagination-integration-secret", META_WEBHOOK_VERIFY_TOKEN: "canned-pagination-verify-token",
      OUTBOUND_QUEUE_NAME: `whatsapp.canned.pagination.${process.pid}.${Date.now()}`,
      OUTBOX_POLL_INTERVAL_MS: "250", WEBHOOK_PROCESSOR_INTERVAL_MS: "100", CAMPAIGN_PROCESSOR_INTERVAL_MS: "1000",
    });
    const { AppModule } = await import("../../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    tenants = [];
    const tenant = await prisma.tenant.create({ data: { name: "Pagination tenant", slug: `canned-pagination-${randomUUID()}` } });
    tenantId = tenant.id;
    tenants.push(tenantId);
    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({ data: {
      tenantId, name: "Pagination test", prefix: generated.prefix,
      keyHash: hashApiKey(apiKey, hashSecret), scopes: [ApiScope.INBOX_READ, ApiScope.INBOX_WRITE],
    } });
  });

  afterEach(async () => {
    if (prisma && tenants?.length) await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  });
  afterAll(async () => { await app?.close(); });

  for (const active of [true, false]) {
    for (const tied of [true, false]) {
      const status = active ? "active" : "inactive";
      it(`keeps every older ${status} result when its anchor changes state (${tied ? "tied" : "millisecond"} times)`, async () => {
        await seed(active, tied);
        const first = await get(`status=${status}&limit=2`).expect(200);
        expect(itemIds(first)).toEqual([id(5), id(4)]);
        expect(first.body.nextCursor).toBe(id(4));
        await patch(4, { active: !active }).expect(200);

        const second = await get(`status=${status}&limit=2&cursor=${first.body.nextCursor}`).expect(200);
        expect(itemIds(second)).toEqual([id(3), id(2)]);
        expect(second.body.nextCursor).toBe(id(2));
        const last = await get(`status=${status}&limit=2&cursor=${second.body.nextCursor}`).expect(200);
        expect(itemIds(last)).toEqual([id(1)]);
        expect(last.body.nextCursor).toBeNull();
        expect([...itemIds(first), ...itemIds(second), ...itemIds(last)]).toEqual([5, 4, 3, 2, 1].map(id));
      });
    }
  }

  it("returns an older exact-shortcut match even when the anchor has a different shortcut", async () => {
    await seed();
    const page = await get(`status=all&shortcut=REPLY_3&limit=1&cursor=${id(4)}`).expect(200);
    expect(itemIds(page)).toEqual([id(3)]);
    expect(page.body.nextCursor).toBeNull();
    expect((await get(`status=all&shortcut=reply_5&cursor=${id(4)}`).expect(200)).body).toEqual({ items: [], nextCursor: null });
  });

  it("does not skip the older match after an anchor shortcut is renamed and reused", async () => {
    await seed();
    await patch(4, { shortcut: "renamed_anchor" }).expect(200);
    await patch(3, { shortcut: "reply_4" }).expect(200);
    const page = await get(`shortcut=reply_4&cursor=${id(4)}`).expect(200);
    expect(itemIds(page)).toEqual([id(3)]);
    expect(page.body.nextCursor).toBeNull();
  });

  it("applies timestamp order before UUID order and retains one-millisecond boundaries", async () => {
    await seed();
    await prisma.inboxCannedResponse.update({ where: { id: id(1) }, data: { createdAt: new Date(epoch + 1) } });
    await prisma.inboxCannedResponse.update({ where: { id: id(5) }, data: { createdAt: new Date(epoch - 1) } });
    const first = await get("limit=2").expect(200);
    expect(itemIds(first)).toEqual([id(1), id(4)]);
    const second = await get(`limit=2&cursor=${first.body.nextCursor}`).expect(200);
    expect(itemIds(second)).toEqual([id(3), id(2)]);
    const last = await get(`limit=2&cursor=${second.body.nextCursor}`).expect(200);
    expect(itemIds(last)).toEqual([id(5)]);
    expect(last.body.nextCursor).toBeNull();
  });

  it("excludes the anchor for the all-status filter even after its activation changes", async () => {
    await seed();
    await patch(4, { active: false }).expect(200);
    const page = await get(`status=all&limit=3&cursor=${id(4)}`).expect(200);
    expect(itemIds(page)).toEqual([id(3), id(2), id(1)]);
    expect(page.body.nextCursor).toBeNull();
  });

  it("returns the same safe error for missing, deleted and foreign anchors", async () => {
    await seed();
    const other = await prisma.tenant.create({ data: { name: "Foreign tenant", slug: `canned-pagination-foreign-${randomUUID()}` } });
    tenants.push(other.id);
    await prisma.inboxCannedResponse.create({ data: { id: id(100), tenantId: other.id, shortcut: "foreign", title: "Foreign", body: "Must not leak" } });
    await prisma.inboxCannedResponse.delete({ where: { id: id(4) } });
    const missing = await get(`cursor=${id(99)}`).expect(400);
    const deleted = await get(`cursor=${id(4)}`).expect(400);
    const foreign = await get(`cursor=${id(100)}`).expect(400);
    expect(deleted.body.message).toBe(missing.body.message);
    expect(foreign.body.message).toBe(missing.body.message);
    expect(JSON.stringify(foreign.body)).not.toContain("Must not leak");
  });

  it("continues from the captured position when administrative deletion follows the anchor read", async () => {
    await seed();
    // Inject only the inter-query scheduling point; both reads and the deletion use PostgreSQL.
    const service = new CannedResponsesService({ inboxCannedResponse: {
      findFirst: async (args: Prisma.InboxCannedResponseFindFirstArgs) => {
        const anchor = await prisma.inboxCannedResponse.findFirst(args);
        await prisma.inboxCannedResponse.delete({ where: { id: id(4) } });
        return anchor;
      },
      findMany: (args: Prisma.InboxCannedResponseFindManyArgs) => prisma.inboxCannedResponse.findMany(args),
    } } as never);
    const page = await service.list(tenantId, { status: "active", limit: 3, cursor: id(4) });
    expect(page.items.map((item) => item.id)).toEqual([id(3), id(2), id(1)]);
    expect(page.nextCursor).toBeNull();
  });

  it("does not mutate content, revision, audit or messaging state while resolving a filtered anchor", async () => {
    await seed();
    await patch(4, { active: false }).expect(200);
    const before = await prisma.inboxCannedResponse.findMany({ where: { tenantId }, orderBy: { id: "asc" } });
    const auditCount = await prisma.auditLog.count({ where: { tenantId } });
    const page = await get(`cursor=${id(4)}&limit=1`).expect(200);
    expect(page.headers["cache-control"]).toBe("private, no-store");
    expect(itemIds(page)).toEqual([id(3)]);
    expect(Object.keys(page.body.items[0]).sort()).toEqual(["active", "body", "createdAt", "id", "revision", "shortcut", "title", "updatedAt"]);
    expect(await prisma.inboxCannedResponse.findMany({ where: { tenantId }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.auditLog.count({ where: { tenantId } })).toBe(auditCount);
    expect(await prisma.message.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.conversation.count({ where: { tenantId } })).toBe(0);
  });

  it("returns a genuinely empty older page instead of wrapping to newer matches", async () => {
    await seed();
    await prisma.inboxCannedResponse.updateMany({ where: { tenantId, id: { in: [id(1), id(2), id(3), id(4)] } }, data: { active: false } });
    const page = await get(`cursor=${id(4)}&limit=1`).expect(200);
    expect(page.body).toEqual({ items: [], nextCursor: null });
  });
});
