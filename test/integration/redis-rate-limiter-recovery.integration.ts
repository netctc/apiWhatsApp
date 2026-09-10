import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  createConnection,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConsentStatus, MessageStatus } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

interface RedisProxy {
  url: string;
  setAvailable(available: boolean): void;
  close(): Promise<void>;
}

interface MetaCall {
  body: Record<string, unknown>;
}

const PHONE = "96170543210";
const API_KEY_HASH_SECRET = "redis-recovery-api-key-secret-0123456789abcdef";

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

async function listenHttp(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine Meta Redis-recovery mock port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listenTcp(server: TcpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine Redis proxy port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function createRedisProxy(upstreamUrlRaw: string): Promise<RedisProxy> {
  const upstreamUrl = new URL(upstreamUrlRaw);
  if (upstreamUrl.protocol !== "redis:") {
    throw new Error("Redis recovery integration currently requires a plain redis:// test endpoint");
  }

  const upstreamHost = upstreamUrl.hostname;
  const upstreamPort = Number(upstreamUrl.port || "6379");
  let available = true;
  const downstreamSockets = new Set<Socket>();
  const upstreamSockets = new Set<Socket>();

  const server = createTcpServer((downstream) => {
    downstreamSockets.add(downstream);
    downstream.setNoDelay(true);
    downstream.on("error", () => undefined);
    downstream.on("close", () => downstreamSockets.delete(downstream));

    if (!available) {
      downstream.destroy();
      return;
    }

    const upstream = createConnection({ host: upstreamHost, port: upstreamPort });
    upstreamSockets.add(upstream);
    upstream.setNoDelay(true);
    upstream.on("error", () => downstream.destroy());
    upstream.on("close", () => upstreamSockets.delete(upstream));
    downstream.on("close", () => upstream.destroy());

    upstream.once("connect", () => {
      if (!available || downstream.destroyed) {
        upstream.destroy();
        downstream.destroy();
        return;
      }
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
  });

  const port = await listenTcp(server);
  const proxiedUrl = new URL(upstreamUrlRaw);
  proxiedUrl.hostname = "127.0.0.1";
  proxiedUrl.port = String(port);

  const destroyConnections = (): void => {
    for (const socket of downstreamSockets) {
      socket.destroy();
    }
    for (const socket of upstreamSockets) {
      socket.destroy();
    }
    downstreamSockets.clear();
    upstreamSockets.clear();
  };

  return {
    url: proxiedUrl.toString(),
    setAvailable(nextAvailable: boolean): void {
      available = nextAvailable;
      if (!available) {
        destroyConnections();
      }
    },
    async close(): Promise<void> {
      available = false;
      destroyConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
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
      select: { status: true, attemptCount: true, errorCode: true, errorMessage: true },
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

async function waitForRateLimiterFailure(
  prisma: PrismaService,
  messageId: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { status: true, attemptCount: true, errorCode: true, errorMessage: true },
    });
    if (
      message?.status === MessageStatus.QUEUED &&
      message.errorCode === "RATE_LIMITER_UNAVAILABLE"
    ) {
      return;
    }
    if (message?.status === MessageStatus.FAILED) {
      throw new Error(
        `Message ${messageId} exhausted before Redis recovery: ${JSON.stringify(message)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for Redis rate limiter failure for ${messageId}: ${JSON.stringify(message)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Redis rate-limiter failure recovery", () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let metaServer: Server;
  let redisProxy: RedisProxy;
  let originalRedisUrl: string;
  let rabbitConnection: ChannelModel;
  let rabbitChannel: ConfirmChannel;
  let tenantId: string;
  let apiKey: string;
  let queueBaseName: string;
  const metaCalls: MetaCall[] = [];

  beforeAll(async () => {
    requireInfrastructure();
    originalRedisUrl = process.env.REDIS_URL!;
    redisProxy = await createRedisProxy(originalRedisUrl);

    let providerSequence = 0;
    metaServer = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || !req.url?.endsWith("/messages")) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }

        const body = await readBody(req);
        metaCalls.push({ body });
        providerSequence += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ messages: [{ id: `wamid.redis.${providerSequence}` }] }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listenHttp(metaServer);

    queueBaseName = `whatsapp.failure.redis.${process.pid}.${Date.now()}`;
    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.REDIS_URL = redisProxy.url;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "redis-recovery-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "redis-recovery-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "redis-recovery-access-token";
    process.env.OUTBOUND_QUEUE_NAME = queueBaseName;
    process.env.OUTBOUND_RETRY_DELAYS_MS = "500,1000,2000";
    process.env.OUTBOX_POLL_INTERVAL_MS = "250";
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
        name: `Redis Recovery Tenant ${suffix}`,
        slug: `redis-recovery-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "redis-recovery",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_READ, ApiScope.MESSAGES_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "Redis Recovery Contact",
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
        displayPhoneNumber: "+961 70 543 210",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 1000,
        active: true,
        isDefault: true,
      },
    });
  });

  afterAll(async () => {
    redisProxy?.setAvailable(true);

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
    await redisProxy?.close().catch(() => undefined);
    process.env.REDIS_URL = originalRedisUrl;
    if (metaServer) {
      await closeHttpServer(metaServer).catch(() => undefined);
    }
    delete process.env.OUTBOUND_RETRY_DELAYS_MS;
  });

  it("retries when Redis becomes unavailable and submits after connectivity is restored", async () => {
    const prime = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `redis-prime-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Prime Redis rate limiter connection" },
      })
      .expect(202);
    await waitForMessageStatus(prisma, prime.body.messageId, MessageStatus.SUBMITTED);

    const initialMetaCalls = metaCalls.length;
    expect(initialMetaCalls).toBe(1);

    redisProxy.setAvailable(false);

    const idempotencyKey = `redis-recovery-${Date.now()}`;
    const accepted = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", idempotencyKey)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Recover after Redis outage" },
      })
      .expect(202);

    const messageId = accepted.body.messageId as string;
    await waitForRateLimiterFailure(prisma, messageId);

    expect(metaCalls).toHaveLength(initialMetaCalls);

    redisProxy.setAvailable(true);
    await waitForMessageStatus(prisma, messageId, MessageStatus.SUBMITTED, 15000);

    expect(metaCalls).toHaveLength(initialMetaCalls + 1);
    expect(metaCalls.at(-1)!.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: PHONE,
      type: "text",
      text: { body: "Recover after Redis outage" },
    });

    const persisted = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(persisted.status).toBe(MessageStatus.SUBMITTED);
    expect(persisted.providerMessageId).toBe("wamid.redis.2");
    expect(persisted.attemptCount).toBeGreaterThanOrEqual(2);
    expect(persisted.attemptCount).toBeLessThanOrEqual(4);
    expect(persisted.errorCode).toBeNull();
    expect(persisted.errorMessage).toBeNull();
    expect(persisted.processingLeaseUntil).toBeNull();

    const statusEvents = await prisma.messageStatusEvent.findMany({
      where: { messageId },
      orderBy: { createdAt: "asc" },
    });
    const retryEvents = statusEvents.filter((event) => {
      const payload = event.payload as { retry?: unknown } | null;
      return event.status === MessageStatus.QUEUED && payload?.retry === true;
    });
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    expect(
      retryEvents.every(
        (event) =>
          (event.payload as { errorCode?: string }).errorCode === "RATE_LIMITER_UNAVAILABLE",
      ),
    ).toBe(true);
    expect(persisted.attemptCount).toBe(retryEvents.length + 1);
    expect(statusEvents.filter((event) => event.status === MessageStatus.PROCESSING)).toHaveLength(
      persisted.attemptCount,
    );
    expect(statusEvents.filter((event) => event.status === MessageStatus.SUBMITTED)).toHaveLength(1);

    expect(
      await prisma.message.count({
        where: { tenantId, idempotencyKey },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: messageId },
      }),
    ).toBe(1);

    const deadQueue = await rabbitChannel.checkQueue(`${queueBaseName}.transactional.dead`);
    expect(deadQueue.messageCount).toBe(0);
  }, 20000);
});
