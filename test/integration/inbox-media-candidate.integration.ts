import { jest } from "@jest/globals";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { MediaMalwareScannerService } from "../../src/media/media-malware-scanner.service.js";
import { MediaService } from "../../src/media/media.service.js";
import { MetaSenderResolverService } from "../../src/meta/meta-sender-resolver.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import { invalidOggOpusFixtures, validOggOpus } from "../helpers/ogg-opus-fixtures.js";

const root = "/api/v1/inbox/canned-responses";
const secret = "candidate-integration-key-secret-0123456789abcdef";
const originalBody = "Internal handling instruction, not a WhatsApp send.";
type Page = { items: Array<{ id: string; body: string }>; nextCursor: string | null };

describe("combined inbox, note history and Opus candidate", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storageRoot: string;
  let tenantId: string;
  let foreignTenantId: string;
  let senderId: string;
  let conversationId: string;
  let allKey: string;
  let readKey: string;
  let writeKey: string;
  let mediaKey: string;
  let foreignKey: string;
  let tenantIds: string[] = [];
  const originalEnv = new Map<string, string | undefined>();
  const notes = () => `/api/v1/inbox/conversations/${conversationId}/notes`;
  const get = (url: string, key = allKey) => request(app.getHttpServer()).get(url).set("X-API-Key", key);
  const post = (url: string, body: Record<string, unknown>, key = allKey) => request(app.getHttpServer()).post(url).set("X-API-Key", key).send(body);
  const patch = (id: string, body: Record<string, unknown>) => request(app.getHttpServer()).patch(`${root}/${id}`).set("X-API-Key", allKey).send(body);
  const snippet = () => post(root, { shortcut: "internal_instruction", title: "Internal instruction", body: originalBody });
  const upload = (bytes: Buffer, key = allKey) => request(app.getHttpServer()).post("/api/v1/media").set("X-API-Key", key)
    .field("senderId", senderId).attach("file", bytes, { filename: "candidate.ogg", contentType: "audio/ogg" });

  async function key(tenant: string, scopes: string[]): Promise<string> {
    const generated = generateApiKey();
    await prisma.apiKey.create({ data: {
      tenantId: tenant, name: "Candidate integration", prefix: generated.prefix,
      keyHash: hashApiKey(generated.rawKey, secret), scopes,
    } });
    return generated.rawKey;
  }

  async function expectNoMessagingEffects(): Promise<void> {
    expect(await prisma.message.count({ where: { tenantId } })).toBe(0);
    const snippets = await prisma.inboxCannedResponse.findMany({ where: { tenantId }, select: { id: true } });
    const savedNotes = await prisma.conversationNote.findMany({ where: { tenantId }, select: { id: true } });
    const aggregateIds = [conversationId, ...snippets.map((item) => item.id), ...savedNotes.map((item) => item.id)];
    expect(await prisma.outboxEvent.count({ where: { aggregateId: { in: aggregateIds } } })).toBe(0);
    expect(await prisma.mediaAsset.count({ where: { tenantId } })).toBe(0);
  }

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required for integration tests`);
    }
    storageRoot = await mkdtemp(join(tmpdir(), "api-whatsapp-candidate-"));
    const env = {
      NODE_ENV: "test", API_KEY_HASH_SECRET: secret, META_GRAPH_API_VERSION: "v99.0",
      // No provider request is part of this suite. Even a regression stays on loopback.
      META_GRAPH_API_BASE_URL: "http://127.0.0.1:9", META_HTTP_TIMEOUT_MS: "1000",
      META_APP_SECRET: "candidate-test-app-secret", META_WEBHOOK_VERIFY_TOKEN: "candidate-verify",
      MEDIA_MALWARE_SCAN_MODE: "disabled", MEDIA_BINARY_STORAGE_MODE: "filesystem",
      MEDIA_FILESYSTEM_STORAGE_PATH: storageRoot, MEDIA_FILESYSTEM_MIN_FREE_BYTES: "0",
      MEDIA_FILESYSTEM_MIN_FREE_PERCENT: "0", MEDIA_ASSET_TTL_DAYS: "7",
      MEDIA_ASSET_CLEANUP_INTERVAL_MS: "3600000", OUTBOUND_QUEUE_NAME: `whatsapp.candidate.${randomUUID()}`,
      OUTBOX_POLL_INTERVAL_MS: "60000", WEBHOOK_PROCESSOR_INTERVAL_MS: "60000",
      CAMPAIGN_PROCESSOR_INTERVAL_MS: "60000", OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
    };
    for (const [name, value] of Object.entries(env)) {
      originalEnv.set(name, process.env[name]);
      process.env[name] = value;
    }
    const { AppModule } = await import("../../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    tenantIds = [];
    for (const label of ["local", "foreign"]) {
      const tenant = await prisma.tenant.create({ data: { name: `Candidate ${label}`, slug: `candidate-${randomUUID()}` } });
      tenantIds.push(tenant.id);
    }
    [tenantId, foreignTenantId] = tenantIds;
    const sender = await prisma.whatsAppPhoneNumber.create({ data: {
      tenantId, providerPhoneNumberId: `candidate-${randomUUID()}`,
      credentialRef: "env:CANDIDATE_UNUSED_TOKEN", active: true, isDefault: true,
    } });
    senderId = sender.id;
    const contact = await prisma.contact.create({ data: { tenantId, phone: randomUUID() } });
    conversationId = (await prisma.conversation.create({ data: {
      tenantId, senderId, contactId: contact.id, unreadCount: 3, lastMessageAt: new Date(),
    } })).id;
    allKey = await key(tenantId, [ApiScope.INBOX_READ, ApiScope.INBOX_WRITE, ApiScope.MEDIA_READ, ApiScope.MEDIA_WRITE]);
    readKey = await key(tenantId, [ApiScope.INBOX_READ]);
    writeKey = await key(tenantId, [ApiScope.INBOX_WRITE]);
    mediaKey = await key(tenantId, [ApiScope.MEDIA_READ, ApiScope.MEDIA_WRITE]);
    foreignKey = await key(foreignTenantId, [ApiScope.INBOX_READ, ApiScope.INBOX_WRITE]);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (prisma && tenantIds.length) {
      const where = { tenantId: { in: tenantIds } };
      const messages = await prisma.message.findMany({ where, select: { id: true } });
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: messages.map((item) => item.id) } } });
      await prisma.message.deleteMany({ where });
      await prisma.conversationNote.deleteMany({ where });
      await prisma.conversation.deleteMany({ where });
      await prisma.inboxCannedResponse.deleteMany({ where });
      await prisma.mediaAsset.deleteMany({ where });
      await prisma.contact.deleteMany({ where });
      await prisma.whatsAppPhoneNumber.deleteMany({ where });
      await prisma.auditLog.deleteMany({ where });
      await prisma.apiKey.deleteMany({ where });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    try { await app?.close(); } catch (error) { failures.push(error); }
    try { if (storageRoot) await rm(storageRoot, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (failures.length) throw new AggregateError(failures, "Candidate integration cleanup failed");
  });

  it("keeps an explicitly copied internal note independent from subsequent snippet edits", async () => {
    const before = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const saved = (await snippet().expect(201)).body;
    const note = (await post(notes(), { body: saved.body }).expect(201)).body;
    await patch(saved.id, { expectedRevision: 1, body: "Changed snippet", active: false }).expect(200);
    const history = await get(notes(), readKey).expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({ id: note.id, body: originalBody, conversationId });
    expect(Object.keys(history.body.items[0].createdByApiKey).sort()).toEqual(["id", "name"]);
    expect(history.headers["cache-control"]).toBe("private, no-store");
    expect((await get(root).expect(200)).body.items).toHaveLength(0);
    expect((await get(`${root}?status=inactive`).expect(200)).body.items[0]).toMatchObject({ id: saved.id, body: "Changed snippet", revision: 2 });
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toEqual(before);
    const audit = JSON.stringify(await prisma.auditLog.findMany({ where: { tenantId }, select: { metadata: true } }));
    expect(audit).not.toContain(originalBody);
    expect(audit).not.toContain("Changed snippet");
    await expectNoMessagingEffects();
  });

  it("keeps snippet revisions atomic while notes are appended concurrently", async () => {
    const saved = (await snippet().expect(201)).body;
    const results = await Promise.all([
      patch(saved.id, { expectedRevision: 1, title: "First edit" }),
      patch(saved.id, { expectedRevision: 1, title: "Second edit" }),
      post(notes(), { body: "First concurrent note" }),
      post(notes(), { body: "Second concurrent note" }),
    ]);
    expect(results.slice(0, 2).map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.slice(2).map((result) => result.status)).toEqual([201, 201]);
    expect((await get(`${root}/${saved.id}`).expect(200)).body.revision).toBe(2);
    expect((await get(notes()).expect(200)).body.items.map((item: { body: string }) => item.body).sort())
      .toEqual(["First concurrent note", "Second concurrent note"]);
    await expectNoMessagingEffects();
  });

  it("traverses notes and snippets independently when a snippet anchor is deactivated", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.123Z");
    await prisma.inboxCannedResponse.createMany({ data: Array.from({ length: 5 }, (_, index) => ({
      tenantId, shortcut: `reply_${index}`, title: `Reply ${index}`, body: `Snippet ${index}`, createdAt,
    })) });
    await prisma.conversationNote.createMany({ data: Array.from({ length: 5 }, (_, index) => ({
      tenantId, conversationId, body: `Note ${index}`, createdAt,
    })) });
    const snippetOrder = await prisma.inboxCannedResponse.findMany({ where: { tenantId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    const noteOrder = await prisma.conversationNote.findMany({ where: { tenantId, conversationId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    const firstSnippets = (await get(`${root}?limit=2`).expect(200)).body as Page;
    const firstNotes = (await get(`${notes()}?limit=2`).expect(200)).body as Page;
    expect(firstSnippets.nextCursor).toBe(snippetOrder[1].id);
    expect(firstNotes.nextCursor).toBe(noteOrder[1].id);
    await patch(firstSnippets.nextCursor!, { expectedRevision: 1, active: false }).expect(200);
    await post(notes(), { body: "Newer note between pages" }).expect(201);
    const secondSnippets = (await get(`${root}?limit=2&cursor=${firstSnippets.nextCursor}`).expect(200)).body as Page;
    const secondNotes = (await get(`${notes()}?limit=2&cursor=${firstNotes.nextCursor}`).expect(200)).body as Page;
    expect(secondSnippets.items.map((item) => item.id)).toEqual(snippetOrder.slice(2, 4).map((item) => item.id));
    expect(secondNotes.items.map((item) => item.id)).toEqual(noteOrder.slice(2, 4).map((item) => item.id));
    for (const [url, page, expected] of [[root, secondSnippets, snippetOrder], [notes(), secondNotes, noteOrder]] as const) {
      const last = (await get(`${url}?limit=2&cursor=${page.nextCursor}`).expect(200)).body as Page;
      expect(last.items.map((item) => item.id)).toEqual([expected[4].id]);
      expect(last.nextCursor).toBeNull();
    }
    await expectNoMessagingEffects();
  });

  it("does not accept another resource type or another tenant as a pagination anchor", async () => {
    const saved = (await snippet().expect(201)).body;
    const note = (await post(notes(), { body: "Private note" }).expect(201)).body;
    await get(`${notes()}?cursor=${saved.id}`).expect(400);
    await get(`${root}?cursor=${note.id}`).expect(400);
    await get(`${root}/${note.id}`).expect(404);
    await get(notes(), foreignKey).expect(404);
    await get(`${root}/${saved.id}`, foreignKey).expect(404);
    await get(`${root}?cursor=${saved.id}`, foreignKey).expect(400);
    expect((await get(root, foreignKey).expect(200)).body).toEqual({ items: [], nextCursor: null });
    expect(await prisma.conversationNote.count({ where: { tenantId } })).toBe(1);
    await expectNoMessagingEffects();
  });

  it("keeps inbox read, inbox write and media permissions independent in the same runtime", async () => {
    const saved = (await post(root, { shortcut: "write_only", title: "Writer", body: originalBody }, writeKey).expect(201)).body;
    await post(notes(), { body: originalBody }, writeKey).expect(201);
    for (const url of [root, `${root}/${saved.id}`, notes()]) {
      await get(url, readKey).expect(200);
      await get(url, writeKey).expect(403);
      await get(url, mediaKey).expect(403);
      await request(app.getHttpServer()).get(url).expect(401);
    }
    await post(notes(), { body: "Not allowed" }, readKey).expect(403);
    await post(root, { shortcut: "blocked", title: "Blocked", body: "No write scope" }, readKey).expect(403);
    await upload(validOggOpus(), readKey).expect(403);
    await upload(validOggOpus(), writeKey).expect(403);
    await expectNoMessagingEffects();
  });

  it.each(invalidOggOpusFixtures().filter((fixture) => ["codec-less Ogg", "stereo output", "invalid audio framing"].includes(fixture.name)))
    ("preserves early rejection and temporary-file cleanup for $name with both inbox modules loaded", async ({ bytes }) => {
      await snippet().expect(201);
      await post(notes(), { body: "Unaffected note" }).expect(201);
      const media = jest.spyOn(app.get(MediaService), "upload");
      // Fail closed rather than contacting any external dependency if admission regresses.
      const scan = jest.spyOn(app.get(MediaMalwareScannerService), "scan").mockRejectedValue(new Error("Unexpected scan"));
      const resolve = jest.spyOn(app.get(MetaSenderResolverService), "resolveForTenant").mockRejectedValue(new Error("Unexpected sender resolution"));
      await upload(bytes).expect(400);
      expect(scan).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(media).toHaveBeenCalledTimes(1);
      const path = media.mock.calls[0]?.[2]?.path;
      expect(typeof path).toBe("string");
      await expect(stat(path!)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await get(root).expect(200)).body.items).toHaveLength(1);
      expect((await get(notes()).expect(200)).body.items[0].body).toBe("Unaffected note");
      await expectNoMessagingEffects();
    });

  it("publishes all combined operations in OpenAPI without shadowing shared note paths", () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addApiKey({ type: "apiKey", in: "header", name: "X-API-Key" }, "apiKey").build());
    const notePath = document.paths["/api/v1/inbox/conversations/{id}/notes"];
    const libraryPath = document.paths[root];
    expect(notePath?.get).toBeDefined();
    expect(notePath?.post).toBeDefined();
    expect(libraryPath?.get).toBeDefined();
    expect(libraryPath?.post).toBeDefined();
    const detailPath = document.paths[`${root}/{id}`];
    expect(detailPath?.get).toBeDefined();
    expect(detailPath?.patch).toBeDefined();
    const mediaPost = document.paths["/api/v1/media"]?.post;
    expect(mediaPost).toBeDefined();
    for (const operation of [notePath?.get, notePath?.post, libraryPath?.get, libraryPath?.post, detailPath?.get, detailPath?.patch, mediaPost]) {
      expect(operation?.security).toContainEqual({ apiKey: [] });
    }
  });
});
