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

const PHONE = "96170777666";
const API_KEY_HASH_SECRET = "duplicate-delivery-api-key-hash-secret-0123456789";

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
        attemptCount: true,
        providerMessageId: true,
        errorCode: true,
      },
    });
    if (message?.status === MessageStatus.SUBMITTED) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for submitted message: ${JSON.stringify(message)}`);
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
    const queue = await channel.checkQueue(queueName);
    if (queue.messageCount === expectedCount) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for queue ${queueName} count ${expectedCount}; current count=${queue.messageCount}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function timeoutAfter(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    timer.unref();
  });
}

describe("duplicate RabbitMQ delivery integration", () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let metaServer: Server;
  let rabbitConnection: ChannelModel | undefined;
  let rabbitChannel: ConfirmChannel | undefined;
  let tenantId: string;
  let apiKey: string;
  let senderProviderId: string;
  let queueBaseName: string;
  let providerCalls = 0;
  let resolveProviderStarted!: () => void;
  let releaseProvider!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    resolveProviderStarted = resolve;
  });
  const providerRelease = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });

  const trafficQueueName = (): string =>
    `${queueBaseName}.${MessageTrafficClass.TRANSACTIONAL.toLowerCase()}`;
  const retryQueueName = (): string => `${trafficQueueName()}.retry.1500`;
  const deadQueueName = (): string => `${trafficQueueName()}.dead`;

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
        resolveProviderStarted();
        await providerRelease;

        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ messages: [{ id: `wamid.duplicate.${providerCalls}` }] }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    queueBaseName = `whatsapp.duplicate.integration.${process.pid}.${Date.now()}`;
    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "5000";
    process.env.META_APP_SECRET = "duplicate-delivery-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "duplicate-delivery-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "duplicate-delivery-meta-access-token";
    process.env.OUTBOUND_QUEUE_NAME = queueBaseName;
    process.env.OUTBOX_POLL_INTERVAL_MS = "50";
    process.env.OUTBOX_BATCH_SIZE = "20";
    process.env.OUTBOUND_RETRY_DELAYS_MS = "1500";
    process.env.OUTBOUND_WORKER_PREFETCH = "10";
    process.env.OUTBOUND_WORKER_PREFETCH_TRANSACTIONAL = "10";
    process.env.OUTBOUND_MESSAGE_LEASE_MS = "5000";
    process.env.DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND = "500";
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
    await rabbitChannel.checkQueue(trafficQueueName());
    await rabbitChannel.checkQueue(retryQueueName());

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `Duplicate Delivery Tenant ${suffix}`,
        slug: `duplicate-delivery-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "duplicate-delivery",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_READ, ApiScope.MESSAGES_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "Duplicate Delivery Contact",
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
        displayPhoneNumber: "+961 70 777 666",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 500,
        active: true,
        isDefault: true,
      },
    });
  });

  afterAll(async () => {
    releaseProvider?.();

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

    await worker?.close();
    await app?.close();
    if (rabbitChannel) {
      await rabbitChannel.purgeQueue(trafficQueueName()).catch(() => undefined);
      await rabbitChannel.purgeQueue(retryQueueName()).catch(() => undefined);
      await rabbitChannel.purgeQueue(deadQueueName()).catch(() => undefined);
      await rabbitChannel.close().catch(() => undefined);
    }
    await rabbitConnection?.close().catch(() => undefined);
    if (metaServer) {
      await closeServer(metaServer);
    }
  });

  it("leases one logical message so a concurrent duplicate delivery cannot send to Meta twice", async () => {
    if (!rabbitChannel) {
      throw new Error("RabbitMQ inspection channel is unavailable");
    }

    const response = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `duplicate-delivery-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "One logical message despite duplicate queue delivery" },
      })
      .expect(202);

    const messageId = response.body.messageId as string;
    await Promise.race([providerStarted, timeoutAfter(10000, "first provider request")]);

    const processing = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      select: { status: true, attemptCount: true, processingLeaseUntil: true },
    });
    expect(processing.status).toBe(MessageStatus.PROCESSING);
    expect(processing.attemptCount).toBe(1);
    expect(processing.processingLeaseUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(providerCalls).toBe(1);

    rabbitChannel.sendToQueue(
      trafficQueueName(),
      Buffer.from(
        JSON.stringify({
          messageId,
          trafficClass: MessageTrafficClass.TRANSACTIONAL,
        }),
      ),
      {
        persistent: true,
        contentType: "application/json",
        messageId,
        timestamp: Date.now(),
        headers: {
          "x-retry-count": 0,
          "x-traffic-class": MessageTrafficClass.TRANSACTIONAL,
        },
      },
    );
    await rabbitChannel.waitForConfirms();

    await waitForQueueCount(rabbitChannel, retryQueueName(), 1);
    expect(providerCalls).toBe(1);

    releaseProvider();
    await waitForSubmitted(prisma, messageId);

    const submitted = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: {
        statusEvents: { orderBy: { createdAt: "asc" } },
      },
    });
    expect(submitted.status).toBe(MessageStatus.SUBMITTED);
    expect(submitted.providerMessageId).toBe("wamid.duplicate.1");
    expect(submitted.attemptCount).toBe(1);
    expect(submitted.errorCode).toBeNull();
    expect(submitted.statusEvents.filter((event) => event.status === MessageStatus.PROCESSING)).toHaveLength(1);

    await waitForQueueCount(rabbitChannel, retryQueueName(), 0, 5000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(providerCalls).toBe(1);
  });
});
