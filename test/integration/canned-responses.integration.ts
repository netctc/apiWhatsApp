import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { CannedResponsesService } from "../../src/canned-responses/canned-responses.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const root = "/api/v1/inbox/canned-responses";
const hashSecret = "canned-response-test-hash-secret-0123456789";
const content = { shortcut: "order_status", title: "Order status", body: "We are checking your order." };

describe("tenant canned response HTTP and PostgreSQL integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let keyA: string;
  let keyB: string;
  let readKey: string;
  let writeKey: string;
  let tenants: string[];

  async function key(tenantId: string, scopes: string[]) {
    const generated = generateApiKey();
    await prisma.apiKey.create({ data: { tenantId, name: "Canned response integration", prefix: generated.prefix, keyHash: hashApiKey(generated.rawKey, hashSecret), scopes } });
    return generated.rawKey;
  }
  const create = (apiKey = keyA, body: Record<string, unknown> = content) => request(app.getHttpServer()).post(root).set("X-API-Key", apiKey).send(body);
  const get = (path = root, apiKey = keyA) => request(app.getHttpServer()).get(path).set("X-API-Key", apiKey);
  const patch = (id: string, body: Record<string, unknown>, apiKey = keyA) => request(app.getHttpServer()).patch(`${root}/${id}`).set("X-API-Key", apiKey).send(body);

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) if (!process.env[name]) throw new Error(`${name} is required`);
    Object.assign(process.env, {
      NODE_ENV: "test", API_KEY_HASH_SECRET: hashSecret, META_GRAPH_API_VERSION: "v99.0",
      META_APP_SECRET: "canned-response-integration-secret", META_WEBHOOK_VERIFY_TOKEN: "canned-response-verify-token",
      OUTBOUND_QUEUE_NAME: `whatsapp.canned.integration.${process.pid}.${Date.now()}`,
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
    for (const label of ["a", "b"]) {
      const tenant = await prisma.tenant.create({ data: { name: `Canned ${label}`, slug: `canned-${label}-${randomUUID()}` } });
      tenants.push(tenant.id);
    }
    [tenantA, tenantB] = tenants;
    keyA = await key(tenantA, [ApiScope.INBOX_READ, ApiScope.INBOX_WRITE]);
    keyB = await key(tenantB, [ApiScope.INBOX_READ, ApiScope.INBOX_WRITE]);
    readKey = await key(tenantA, [ApiScope.INBOX_READ]);
    writeKey = await key(tenantA, [ApiScope.INBOX_WRITE]);
  });
  afterEach(async () => {
    if (prisma && tenants?.length) await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  });
  afterAll(async () => { await app?.close(); });

  it("creates, reads, edits, deactivates and reactivates a response", async () => {
    const created = await create(keyA, { shortcut: " ORDER_Status ", title: " Order status ", body: " We are checking your order. " }).expect(201);
    expect(created.body).toMatchObject({ ...content, active: true, revision: 1 });
    expect(Object.keys(created.body).sort()).toEqual(["active", "body", "createdAt", "id", "revision", "shortcut", "title", "updatedAt"]);
    expect(created.headers["cache-control"]).toBe("private, no-store");
    const id = created.body.id as string;
    expect((await get(`${root}/${id}`).expect(200)).body).toEqual(created.body);
    const edited = await patch(id, { expectedRevision: 1, body: "Updated response" }).expect(200);
    expect(edited.body).toMatchObject({ body: "Updated response", revision: 2 });
    await patch(id, { expectedRevision: 2, active: false }).expect(200);
    expect((await get().expect(200)).body.items).toHaveLength(0);
    expect((await get(`${root}?status=inactive`).expect(200)).body.items).toHaveLength(1);
    expect((await get(`${root}/${id}`).expect(200)).body.active).toBe(false);
    expect((await patch(id, { expectedRevision: 3, active: true }).expect(200)).body.revision).toBe(4);
    expect((await get(`${root}?shortcut=ORDER_STATUS`).expect(200)).body.items).toHaveLength(1);
    await request(app.getHttpServer()).delete(`${root}/${id}`).set("X-API-Key", keyA).expect(404);
  });

  it("keeps shortcuts unique after normalization and while inactive", async () => {
    const first = await create().expect(201);
    await create(keyA, { ...content, shortcut: " ORDER_STATUS " }).expect(409);
    await patch(first.body.id, { expectedRevision: 1, active: false }).expect(200);
    await create().expect(409);
    await create(keyB).expect(201);
    expect(await prisma.inboxCannedResponse.count({ where: { tenantId: tenantA } })).toBe(1);
  });

  it("returns a single winner for concurrent duplicate creates", async () => {
    const results = await Promise.all([create(), create()]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await prisma.inboxCannedResponse.count({ where: { tenantId: tenantA } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA } })).toBe(1);
  });

  it("returns a single winner for concurrent edits using the same revision", async () => {
    const item = (await create().expect(201)).body;
    const results = await Promise.all([patch(item.id, { expectedRevision: 1, body: "First edit" }), patch(item.id, { expectedRevision: 1, body: "Second edit" })]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200)!;
    const current = await prisma.inboxCannedResponse.findUniqueOrThrow({ where: { id: item.id } });
    expect(current.body).toBe(winner.body.body);
    expect(current.revision).toBe(2);
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA } })).toBe(2);
    await patch(item.id, { expectedRevision: 1, active: false }).expect(409);
  });

  it("rolls back a shortcut collision without consuming the revision", async () => {
    await create().expect(201);
    const second = (await create(keyA, { ...content, shortcut: "other" }).expect(201)).body;
    await patch(second.id, { expectedRevision: 1, shortcut: "order_status" }).expect(409);
    expect((await get(`${root}/${second.id}`).expect(200)).body).toMatchObject({ shortcut: "other", revision: 1 });
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA } })).toBe(2);
  });

  it("enforces independent read and write scopes", async () => {
    const item = (await create(writeKey).expect(201)).body;
    await get(root, readKey).expect(200);
    await get(`${root}/${item.id}`, readKey).expect(200);
    await get(root, writeKey).expect(403);
    await get(`${root}/${item.id}`, writeKey).expect(403);
    await create(readKey, { ...content, shortcut: "blocked" }).expect(403);
    await patch(item.id, { expectedRevision: 1, active: false }, readKey).expect(403);
    await patch(item.id, { expectedRevision: 1, active: false }, writeKey).expect(200);
  });

  it("requires a valid API key", async () => {
    await request(app.getHttpServer()).get(root).expect(401);
    await get(root, "invalid").expect(401);
    await request(app.getHttpServer()).post(root).send(content).expect(401);
  });

  it("isolates lists, detail, update and cursors across tenants", async () => {
    const item = (await create().expect(201)).body;
    expect((await get(root, keyB).expect(200)).body).toEqual({ items: [], nextCursor: null });
    const foreign = await get(`${root}/${item.id}`, keyB).expect(404);
    const absent = await get(`${root}/${randomUUID()}`, keyB).expect(404);
    expect(foreign.body.message).toEqual(absent.body.message);
    await patch(item.id, { expectedRevision: 1, active: false }, keyB).expect(404);
    const foreignCursor = await get(`${root}?cursor=${item.id}`, keyB).expect(400);
    const absentCursor = await get(`${root}?cursor=${randomUUID()}`, keyB).expect(400);
    expect(foreignCursor.body.message).toEqual(absentCursor.body.message);
    expect((await get(`${root}/${item.id}`).expect(200)).body.revision).toBe(1);
  });

  it("rejects tenant and internal fields supplied by callers", async () => {
    await create(keyA, { ...content, tenantId: tenantB }).expect(400);
    await create(keyA, { ...content, revision: 99 }).expect(400);
    const item = (await create().expect(201)).body;
    await patch(item.id, { expectedRevision: 1, tenantId: tenantB }).expect(400);
    await get(`${root}?tenantId=${tenantB}`).expect(400);
  });

  it("requires an explicit current numeric revision and a mutable field", async () => {
    const item = (await create().expect(201)).body;
    for (const input of [{ title: "Missing revision" }, { expectedRevision: "1", title: "String revision" }, { expectedRevision: 1 }, { expectedRevision: 1, active: null }, { expectedRevision: 1, body: null }]) {
      await patch(item.id, input).expect(400);
    }
    expect((await get(`${root}/${item.id}`).expect(200)).body.revision).toBe(1);
  });

  it("rejects invalid content without partially writing", async () => {
    for (const body of [" ", "x".repeat(4097), "contains\0nul", "\ud800"]) {
      await create(keyA, { ...content, body }).expect(400);
    }
    expect(await prisma.inboxCannedResponse.count({ where: { tenantId: tenantA } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA } })).toBe(0);
  });

  it("preserves literal template-like text and supports maximum Unicode body length", async () => {
    const body = "\u{1f600}".repeat(4096);
    const item = (await create(keyA, { ...content, body }).expect(201)).body;
    expect(item.body).toBe(body);
    const literal = "{{customer.name}} <script>alert('literal')</script>";
    expect((await patch(item.id, { expectedRevision: 1, body: literal }).expect(200)).body.body).toBe(literal);
  });

  it("traverses 107 tied-time rows without repetition or missing results", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    await prisma.inboxCannedResponse.createMany({ data: Array.from({ length: 107 }, (_, index) => ({ tenantId: tenantA, shortcut: `reply_${index}`, title: `Reply ${index}`, body: "Text", createdAt })) });
    const expected = await prisma.inboxCannedResponse.findMany({ where: { tenantId: tenantA }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const result = await get(`${root}?limit=25${cursor ? `&cursor=${cursor}` : ""}`).expect(200);
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(result.body.items.length).toBe(page === 4 ? 7 : 25);
      ids.push(...result.body.items.map((item: { id: string }) => item.id));
      cursor = result.body.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(ids).toEqual(expected.map((item) => item.id));
    expect(new Set(ids).size).toBe(107);
    expect((await get(`${root}?cursor=${ids.at(-1)}`).expect(200)).body).toEqual({ items: [], nextCursor: null });
  });

  it("does not repeat earlier pages when newer responses are inserted", async () => {
    await prisma.inboxCannedResponse.createMany({ data: Array.from({ length: 4 }, (_, index) => ({ tenantId: tenantA, shortcut: `old_${index}`, title: "Old", body: "Text", createdAt: new Date("2026-01-01T00:00:00.000Z") })) });
    const first = (await get(`${root}?limit=2`).expect(200)).body;
    const newest = (await create().expect(201)).body;
    const second = (await get(`${root}?limit=2&cursor=${first.nextCursor}`).expect(200)).body;
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain(newest.id);
    expect((await get(`${root}?limit=1`).expect(200)).body.items[0].id).toBe(newest.id);
  });

  for (const query of ["limit=101", "limit=1e2", "limit=01", "limit=2&limit=3", "status=unknown", "cursor=bad"]) {
    it(`rejects malformed HTTP query ${query}`, async () => { await get(`${root}?${query}`).expect(400); });
  }

  it("writes safe audit metadata atomically and has no messaging side effects", async () => {
    const item = (await create().expect(201)).body;
    await patch(item.id, { expectedRevision: 1, title: "Secret edited title" }).expect(200);
    const audits = await prisma.auditLog.findMany({ where: { tenantId: tenantA }, orderBy: { createdAt: "asc" } });
    expect(audits).toHaveLength(2);
    expect(audits.map((audit) => audit.action)).toEqual(["inbox.canned_response.created", "inbox.canned_response.updated"]);
    const metadata = JSON.stringify(audits.map((audit) => audit.metadata));
    for (const value of [content.body, content.title, content.shortcut, "Secret edited title", keyA]) expect(metadata).not.toContain(value);
    await get().expect(200);
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA } })).toBe(2);
    expect(await prisma.message.count({ where: { tenantId: tenantA } })).toBe(0);
    expect(await prisma.conversation.count({ where: { tenantId: tenantA } })).toBe(0);
    expect(await prisma.messageTemplate.count({ where: { tenantId: tenantA } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: item.id } })).toBe(0);
  });

  it("rolls back create and update when the audit actor FK fails", async () => {
    const service = app.get(CannedResponsesService);
    const invalidActor = { tenantId: tenantA, apiKeyId: randomUUID(), scopes: [ApiScope.INBOX_WRITE] };
    await expect(service.create(invalidActor, content)).rejects.toBeDefined();
    expect(await prisma.inboxCannedResponse.count({ where: { tenantId: tenantA } })).toBe(0);
    const item = (await create().expect(201)).body;
    await expect(service.update(invalidActor, item.id, { expectedRevision: 1, body: "Must roll back" })).rejects.toBeDefined();
    expect((await get(`${root}/${item.id}`).expect(200)).body).toMatchObject({ revision: 1, body: content.body });
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA } })).toBe(1);
  });

  it("enforces database checks and the tenant foreign key", async () => {
    for (const data of [{ ...content, shortcut: "Invalid" }, { ...content, body: "" }, { ...content, revision: 0 }]) {
      await expect(prisma.inboxCannedResponse.create({ data: { tenantId: tenantA, ...data } })).rejects.toBeDefined();
    }
    await expect(prisma.inboxCannedResponse.create({ data: { tenantId: randomUUID(), ...content } })).rejects.toBeDefined();
  });

  it("cascades tenant deletion without leaving reusable-response rows", async () => {
    const item = (await create().expect(201)).body;
    await prisma.tenant.delete({ where: { id: tenantA } });
    expect(await prisma.inboxCannedResponse.findUnique({ where: { id: item.id } })).toBeNull();
  });

  it("publishes all four operations and required revision in OpenAPI", () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("Canned response integration").setVersion("test").addApiKey({ type: "apiKey", in: "header", name: "X-API-Key" }, "apiKey").build());
    expect(document.paths[root]?.post?.responses["201"]).toBeDefined();
    expect(document.paths[root]?.get?.security).toEqual([{ apiKey: [] }]);
    expect(document.paths[`${root}/{id}`]?.get).toBeDefined();
    expect(document.paths[`${root}/{id}`]?.patch?.responses["409"]).toBeDefined();
    expect(document.components?.schemas?.UpdateCannedResponseDto).toMatchObject({ required: expect.arrayContaining(["expectedRevision"]) });
  });
});
