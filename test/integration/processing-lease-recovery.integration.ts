import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import { createServer, type IncomingMessage, type Server } from "node:http";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import {
  ConsentStatus,
  MessageStatus,
  MessageTrafficClass,
} from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const PHONE = "96170333222";
const API_KEY_HASH_SECRET = "processing-lease-api-key-hash-secret-0123456789";
const STALE_LEASE_MS = 5000;
const RETRY_DELAY_MS = 5500;

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

async function waitForOutboxPublished(
  prisma: PrismaService,
  messageId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const event = await prisma.outboxEvent.findFirst({
      where: { aggregateId: messageId },
      select: { publishedAt: true, attempts: true, processingLeaseUntil: true, lastError: true },
    });
    if (event?.publishedAt) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for outbox publication: ${JSON.stringify(event)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForQueueCount(
  channel: ConfirmChannel,
  queueName: string,
  expectedCount: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await channel.checkQueue(queueName);
    if (state.messageCount === expectedCount) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for queue ${queueName} count ${expectedCount}; current=${state.messageCount}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForSubmitted(
  prisma: PrismaService,
  messageId: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        status: true,
        attemptCount: true,
        processingLeaseUntil: true,
        providerMessageId: true,
        errorCode: true,
      },
    });
    if (message?.status === MessageStatus.SUBMITTED) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for stale lease recovery: ${JSON.stringify(message)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("outbound processing lease recovery integration", () => {
  let app: INestApplication;
  let worker: INestApplicationContext | undefined;
  let prisma: PrismaService;
  let metaServer: Server;
  let rabbitConnection: ChannelModel | undefined;
  let rabbitChannel: ConfirmChannel | undefined;
  let tenantId: string;
  let apiKey: string;
  let queueBaseName: string;
  let providerCalls = 0;

  const trafficQueueName = (): string =>
    `${queueBaseName}.${MessageTrafficClass.TRANSACTIONAL.toLowerCase()}`;
  const retryQueueName = (): string => `${trafficQueueName()}.retry.${RETRY_DELAY_MS}`;

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
        res.end(JSON.stringify({ messages: [{ id: `wamid.lease-recovery.${providerCalls}` }] }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    queueBaseName = `whatsapp.lease-recovery.${process.pid}.${Date.now()}`;
    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "processing-lease-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "processing-lease-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "processing-lease-meta-access-token";
    process.env.OUTBOUND_QUEUE_NAME = queueBaseName;
    process.env.OUTBOX_POLL_INTERVAL_MS = "50";
    process.env.OUTBOX_BATCH_SIZE = "20";
    process.env.OUTBOUND_RETRY_DELAYS_MS = String(RETRY_DELAY_MS);
    process.env.OUTBOUND_WORKER_PREFETCH = "10";
    process.env.OUTBOUND_WORKER_PREFETCH_TRANSACTIONAL = "10";
    process.env.OUTBOUND_MESSAGE_LEASE_MS = "5000";
    process.env.DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND = "500";
    process.env.WEBHOOK_PROCESSOR_INTERVAL_MS = "1000";
    process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS = "1000";

    const { AppModule } = await import("../../src/app.module.js");
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
    prisma = app.get(PrismaService);

    rabbitConnection = await amqp.connect(process.env.RABBITMQ_URL!);
    rabbitChannel = await rabbitConnection.createConfirmChannel();

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `Processing Lease Tenant ${suffix}`,
        slug: `processing-lease-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "processing-lease",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_READ, ApiScope.MESSAGES_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "Processing Lease Contact",
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
        displayPhoneNumber: "+961 70 333 222",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 500,
        active: true,
        isDefault: true,
      },
    });
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    if (rabbitChannel) {
      await rabbitChannel.close().catch(() => undefined);
    }
    await rabbitConnection?.close().catch(() => undefined);

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

  it("defers a redelivered job while the crashed worker lease is active and submits after lease expiry", async () => {
    if (!rabbitChannel) {
      throw new Error("RabbitMQ inspection channel is unavailable");
    }

    const response = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `processing-lease-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Recover after the previous worker lease expires" },
      })
      .expect(202);

    const messageId = response.body.messageId as string;
    await waitForOutboxPublished(prisma, messageId);
    await waitForQueueCount(rabbitChannel, trafficQueueName(), 1);

    const simulatedCrashAt = new Date();
    const leaseUntil = new Date(simulatedCrashAt.getTime() + STALE_LEASE_MS);
    await prisma.message.update({
      where: { id: messageId },
      data: {
        status: MessageStatus.PROCESSING,
        attemptCount: 1,
        lastAttemptAt: simulatedCrashAt,
        processingLeaseUntil: leaseUntil,
        statusEvents: {
          create: {
            status: MessageStatus.PROCESSING,
            payload: { simulatedWorkerCrash: true },
            createdAt: simulatedCrashAt,
          },
        },
      },
    });

    const { WorkerModule } = await import("../../src/worker/worker.module.js");
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });

    await waitForQueueCount(rabbitChannel, retryQueueName(), 1, 5000);

    const leased = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(leased.status).toBe(MessageStatus.PROCESSING);
    expect(leased.attemptCount).toBe(1);
    expect(leased.processingLeaseUntil).not.toBeNull();
    expect(leased.processingLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(providerCalls).toBe(0);

    await waitForSubmitted(prisma, messageId);

    const recovered = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: { statusEvents: { orderBy: { createdAt: "asc" } } },
    });
    expect(recovered.status).toBe(MessageStatus.SUBMITTED);
    expect(recovered.attemptCount).toBe(2);
    expect(recovered.processingLeaseUntil).toBeNull();
    expect(recovered.providerMessageId).toBe("wamid.lease-recovery.1");
    expect(recovered.errorCode).toBeNull();
    expect(recovered.statusEvents.filter((event) => event.status === MessageStatus.PROCESSING)).toHaveLength(2);
    expect(providerCalls).toBe(1);
  });
});
