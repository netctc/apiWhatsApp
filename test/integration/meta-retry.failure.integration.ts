import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import { createServer, type IncomingMessage, type Server } from "node:http";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConsentStatus, MessageStatus } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

interface PlannedMetaFailure {
  httpStatus: number;
  code?: number;
  message: string;
}

interface MetaAttempt {
  body: Record<string, unknown>;
  injectedStatus?: number;
}

const PHONE = "96170987654";
const API_KEY_HASH_SECRET = "failure-injection-api-key-secret-0123456789abcdef";

function requireInfrastructure(): void {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for integration tests`);
    }
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine Meta failure mock port"));
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

async function waitForMessageStatus(
  prisma: PrismaService,
  messageId: string,
  status: MessageStatus,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { status: true, errorCode: true },
    });
    if (message?.status === status) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for message ${messageId} status ${status}: ${JSON.stringify(message)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForQueueMessages(
  channel: ConfirmChannel,
  queueName: string,
  expected: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const queue = await channel.checkQueue(queueName);
    if (queue.messageCount >= expected) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${expected} messages in ${queueName}; current=${queue.messageCount}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Meta retry failure injection", () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let metaServer: Server;
  let rabbitConnection: ChannelModel;
  let rabbitChannel: ConfirmChannel;
  let tenantId: string;
  let apiKey: string;
  let senderProviderId: string;
  let queueBaseName: string;
  let providerSequence = 0;
  const plannedFailures: PlannedMetaFailure[] = [];
  const metaAttempts: MetaAttempt[] = [];

  beforeAll(async () => {
    requireInfrastructure();

    metaServer = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || !req.url?.endsWith("/messages")) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }

        const body = await readBody(req);
        const failure = plannedFailures.shift();
        metaAttempts.push({
          body,
          ...(failure ? { injectedStatus: failure.httpStatus } : {}),
        });

        res.setHeader("content-type", "application/json");
        if (failure) {
          res.statusCode = failure.httpStatus;
          res.end(
            JSON.stringify({
              error: {
                message: failure.message,
                ...(failure.code !== undefined ? { code: failure.code } : {}),
              },
            }),
          );
          return;
        }

        providerSequence += 1;
        res.statusCode = 200;
        res.end(JSON.stringify({ messages: [{ id: `wamid.failure.${providerSequence}` }] }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    queueBaseName = `whatsapp.failure.meta.${process.pid}.${Date.now()}`;
    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "failure-injection-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "failure-injection-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "failure-injection-access-token";
    process.env.OUTBOUND_QUEUE_NAME = queueBaseName;
    process.env.OUTBOUND_RETRY_DELAYS_MS = "100,200";
    process.env.OUTBOX_POLL_INTERVAL_MS = "25";
    process.env.OUTBOX_BATCH_SIZE = "20";
    process.env.OUTBOUND_WORKER_PREFETCH = "10";
    process.env.OUTBOUND_WORKER_PREFETCH_TRANSACTIONAL = "10";
    process.env.OUTBOUND_MESSAGE_LEASE_MS = "5000";
    process.env.DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND = "1000";
    process.env.WEBHOOK_PROCESSOR_INTERVAL_MS = "1000";
    process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS = "1000";

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
    await app.listen(0, "127.0.0.1");
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    prisma = app.get(PrismaService);

    rabbitConnection = await amqp.connect(process.env.RABBITMQ_URL!);
    rabbitChannel = await rabbitConnection.createConfirmChannel();

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `Failure Injection Tenant ${suffix}`,
        slug: `failure-injection-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "failure-injection",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_READ, ApiScope.MESSAGES_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "Failure Injection Contact",
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
        displayPhoneNumber: "+961 70 987 654",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 1000,
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
      await prisma.conversationNote.deleteMany({ where: { tenantId } });
      await prisma.conversation.deleteMany({ where: { tenantId } });
      await prisma.contact.deleteMany({ where: { tenantId } });
      await prisma.whatsAppPhoneNumber.deleteMany({ where: { tenantId } });
      await prisma.apiKey.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }

    await rabbitChannel?.close().catch(() => undefined);
    await rabbitConnection?.close().catch(() => undefined);
    await worker?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    if (metaServer) {
      await closeServer(metaServer).catch(() => undefined);
    }
    delete process.env.OUTBOUND_RETRY_DELAYS_MS;
  });

  it("recovers from retryable Meta 500 and 429 responses without duplicating durable work", async () => {
    plannedFailures.push(
      { httpStatus: 500, code: 2, message: "Injected transient Meta failure" },
      { httpStatus: 429, code: 4, message: "Injected Meta rate limit" },
    );
    const initialAttempts = metaAttempts.length;
    const idempotencyKey = `failure-recovery-${Date.now()}`;

    const accepted = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", idempotencyKey)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Failure injection retry recovery" },
      })
      .expect(202);

    await waitForMessageStatus(prisma, accepted.body.messageId, MessageStatus.SUBMITTED);
    expect(plannedFailures).toHaveLength(0);

    const attempts = metaAttempts.slice(initialAttempts);
    expect(attempts).toHaveLength(3);
    expect(attempts.map((attempt) => attempt.injectedStatus ?? 200)).toEqual([500, 429, 200]);
    expect(new Set(attempts.map((attempt) => JSON.stringify(attempt.body))).size).toBe(1);

    const persisted = await prisma.message.findUniqueOrThrow({
      where: { id: accepted.body.messageId },
    });
    expect(persisted.status).toBe(MessageStatus.SUBMITTED);
    expect(persisted.attemptCount).toBe(3);
    expect(persisted.providerMessageId).toMatch(/^wamid\.failure\.\d+$/);
    expect(persisted.errorCode).toBeNull();
    expect(persisted.errorMessage).toBeNull();

    const matchingMessages = await prisma.message.count({
      where: { tenantId, idempotencyKey },
    });
    expect(matchingMessages).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: accepted.body.messageId },
      }),
    ).toBe(1);

    const statusEvents = await prisma.messageStatusEvent.findMany({
      where: { messageId: accepted.body.messageId },
      orderBy: { createdAt: "asc" },
    });
    const retryEvents = statusEvents.filter((event) => {
      const payload = event.payload as { retry?: unknown } | null;
      return event.status === MessageStatus.QUEUED && payload?.retry === true;
    });
    expect(retryEvents).toHaveLength(2);
    expect(
      retryEvents.map((event) => (event.payload as { errorCode?: string }).errorCode),
    ).toEqual(["META_2", "META_4"]);
    expect(statusEvents.filter((event) => event.status === MessageStatus.PROCESSING)).toHaveLength(3);
    expect(statusEvents.filter((event) => event.status === MessageStatus.SUBMITTED)).toHaveLength(1);
  });

  it("marks retry exhaustion failed and publishes one dead-letter entry", async () => {
    plannedFailures.push(
      { httpStatus: 503, message: "Injected retry exhaustion 1" },
      { httpStatus: 503, message: "Injected retry exhaustion 2" },
      { httpStatus: 503, message: "Injected retry exhaustion 3" },
    );
    const initialAttempts = metaAttempts.length;

    const accepted = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `failure-exhausted-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Failure injection retry exhausted" },
      })
      .expect(202);

    await waitForMessageStatus(prisma, accepted.body.messageId, MessageStatus.FAILED);
    expect(plannedFailures).toHaveLength(0);
    expect(metaAttempts.slice(initialAttempts)).toHaveLength(3);

    const persisted = await prisma.message.findUniqueOrThrow({
      where: { id: accepted.body.messageId },
    });
    expect(persisted.status).toBe(MessageStatus.FAILED);
    expect(persisted.attemptCount).toBe(3);
    expect(persisted.providerMessageId).toBeNull();
    expect(persisted.errorCode).toBe("RETRY_EXHAUSTED");

    const deadQueue = `${queueBaseName}.transactional.dead`;
    await waitForQueueMessages(rabbitChannel, deadQueue, 1);
    const deadMessage = await rabbitChannel.get(deadQueue, { noAck: false });
    expect(deadMessage).not.toBe(false);
    if (deadMessage) {
      const payload = JSON.parse(deadMessage.content.toString("utf8")) as {
        messageId?: string;
        trafficClass?: string;
        reason?: string;
      };
      expect(payload.messageId).toBe(accepted.body.messageId);
      expect(payload.trafficClass).toBe("TRANSACTIONAL");
      expect(payload.reason).toContain("Injected retry exhaustion 3");
      rabbitChannel.ack(deadMessage);
    }
  });
});
