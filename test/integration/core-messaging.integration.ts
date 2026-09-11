import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConsentStatus, MessageStatus, MessageType } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import { minimalJpeg } from "../helpers/media-fixtures.js";

interface MetaMockCall {
  url: string;
  authorization?: string;
  body: Record<string, unknown>;
}

interface MetaMediaMockCall {
  url: string;
  authorization?: string;
  contentType?: string;
  body: Buffer;
}

interface BurstResult {
  status?: number;
  messageId?: string;
  durationMs: number;
  error?: string;
}

const PHONE = "96170123456";
const API_KEY_HASH_SECRET = "integration-api-key-hash-secret-0123456789abcdef";
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function requireInfrastructure(): void {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for integration tests`);
    }
  }
}

function readRawBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readRawBody(request)).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine Meta mock port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForSubmitted(
  prisma: PrismaService,
  messageIds: string[],
  timeoutMs = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const submitted = await prisma.message.count({
      where: {
        id: { in: messageIds },
        status: MessageStatus.SUBMITTED,
      },
    });
    if (submitted === messageIds.length) {
      return;
    }
    if (Date.now() >= deadline) {
      const states = await prisma.message.findMany({
        where: { id: { in: messageIds } },
        select: { id: true, status: true, errorCode: true, errorMessage: true },
      });
      throw new Error(
        `Timed out waiting for ${messageIds.length} submitted messages: ${JSON.stringify(states)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("core messaging integration", () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let metaServer: Server;
  let tenantId: string;
  let apiKey: string;
  let senderId: string;
  let senderProviderId: string;
  const metaCalls: MetaMockCall[] = [];
  const metaMediaCalls: MetaMediaMockCall[] = [];

  beforeAll(async () => {
    requireInfrastructure();

    let providerSequence = 0;
    let mediaSequence = 0;
    metaServer = createServer(async (req, res) => {
      try {
        if (req.method !== "POST") {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }

        if (req.url?.endsWith("/messages")) {
          const body = await readBody(req);
          metaCalls.push({
            url: req.url,
            authorization: req.headers.authorization,
            body,
          });
          providerSequence += 1;
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ messages: [{ id: `wamid.integration.${providerSequence}` }] }));
          return;
        }

        if (req.url?.endsWith("/media")) {
          const body = await readRawBody(req);
          metaMediaCalls.push({
            url: req.url,
            authorization: req.headers.authorization,
            contentType: req.headers["content-type"],
            body,
          });
          mediaSequence += 1;
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ id: `media.integration.${mediaSequence}` }));
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not_found" }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "integration-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "integration-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "integration-meta-access-token";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.integration.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "50";
    process.env.OUTBOX_BATCH_SIZE = "200";
    process.env.OUTBOUND_WORKER_PREFETCH = "100";
    process.env.OUTBOUND_WORKER_PREFETCH_TRANSACTIONAL = "100";
    process.env.OUTBOUND_MESSAGE_LEASE_MS = "5000";
    process.env.DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND = "500";
    process.env.WEBHOOK_PROCESSOR_INTERVAL_MS = "250";
    process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS = "250";

    const [{ AppModule }, { WorkerModule }] = await Promise.all([
      import("../../src/app.module.js"),
      import("../../src/worker/worker.module.js"),
    ]);

    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    // Bind one stable HTTP listener before issuing concurrent Supertest requests.
    // When Supertest receives an unbound server it may start/stop ephemeral listeners per request,
    // which is unsafe under a burst and can create client-side ECONNRESET failures unrelated to the API.
    await app.listen(0, "127.0.0.1");
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    prisma = app.get(PrismaService);

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `Integration Tenant ${suffix}`,
        slug: `integration-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "integration",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_READ, ApiScope.MESSAGES_WRITE, ApiScope.MEDIA_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "Integration Contact",
        consentStatus: ConsentStatus.OPTED_IN,
        consentSource: "integration-test",
        consentAt: new Date(),
        lastInboundAt: new Date(),
        serviceWindowExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    senderProviderId = String(Date.now());
    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId: senderProviderId,
        wabaId: `${senderProviderId}1`,
        displayPhoneNumber: "+961 70 123 456",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 500,
        active: true,
        isDefault: true,
      },
    });
    senderId = sender.id;
  });

  afterAll(async () => {
    if (prisma && tenantId) {
      const messages = await prisma.message.findMany({
        where: { tenantId },
        select: { id: true },
      });
      const messageIds = messages.map((message) => message.id);
      if (messageIds.length > 0) {
        await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: messageIds } } });
        await prisma.message.deleteMany({ where: { id: { in: messageIds } } });
      }
      await prisma.conversationNote.deleteMany({ where: { tenantId } });
      await prisma.conversation.deleteMany({ where: { tenantId } });
      await prisma.inboxAgent.deleteMany({ where: { tenantId } });
      await prisma.contact.deleteMany({ where: { tenantId } });
      await prisma.whatsAppPhoneNumber.deleteMany({ where: { tenantId } });
      await prisma.apiKey.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }

    await worker?.close();
    await app?.close();
    if (metaServer) {
      await closeServer(metaServer);
    }
  });

  it("delivers one idempotent HTTP message through outbox, RabbitMQ, worker, and the Meta mock", async () => {
    const initialMetaCalls = metaCalls.length;
    const idempotencyKey = `integration-single-${Date.now()}`;

    const first = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", idempotencyKey)
      .set("traceparent", TRACEPARENT)
      .set("x-request-id", "integration-single-request")
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Integration hello" },
      })
      .expect(202);

    expect(first.headers["x-request-id"]).toBe("integration-single-request");
    expect(first.headers.traceparent).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
    );

    const duplicate = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", idempotencyKey)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Integration hello" },
      })
      .expect(202);

    expect(duplicate.body.messageId).toBe(first.body.messageId);
    await waitForSubmitted(prisma, [first.body.messageId]);

    const persisted = await prisma.message.findUniqueOrThrow({
      where: { id: first.body.messageId },
    });
    expect(persisted.status).toBe(MessageStatus.SUBMITTED);
    expect(persisted.providerMessageId).toMatch(/^wamid\.integration\.\d+$/);

    const outbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: first.body.messageId },
    });
    expect(outbox.publishedAt).not.toBeNull();
    const payload = outbox.payload as {
      trace?: { traceId?: string; requestId?: string };
    };
    expect(payload.trace?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(payload.trace?.requestId).toBe("integration-single-request");

    expect(metaCalls).toHaveLength(initialMetaCalls + 1);
    const call = metaCalls.at(-1)!;
    expect(call.url).toBe(`/v99.0/${senderProviderId}/messages`);
    expect(call.authorization).toBe("Bearer integration-meta-access-token");
    expect(call.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: PHONE,
      type: "text",
      text: { body: "Integration hello" },
    });

    const lookup = await request(app.getHttpServer())
      .get(`/api/v1/messages/${first.body.messageId}`)
      .set("X-API-Key", apiKey)
      .expect(200);
    expect(lookup.body.status).toBe(MessageStatus.SUBMITTED);
    expect(lookup.body.providerMessageId).toBe(persisted.providerMessageId);
  });

  it("delivers an IMAGE message through the same durable pipeline", async () => {
    const initialMetaCalls = metaCalls.length;
    const mediaLink = "https://cdn.example.com/integration-delivery.jpg?token=abc";

    const response = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `integration-image-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        type: "IMAGE",
        payload: {
          link: mediaLink,
          caption: "Integration delivery photo",
        },
      })
      .expect(202);

    await waitForSubmitted(prisma, [response.body.messageId]);

    const persisted = await prisma.message.findUniqueOrThrow({
      where: { id: response.body.messageId },
    });
    expect(persisted.type).toBe(MessageType.IMAGE);
    expect(persisted.status).toBe(MessageStatus.SUBMITTED);
    expect(persisted.payload).toEqual({
      link: mediaLink,
      caption: "Integration delivery photo",
    });

    expect(metaCalls).toHaveLength(initialMetaCalls + 1);
    const call = metaCalls.at(-1)!;
    expect(call.url).toBe(`/v99.0/${senderProviderId}/messages`);
    expect(call.authorization).toBe("Bearer integration-meta-access-token");
    expect(call.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: PHONE,
      type: "image",
      image: {
        link: mediaLink,
        caption: "Integration delivery photo",
      },
    });
  });

  it("uploads bounded media through the tenant sender and Meta multipart endpoint", async () => {
    const initialMetaMediaCalls = metaMediaCalls.length;
    const jpeg = minimalJpeg();

    const response = await request(app.getHttpServer())
      .post("/api/v1/media")
      .set("X-API-Key", apiKey)
      .field("senderId", senderId)
      .attach("file", jpeg, {
        filename: "client-supplied-name.jpg",
        contentType: "image/jpeg",
      })
      .expect(201);

    expect(response.body).toEqual({
      mediaId: "media.integration.1",
      senderId,
      category: "IMAGE",
      mimeType: "image/jpeg",
      size: jpeg.length,
    });

    expect(metaMediaCalls).toHaveLength(initialMetaMediaCalls + 1);
    const call = metaMediaCalls.at(-1)!;
    expect(call.url).toBe(`/v99.0/${senderProviderId}/media`);
    expect(call.authorization).toBe("Bearer integration-meta-access-token");
    expect(call.contentType).toMatch(/^multipart\/form-data; boundary=/);

    const multipart = call.body.toString("latin1");
    expect(multipart).toContain('name="messaging_product"');
    expect(multipart).toContain("whatsapp");
    expect(multipart).toContain('name="file"; filename="upload.jpg"');
    expect(multipart).toContain("Content-Type: image/jpeg");
    expect(multipart).not.toContain("client-supplied-name.jpg");
  });

  it("accepts a concurrent burst with zero HTTP errors and drains every message to SUBMITTED", async () => {
    const total = Number(process.env.INTEGRATION_BURST_MESSAGES ?? 50);
    const maxP95Ms = Number(process.env.INTEGRATION_ACCEPT_P95_MS ?? 3000);
    const initialMetaCalls = metaCalls.length;
    const burstId = Date.now();

    // Every request resolves to a diagnostic result, even on a transport failure. This prevents
    // Promise.all from abandoning sibling requests while they are still mutating test state.
    const results: BurstResult[] = await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        const startedAt = performance.now();
        try {
          const response = await request(app.getHttpServer())
            .post("/api/v1/messages")
            .set("X-API-Key", apiKey)
            .set("Idempotency-Key", `integration-burst-${burstId}-${index}`)
            .send({
              to: `+${PHONE}`,
              type: "TEXT",
              payload: { body: `Burst message ${index}` },
            });
          return {
            status: response.status,
            messageId: response.body.messageId as string | undefined,
            durationMs: performance.now() - startedAt,
          };
        } catch (error) {
          return {
            durationMs: performance.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const transportErrors = results.filter((result) => result.error);
    expect(transportErrors).toEqual([]);
    expect(results.every((result) => result.status === 202)).toBe(true);
    const messageIds = results.map((result) => result.messageId).filter((id): id is string => !!id);
    expect(messageIds).toHaveLength(total);
    expect(new Set(messageIds).size).toBe(total);

    const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
    const p95Index = Math.min(durations.length - 1, Math.max(0, Math.ceil(durations.length * 0.95) - 1));
    const p95Ms = durations[p95Index] ?? Number.POSITIVE_INFINITY;
    expect(p95Ms).toBeLessThan(maxP95Ms);

    await waitForSubmitted(prisma, messageIds, 45000);
    expect(metaCalls.length - initialMetaCalls).toBe(total);
  });
});