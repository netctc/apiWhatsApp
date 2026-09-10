import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer, type IncomingMessage, type Server } from "node:http";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConsentStatus, MessageStatus } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const PHONE = "96170444333";
const API_KEY_HASH_SECRET = "api-restart-api-key-hash-secret-0123456789";

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

function configureApp(app: INestApplication): void {
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}

async function waitForSubmitted(
  prisma: PrismaService,
  messageId: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        status: true,
        providerMessageId: true,
        attemptCount: true,
        errorCode: true,
      },
    });
    if (message?.status === MessageStatus.SUBMITTED) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for restarted API outbox drain: ${JSON.stringify(message)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("API restart transactional outbox recovery integration", () => {
  let firstApp: INestApplication | undefined;
  let recoveredApp: INestApplication | undefined;
  let worker: INestApplicationContext | undefined;
  let metaServer: Server;
  let tenantId: string;
  let apiKey: string;
  let providerCalls = 0;

  beforeAll(async () => {
    requireInfrastructure();

    metaServer = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || !req.url?.endsWith("/messages")) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }

        await readRawBody(req);
        providerCalls += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ messages: [{ id: `wamid.api-restart.${providerCalls}` }] }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "api-restart-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "api-restart-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "api-restart-meta-access-token";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.api-restart.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "10000";
    process.env.OUTBOX_BATCH_SIZE = "20";
    process.env.OUTBOUND_RETRY_DELAYS_MS = "250";
    process.env.OUTBOUND_WORKER_PREFETCH = "10";
    process.env.OUTBOUND_WORKER_PREFETCH_TRANSACTIONAL = "10";
    process.env.OUTBOUND_MESSAGE_LEASE_MS = "5000";
    process.env.DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND = "500";
    process.env.WEBHOOK_PROCESSOR_INTERVAL_MS = "1000";
    process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS = "1000";

    const { AppModule } = await import("../../src/app.module.js");
    firstApp = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    configureApp(firstApp);
    await firstApp.listen(0, "127.0.0.1");

    const prisma = firstApp.get(PrismaService);
    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `API Restart Tenant ${suffix}`,
        slug: `api-restart-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "api-restart",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_READ, ApiScope.MESSAGES_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "API Restart Contact",
        consentStatus: ConsentStatus.OPTED_IN,
        consentSource: "integration-test",
        consentAt: new Date(),
        lastInboundAt: new Date(),
        serviceWindowExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const senderProviderId = String(Date.now());
    await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId: senderProviderId,
        wabaId: `${senderProviderId}1`,
        displayPhoneNumber: "+961 70 444 333",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 500,
        active: true,
        isDefault: true,
      },
    });
  });

  afterAll(async () => {
    await worker?.close();
    await recoveredApp?.close();
    await firstApp?.close();

    const cleanup = new PrismaService();
    try {
      await cleanup.$connect();
      if (tenantId) {
        const messages = await cleanup.message.findMany({ where: { tenantId }, select: { id: true } });
        const messageIds = messages.map((message) => message.id);
        if (messageIds.length > 0) {
          await cleanup.outboxEvent.deleteMany({ where: { aggregateId: { in: messageIds } } });
          await cleanup.message.deleteMany({ where: { id: { in: messageIds } } });
        }
        await cleanup.conversationNote.deleteMany({ where: { tenantId } });
        await cleanup.conversation.deleteMany({ where: { tenantId } });
        await cleanup.contact.deleteMany({ where: { tenantId } });
        await cleanup.whatsAppPhoneNumber.deleteMany({ where: { tenantId } });
        await cleanup.apiKey.deleteMany({ where: { tenantId } });
        await cleanup.tenant.deleteMany({ where: { id: tenantId } });
      }
    } finally {
      await cleanup.$disconnect();
    }

    if (metaServer) {
      await closeServer(metaServer);
    }
  });

  it("recovers an unpublished committed outbox event after the accepting API instance stops", async () => {
    if (!firstApp) {
      throw new Error("Initial API application is unavailable");
    }

    const prisma = firstApp.get(PrismaService);
    const response = await request(firstApp.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `api-restart-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Commit before this API instance stops" },
      })
      .expect(202);

    const messageId = response.body.messageId as string;
    const committedMessage = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    const committedOutbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: messageId },
    });

    expect(committedMessage.status).toBe(MessageStatus.QUEUED);
    expect(committedMessage.providerMessageId).toBeNull();
    expect(committedOutbox.publishedAt).toBeNull();
    expect(committedOutbox.attempts).toBe(0);
    expect(committedOutbox.processingLeaseUntil).toBeNull();
    expect(providerCalls).toBe(0);

    await firstApp.close();
    firstApp = undefined;

    process.env.OUTBOX_POLL_INTERVAL_MS = "50";
    const [{ AppModule }, { WorkerModule }] = await Promise.all([
      import("../../src/app.module.js"),
      import("../../src/worker/worker.module.js"),
    ]);

    recoveredApp = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    configureApp(recoveredApp);
    await recoveredApp.listen(0, "127.0.0.1");
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });

    const recoveredPrisma = recoveredApp.get(PrismaService);
    await waitForSubmitted(recoveredPrisma, messageId);

    const recoveredMessage = await recoveredPrisma.message.findUniqueOrThrow({
      where: { id: messageId },
    });
    const recoveredOutbox = await recoveredPrisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: messageId },
    });

    expect(recoveredMessage.status).toBe(MessageStatus.SUBMITTED);
    expect(recoveredMessage.providerMessageId).toBe("wamid.api-restart.1");
    expect(recoveredMessage.attemptCount).toBe(1);
    expect(recoveredOutbox.publishedAt).not.toBeNull();
    expect(recoveredOutbox.attempts).toBe(1);
    expect(recoveredOutbox.processingLeaseUntil).toBeNull();
    expect(recoveredOutbox.lastError).toBeNull();
    expect(providerCalls).toBe(1);
  });
});
