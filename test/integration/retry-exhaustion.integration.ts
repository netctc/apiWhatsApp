import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import amqp, { type Channel, type ChannelModel } from "amqplib";
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

interface DeadLetterPayload {
  messageId?: string | null;
  trafficClass?: string;
  reason?: string;
  failedAt?: string;
}

const PHONE = "96170888777";
const API_KEY_HASH_SECRET = "retry-exhaustion-api-key-hash-secret-0123456789";
const PROVIDER_ERROR_MESSAGE = "Integration provider remains unavailable";

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

async function waitForFailed(
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
        errorCode: true,
        errorMessage: true,
      },
    });
    if (message?.status === MessageStatus.FAILED) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for retry exhaustion: ${JSON.stringify(message)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForDeadLetter(
  channel: Channel,
  queueName: string,
  expectedMessageId: string,
  timeoutMs = 10000,
): Promise<DeadLetterPayload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = await channel.get(queueName, { noAck: false });
    if (message) {
      const payload = JSON.parse(message.content.toString("utf8")) as DeadLetterPayload;
      channel.ack(message);
      if (payload.messageId !== expectedMessageId) {
        throw new Error(
          `Unexpected dead-letter message ${String(payload.messageId)} while waiting for ${expectedMessageId}`,
        );
      }
      return payload;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for dead-letter message ${expectedMessageId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("outbound retry exhaustion integration", () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let metaServer: Server;
  let rabbitConnection: ChannelModel | undefined;
  let rabbitChannel: Channel | undefined;
  let tenantId: string;
  let apiKey: string;
  let senderProviderId: string;
  let queueBaseName: string;
  let providerCalls = 0;

  const deadQueueName = (): string =>
    `${queueBaseName}.${MessageTrafficClass.TRANSACTIONAL.toLowerCase()}.dead`;

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
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              message: PROVIDER_ERROR_MESSAGE,
              code: 2,
            },
          }),
        );
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    queueBaseName = `whatsapp.retry-exhaustion.${process.pid}.${Date.now()}`;
    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "retry-exhaustion-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "retry-exhaustion-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "retry-exhaustion-meta-access-token";
    process.env.OUTBOUND_QUEUE_NAME = queueBaseName;
    process.env.OUTBOX_POLL_INTERVAL_MS = "50";
    process.env.OUTBOX_BATCH_SIZE = "20";
    process.env.OUTBOUND_RETRY_DELAYS_MS = "100,200";
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
    rabbitChannel = await rabbitConnection.createChannel();
    await rabbitChannel.checkQueue(deadQueueName());

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `Retry Exhaustion Tenant ${suffix}`,
        slug: `retry-exhaustion-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "retry-exhaustion",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_READ, ApiScope.MESSAGES_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "Retry Exhaustion Contact",
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
        displayPhoneNumber: "+961 70 888 777",
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
      await prisma.conversationNote.deleteMany({ where: { tenantId } });
      await prisma.conversation.deleteMany({ where: { tenantId } });
      await prisma.contact.deleteMany({ where: { tenantId } });
      await prisma.whatsAppPhoneNumber.deleteMany({ where: { tenantId } });
      await prisma.apiKey.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }

    if (rabbitChannel) {
      await rabbitChannel.purgeQueue(deadQueueName()).catch(() => undefined);
      await rabbitChannel.close().catch(() => undefined);
    }
    await rabbitConnection?.close().catch(() => undefined);
    await worker?.close();
    await app?.close();
    if (metaServer) {
      await closeServer(metaServer);
    }
  });

  it("marks the message RETRY_EXHAUSTED and dead-letters after every configured retry fails", async () => {
    if (!rabbitChannel) {
      throw new Error("RabbitMQ inspection channel is unavailable");
    }

    const response = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `retry-exhaustion-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Keep retrying until the bounded policy is exhausted" },
      })
      .expect(202);

    await waitForFailed(prisma, response.body.messageId);

    const message = await prisma.message.findUniqueOrThrow({
      where: { id: response.body.messageId },
      include: {
        statusEvents: { orderBy: { createdAt: "asc" } },
      },
    });

    expect(message.status).toBe(MessageStatus.FAILED);
    expect(message.attemptCount).toBe(3);
    expect(message.providerMessageId).toBeNull();
    expect(message.errorCode).toBe("RETRY_EXHAUSTED");
    expect(message.errorMessage).toContain(PROVIDER_ERROR_MESSAGE);
    expect(message.failedAt).not.toBeNull();
    expect(message.statusEvents.filter((event) => event.status === MessageStatus.PROCESSING)).toHaveLength(3);
    expect(providerCalls).toBe(3);

    const deadLetter = await waitForDeadLetter(
      rabbitChannel,
      deadQueueName(),
      response.body.messageId,
    );
    expect(deadLetter.messageId).toBe(response.body.messageId);
    expect(deadLetter.trafficClass).toBe(MessageTrafficClass.TRANSACTIONAL);
    expect(deadLetter.reason).toContain(PROVIDER_ERROR_MESSAGE);
    expect(deadLetter.failedAt).toEqual(expect.any(String));

    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(providerCalls).toBe(3);
  });
});
