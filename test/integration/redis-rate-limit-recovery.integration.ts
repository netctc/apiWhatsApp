import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConsentStatus, MessageStatus } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const PHONE = "96170555444";
const API_KEY_HASH_SECRET = "redis-recovery-api-key-hash-secret-0123456789";

interface RedisFaultProxy {
  url: string;
  enableForwarding(): void;
  waitForForwardedConnection(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

function requireInfrastructure(): string {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for integration tests`);
    }
  }
  return process.env.REDIS_URL!;
}

function readRawBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function listenHttp(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine HTTP test server port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createRedisFaultProxy(upstreamUrl: string): Promise<RedisFaultProxy> {
  const parsed = new URL(upstreamUrl);
  if (parsed.protocol !== "redis:") {
    throw new Error("Redis recovery integration requires a redis:// upstream URL");
  }

  const upstreamHost = parsed.hostname;
  const upstreamPort = Number(parsed.port || 6379);
  let forwarding = false;
  let forwardedConnections = 0;
  const sockets = new Set<Socket>();
  const waiters = new Set<() => void>();

  const server: TcpServer = createTcpServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));

    if (!forwarding) {
      client.destroy();
      return;
    }

    const upstream = connectTcp({ host: upstreamHost, port: upstreamPort });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());

    upstream.once("connect", () => {
      forwardedConnections += 1;
      for (const resolve of waiters) {
        resolve();
      }
      waiters.clear();
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine Redis fault proxy port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    url: `redis://127.0.0.1:${port}`,
    enableForwarding() {
      forwarding = true;
    },
    waitForForwardedConnection(timeoutMs = 2500) {
      if (forwardedConnections > 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(done);
          reject(new Error("Timed out waiting for the Redis client to reconnect through the fault proxy"));
        }, timeoutMs);
        timer.unref();
        waiters.add(done);
      });
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function waitForRateLimiterFailure(
  prisma: PrismaService,
  messageId: string,
  timeoutMs = 7000,
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
        processingLeaseUntil: true,
      },
    });

    if (
      message?.status === MessageStatus.QUEUED &&
      message.attemptCount >= 1 &&
      message.errorCode === "RATE_LIMITER_UNAVAILABLE" &&
      message.processingLeaseUntil === null
    ) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Redis rate-limit failure: ${JSON.stringify(message)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForSubmitted(
  prisma: PrismaService,
  messageId: string,
  timeoutMs = 12000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        status: true,
        attemptCount: true,
        errorCode: true,
        providerMessageId: true,
      },
    });
    if (message?.status === MessageStatus.SUBMITTED) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Redis recovery submission: ${JSON.stringify(message)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Redis rate limiter recovery integration", () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let metaServer: HttpServer;
  let redisProxy: RedisFaultProxy;
  let tenantId: string;
  let apiKey: string;
  let realRedisUrl: string;
  let providerCalls = 0;

  beforeAll(async () => {
    realRedisUrl = requireInfrastructure();
    redisProxy = await createRedisFaultProxy(realRedisUrl);

    metaServer = createHttpServer(async (req, res) => {
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
        res.end(JSON.stringify({ messages: [{ id: `wamid.redis-recovery.${providerCalls}` }] }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listenHttp(metaServer);

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "redis-recovery-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "redis-recovery-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "redis-recovery-meta-access-token";
    process.env.REDIS_URL = redisProxy.url;
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.redis-recovery.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "50";
    process.env.OUTBOX_BATCH_SIZE = "20";
    process.env.OUTBOUND_RETRY_DELAYS_MS = "3000";
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
        displayPhoneNumber: "+961 70 555 444",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 500,
        active: true,
        isDefault: true,
      },
    });
  });

  afterAll(async () => {
    process.env.REDIS_URL = realRedisUrl;
    await worker?.close();
    await app?.close();
    await redisProxy?.close();

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
      await closeHttpServer(metaServer);
    }
  });

  it("retries without contacting Meta while Redis is unavailable and submits once after Redis reconnects", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `redis-recovery-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Retry only after the distributed rate limiter recovers" },
      })
      .expect(202);

    const messageId = response.body.messageId as string;
    await waitForRateLimiterFailure(prisma, messageId);

    const failedAttempt = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: { statusEvents: { orderBy: { createdAt: "asc" } } },
    });
    expect(failedAttempt.status).toBe(MessageStatus.QUEUED);
    expect(failedAttempt.attemptCount).toBe(1);
    expect(failedAttempt.errorCode).toBe("RATE_LIMITER_UNAVAILABLE");
    expect(failedAttempt.errorMessage).toEqual(expect.any(String));
    expect(providerCalls).toBe(0);

    redisProxy.enableForwarding();
    await redisProxy.waitForForwardedConnection();
    await waitForSubmitted(prisma, messageId);

    const recovered = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: { statusEvents: { orderBy: { createdAt: "asc" } } },
    });
    expect(recovered.status).toBe(MessageStatus.SUBMITTED);
    expect(recovered.attemptCount).toBe(2);
    expect(recovered.providerMessageId).toBe("wamid.redis-recovery.1");
    expect(recovered.errorCode).toBeNull();
    expect(recovered.errorMessage).toBeNull();
    expect(recovered.statusEvents.filter((event) => event.status === MessageStatus.PROCESSING)).toHaveLength(2);
    expect(providerCalls).toBe(1);
  });
});
