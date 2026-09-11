import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "note-history-integration-secret-0123456789abcdef";
const route = (id: string): string => `/api/v1/inbox/conversations/${id}/notes`;

type NoteResponse = {
  id: string;
  conversationId: string;
  body: string;
  createdAt: string;
  createdByApiKey: { id: string; name: string } | null;
};
type NotePage = { items: NoteResponse[]; nextCursor: string | null };

describe("conversation note history integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tenantIds: string[] = [];
  let tenantA: string;
  let senderA: string;
  let conversationA: string;
  let emptyConversation: string;
  let foreignConversation: string;
  let foreignCursor: string;
  let siblingCursor: string;
  let readKey: string;
  let writeKey: string;
  let allKey: string;
  let allKeyId: string;
  let foreignKey: string;
  let inactiveKey: string;
  let expected: Array<{ id: string; createdAt: Date }>;
  const originalEnv = new Map<string, string | undefined>();

  async function createKey(tenantId: string, scopes: string[], active = true) {
    const generated = generateApiKey();
    const key = await prisma.apiKey.create({ data: {
      tenantId, name: "Note history test key", prefix: generated.prefix,
      keyHash: hashApiKey(generated.rawKey, HASH_SECRET), scopes, active,
    } });
    return { id: key.id, raw: generated.rawKey };
  }

  async function createConversation(tenantId: string, senderId: string) {
    const contact = await prisma.contact.create({ data: { tenantId, phone: randomUUID() } });
    return prisma.conversation.create({ data: {
      tenantId, senderId, contactId: contact.id, lastMessageAt: new Date(), unreadCount: 3,
    } });
  }

  function getNotes(id: string, query = "", key = readKey) {
    return request(app.getHttpServer()).get(`${route(id)}${query}`).set("X-API-Key", key);
  }

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required for integration tests`);
    }
    const env = {
      NODE_ENV: "test",
      API_KEY_HASH_SECRET: HASH_SECRET,
      OUTBOUND_QUEUE_NAME: `whatsapp.note-history.${randomUUID()}`,
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

    for (let index = 0; index < 2; index += 1) {
      const tenant = await prisma.tenant.create({ data: {
        name: "Note history tenant", slug: `note-history-${randomUUID()}`,
      } });
      tenantIds.push(tenant.id);
    }
    tenantA = tenantIds[0];
    const tenantB = tenantIds[1];
    const senders = [];
    for (const tenantId of tenantIds) {
      senders.push(await prisma.whatsAppPhoneNumber.create({ data: {
        tenantId, providerPhoneNumberId: `note-history-${randomUUID()}`,
        credentialRef: "env:NOTE_HISTORY_UNUSED_TOKEN", active: true,
      } }));
    }
    senderA = senders[0].id;
    conversationA = (await createConversation(tenantA, senderA)).id;
    emptyConversation = (await createConversation(tenantA, senderA)).id;
    const sibling = await createConversation(tenantA, senderA);
    foreignConversation = (await createConversation(tenantB, senders[1].id)).id;
    readKey = (await createKey(tenantA, [ApiScope.INBOX_READ])).raw;
    writeKey = (await createKey(tenantA, [ApiScope.INBOX_WRITE])).raw;
    const writer = await createKey(tenantA, [ApiScope.INBOX_READ, ApiScope.INBOX_WRITE]);
    allKey = writer.raw;
    allKeyId = writer.id;
    foreignKey = (await createKey(tenantB, [ApiScope.INBOX_READ])).raw;
    inactiveKey = (await createKey(tenantA, [ApiScope.INBOX_READ], false)).raw;

    const notes = Array.from({ length: 105 }, (_, index) => ({
      id: randomUUID(), tenantId: tenantA, conversationId: conversationA,
      createdByApiKeyId: allKeyId, body: `Internal note ${index}`,
      // Five notes per timestamp exercise stable tie-breaking on every traversal.
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(index / 5))),
    }));
    await prisma.conversationNote.createMany({ data: notes });
    expected = [...notes].sort((left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() ||
      (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
    );
    foreignCursor = (await prisma.conversationNote.create({ data: {
      tenantId: tenantB, conversationId: foreignConversation, body: "Foreign tenant private note",
    } })).id;
    siblingCursor = (await prisma.conversationNote.create({ data: {
      tenantId: tenantA, conversationId: sibling.id, body: "Another conversation private note",
    } })).id;
  }, 30000);

  afterAll(async () => {
    try {
      if (prisma && tenantIds.length) {
        const where = { tenantId: { in: tenantIds } };
        await prisma.conversationNote.deleteMany({ where });
        await prisma.conversation.deleteMany({ where });
        await prisma.contact.deleteMany({ where });
        await prisma.whatsAppPhoneNumber.deleteMany({ where });
        await prisma.auditLog.deleteMany({ where });
        await prisma.apiKey.deleteMany({ where });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }
    } finally {
      try { await app?.close(); } finally {
        for (const [name, value] of originalEnv) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
  });

  it("returns the default page with safe author fields and private no-store caching", async () => {
    const response = await getNotes(conversationA).expect(200);
    const page = response.body as NotePage;
    expect(page.items.map((note) => note.id)).toEqual(expected.slice(0, 50).map((note) => note.id));
    expect(page.nextCursor).toBe(expected[49].id);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    for (const note of page.items) {
      expect(Object.keys(note).sort()).toEqual(["body", "conversationId", "createdAt", "createdByApiKey", "id"]);
      expect(note.conversationId).toBe(conversationA);
      expect(note.createdByApiKey).toEqual({ id: allKeyId, name: "Note history test key" });
    }
    expect(response.text).not.toContain(allKey);
    expect(response.text).not.toContain("keyHash");
    expect(response.text).not.toContain("Foreign tenant private note");
  });

  it("reads beyond the existing 100-note conversation preview without changing that preview", async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/inbox/conversations/${conversationA}`).set("X-API-Key", readKey).expect(200);
    expect(detail.body.notes).toHaveLength(100);
    const first = (await getNotes(conversationA, "?limit=100").expect(200)).body as NotePage;
    const last = (await getNotes(conversationA, `?limit=100&cursor=${first.nextCursor}`).expect(200)).body as NotePage;
    expect([...first.items, ...last.items].map((note) => note.id)).toEqual(expected.map((note) => note.id));
    expect(last.items).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
  });

  it("traverses timestamp ties without duplicate or missing notes and terminates on a full final page", async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `?limit=7${cursor ? `&cursor=${cursor}` : ""}`;
      const page = (await getNotes(conversationA, query).expect(200)).body as NotePage;
      expect(page.items).toHaveLength(7);
      if (cursor) expect(page.items.map((note) => note.id)).not.toContain(cursor);
      ids.push(...page.items.map((note) => note.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(15);
    } while (cursor);
    expect(ids).toEqual(expected.map((note) => note.id));
    expect(new Set(ids).size).toBe(105);
  });

  it("returns an empty page for an owned conversation and after the oldest note", async () => {
    expect((await getNotes(emptyConversation).expect(200)).body).toEqual({ items: [], nextCursor: null });
    expect((await getNotes(conversationA, `?cursor=${expected.at(-1)!.id}`).expect(200)).body)
      .toEqual({ items: [], nextCursor: null });
  });

  it("does not shift older pages when a newer note is appended between requests", async () => {
    const conversation = await createConversation(tenantA, senderA);
    const rows = Array.from({ length: 4 }, (_, index) => ({
      id: randomUUID(), tenantId: tenantA, conversationId: conversation.id, body: `Older note ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    }));
    await prisma.conversationNote.createMany({ data: rows });
    const first = (await getNotes(conversation.id, "?limit=2").expect(200)).body as NotePage;
    const added = await request(app.getHttpServer()).post(route(conversation.id))
      .set("X-API-Key", allKey).send({ body: "Newer internal note" }).expect(201);
    const last = (await getNotes(conversation.id, `?limit=2&cursor=${first.nextCursor}`).expect(200)).body as NotePage;
    expect([...first.items, ...last.items].map((note) => note.id)).toEqual(rows.reverse().map((note) => note.id));
    expect(last.nextCursor).toBeNull();
    const refreshed = (await getNotes(conversation.id, "?limit=1").expect(200)).body as NotePage;
    expect(refreshed.items[0].id).toBe(added.body.id);
  });

  it("keeps an append-only note readable after its author key is deleted", async () => {
    const conversation = await createConversation(tenantA, senderA);
    const author = await createKey(tenantA, [ApiScope.INBOX_WRITE]);
    const added = await request(app.getHttpServer()).post(route(conversation.id))
      .set("X-API-Key", author.raw).send({ body: "Historical note" }).expect(201);
    await prisma.apiKey.delete({ where: { id: author.id } });
    const page = (await getNotes(conversation.id).expect(200)).body as NotePage;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: added.body.id, body: "Historical note", createdByApiKey: null });
  });

  it("requires inbox:read independently of inbox:write", async () => {
    await getNotes(conversationA, "", writeKey).expect(403);
    await request(app.getHttpServer()).post(route(conversationA))
      .set("X-API-Key", readKey).send({ body: "Must not be created" }).expect(403);
    await getNotes(conversationA).expect(200);
  });

  it("rejects missing and inactive credentials", async () => {
    await request(app.getHttpServer()).get(route(conversationA)).expect(401);
    await getNotes(conversationA, "", inactiveKey).expect(401);
  });

  it("does not distinguish a foreign conversation from a missing conversation", async () => {
    const missing = await getNotes(randomUUID()).expect(404);
    const foreign = await getNotes(foreignConversation).expect(404);
    expect(foreign.body).toEqual(missing.body);
    await getNotes(conversationA, "", foreignKey).expect(404);
    const allowed = (await getNotes(foreignConversation, "", foreignKey).expect(200)).body as NotePage;
    expect(allowed.items.map((note) => note.id)).toEqual([foreignCursor]);
  });

  it("rejects unknown, foreign-tenant and sibling-conversation cursors identically", async () => {
    const missing = await getNotes(conversationA, `?cursor=${randomUUID()}`).expect(400);
    for (const cursor of [foreignCursor, siblingCursor]) {
      const response = await getNotes(conversationA, `?cursor=${cursor}`).expect(400);
      expect(response.body).toEqual(missing.body);
    }
    await getNotes(foreignConversation, `?cursor=${expected[0].id}`).expect(404);
  });

  for (const query of [
    "?limit=0", "?limit=101", "?limit=1.5", "?limit=1e2", "?limit=0x10", "?limit=",
    "?limit=1&limit=2", "?cursor=bad", "?cursor=", "?cursor[]=bad", "?tenantId=untrusted",
  ]) {
    it(`rejects invalid HTTP query ${query}`, async () => {
      await getNotes(conversationA, query).expect(400);
    });
  }

  it("rejects malformed conversation identifiers", async () => {
    await getNotes("not-a-uuid").expect(400);
  });

  it("does not change conversation activity, unread state, notes or audit logs when reading", async () => {
    const before = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationA } });
    const noteCount = await prisma.conversationNote.count({ where: { tenantId: tenantA } });
    const auditCount = await prisma.auditLog.count({ where: { tenantId: tenantA } });
    await getNotes(conversationA).expect(200);
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversationA } })).toEqual(before);
    expect(await prisma.conversationNote.count({ where: { tenantId: tenantA } })).toBe(noteCount);
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA } })).toBe(auditCount);
    expect(await prisma.message.count({ where: { tenantId: tenantA } })).toBe(0);
  });

  it("publishes the response schema, scope security and query limits in OpenAPI", () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder()
      .setTitle("Note history integration").setVersion("test")
      .addApiKey({ type: "apiKey", in: "header", name: "X-API-Key" }, "apiKey").build());
    const operation = document.paths["/api/v1/inbox/conversations/{conversationId}/notes"]?.get;
    expect(operation).toBeDefined();
    expect(operation?.security).toEqual([{ apiKey: [] }]);
    expect(operation?.responses["200"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationNotePageDto" } } },
    });
    expect(operation?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "limit", in: "query", schema: expect.objectContaining({ maximum: 100, default: 50 }) }),
    ]));
  });
});
