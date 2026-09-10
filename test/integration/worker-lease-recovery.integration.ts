import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import { createServer, type IncomingMessage, type Server } from "node:http";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConsentStatus, MessageStatus } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

interface MetaCall {
  receivedAtMs: number;
  body: Record<string, unknown>;
}

const PHONE = "96170654321";
const API_KEY_HASH_SECRET = "lease-recovery-api-key-secret-0123456789abcdef";

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
        reject(new Error("Unable to determine Meta lease-recovery mock port"));
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
      select: { publishedAt: true, lastError: true },
    });
    if (event?.publishedAt) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for outbox publication for ${messageId}: ${JSON.stringify(event)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
      select: {
        status: true,
        attemptCount: true,
        processingLeaseUntil: true,
        errorCode: true,
      },
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

describe("worker processing-lease recovery", () => {
  let app: INestApplication;
  let worker: INestApplicationContext | undefined;
  let prisma: PrismaService;
  let metaServer: Server;
  let rabbitConnection: ChannelModel;
  let rabbitChannel: ConfirmChannel;
  let tenantId: string;
  let apiKey: string;
  let senderProviderId: string;
  let queueBaseName: string;
  const metaCalls: MetaCall[] = [];

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
        metaCalls.push({ receivedAtMs: Date.now(), body });
        providerSequence += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ messages: [{ id: `wamid.lease.${providerSequence}` }] }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    queueBaseName = `whatsapp.failure.lease.${process.pid}.${Date.now()}`;
    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "lease-recovery-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "lease-recovery-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "lease-recovery-access-token";
    process.env.OUTBOUND_QUEUE_NAME = queueBaseName;
    process.env.OUTBOUND_RETRY_DELAYS_MS = "200";
    process.env.OUTBOX_POLL_INTERVAL_MS = "250";
    process.env.OUTBOX_BATCH_SIZE = "20";
    process.env.OUTBOUND_WORKER_PREFETCH = "10";
    process.env.OUTBOUND_WORKER_PREFETCH_TRANSACTIONAL = "10";
    process.env.OUTBOUND_MESSAGE_LEASE_MS = "5000";
    process.env.DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND = "1000";
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
        name: `Lease Recovery Tenant ${suffix}`,
        slug: `lease-recovery-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "lease-recovery",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_READ, ApiScope.MESSAGES_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "Lease Recovery Contact",
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
        displayPhoneNumber: "+961 70 654 321",
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

  it("defers active-lease redeliveries without consuming retry budget and recovers after lease expiry", async () => {
    const accepted = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `lease-recovery-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Recover after simulated worker crash" },
      })
      .expect(202);

    const messageId = accepted.body.messageId as string;
    await waitForOutboxPublished(prisma, messageId);

    const simulatedLeaseUntil = new Date(Date.now() + 2500);
    await prisma.message.update({
      where: { id: messageId },
      data: {
        status: MessageStatus.PROCESSING,
        attemptCount: 1,
        lastAttemptAt: new Date(),
        processingLeaseUntil: simulatedLeaseUntil,
      },
    });

    expect(metaCalls).toHaveLength(0);

    const { WorkerModule } = await import("../../src/worker/worker.module.js");
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });

    await waitForMessageStatus(prisma, messageId, MessageStatus.SUBMITTED, 10000);

    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0]!.receivedAtMs).toBeGreaterThanOrEqual(simulatedLeaseUntil.getTime() - 50);
    expect(metaCalls[0]!.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: PHONE,
      type: "text",
      text: { body: "Recover after simulated worker crash" },
    });

    const persisted = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(persisted.status).toBe(MessageStatus.SUBMITTED);
    expect(persisted.attemptCount).toBe(2);
    expect(persisted.providerMessageId).toBe("wamid.lease.1");
    expect(persisted.processingLeaseUntil).toBeNull();
    expect(persisted.errorCode).toBeNull();
    expect(persisted.errorMessage).toBeNull();

    const statusEvents = await prisma.messageStatusEvent.findMany({
      where: { messageId },
      orderBy: { createdAt: "asc" },
    });
    const workerProcessingEvents = statusEvents.filter(
      (event) => event.status === MessageStatus.PROCESSING,
    );
    expect(workerProcessingEvents).toHaveLength(1);
    expect(workerProcessingEvents[0]!.payload).toMatchObject({
      queueAttempt: 1,
      trafficClass: "TRANSACTIONAL",
    });
    expect(
      statusEvents.filter((event) => {
        const payload = event.payload as { retry?: unknown } | null;
        return event.status === MessageStatus.QUEUED && payload?.retry === true;
      }),
    ).toHaveLength(0);
    expect(statusEvents.filter((event) => event.status === MessageStatus.SUBMITTED)).toHaveLength(1);

    const deadQueue = await rabbitChannel.checkQueue(`${queueBaseName}.transactional.dead`);
    expect(deadQueue.messageCount).toBe(0);
  }, 15000);
});
