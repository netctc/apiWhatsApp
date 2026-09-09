import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConsentStatus, MessageStatus } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

interface MetaMockCall {
  url: string;
  authorization?: string;
  body: Record<string, unknown>;
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

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
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
  let senderProviderId: string;
  const metaCalls: MetaMockCall[] = [];

  beforeAll(async () => {
    requireInfrastructure();

    let providerSequence = 0;
    metaServer = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || !req.url?.endsWith("/messages")) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }

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
    await app.init();
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
        scopes: [ApiScope.MESSAGES_READ, ApiScope.MESSAGES_WRITE],
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
    await prisma.whatsAppPhoneNumber.create({
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

  it("accepts a concurrent burst with zero HTTP errors and drains every message to SUBMITTED", async () => {
    const total = Number(process.env.INTEGRATION_BURST_MESSAGES ?? 50);
    const maxP95Ms = Number(process.env.INTEGRATION_ACCEPT_P95_MS ?? 3000);
    const initialMetaCalls = metaCalls.length;

    const results = await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        const startedAt = performance.now();
        const response = await request(app.getHttpServer())
          .post("/api/v1/messages")
          .set("X-API-Key", apiKey)
          .set("Idempotency-Key", `integration-burst-${Date.now()}-${index}`)
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
      }),
    );

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
