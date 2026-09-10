import { createServer, type IncomingMessage, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConsentStatus, MessageStatus } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import {
  readBoundedIntegerEnv,
  readBoundedNumberEnv,
  runBoundedLoad,
  summarizeDurations,
} from "../load-profile.util.js";

const PHONE = "96170876543";
const API_KEY_HASH_SECRET = "capacity-profile-api-key-secret-0123456789abcdef";

interface CapacityAttemptValue {
  status: number;
  messageId?: string;
}

function requireInfrastructure(): void {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for capacity integration tests`);
    }
  }
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine capacity Meta mock port"));
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
  timeoutMs: number,
): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }
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
      const byStatus = await prisma.message.groupBy({
        by: ["status"],
        where: { id: { in: messageIds } },
        _count: { _all: true },
      });
      throw new Error(
        `Capacity profile drain exceeded ${timeoutMs}ms: ${JSON.stringify(byStatus)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("end-to-end capacity profile", () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let metaServer: Server;
  let tenantId: string;
  let apiKey: string;
  let providerCalls = 0;

  beforeAll(async () => {
    requireInfrastructure();

    metaServer = createServer(async (incoming, response) => {
      try {
        if (incoming.method !== "POST" || !incoming.url?.endsWith("/messages")) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        await readRawBody(incoming);
        providerCalls += 1;
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ messages: [{ id: `wamid.capacity.${providerCalls}` }] }));
      } catch (error) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "capacity-profile-meta-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "capacity-profile-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "capacity-profile-access-token";
    process.env.MEDIA_MALWARE_SCAN_MODE = "disabled";
    process.env.MEDIA_BINARY_STORAGE_MODE = "disabled";
    process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS = "3600000";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.capacity.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "25";
    process.env.OUTBOX_BATCH_SIZE = "500";
    process.env.OUTBOUND_WORKER_PREFETCH = "200";
    process.env.OUTBOUND_WORKER_PREFETCH_TRANSACTIONAL = "200";
    process.env.OUTBOUND_MESSAGE_LEASE_MS = "10000";
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

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `Capacity Profile Tenant ${suffix}`,
        slug: `capacity-profile-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "capacity-profile",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "Capacity Profile Contact",
        consentStatus: ConsentStatus.OPTED_IN,
        consentSource: "capacity-test",
        consentAt: new Date(),
        lastInboundAt: new Date(),
        serviceWindowExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const providerPhoneNumberId = String(Date.now());
    await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId,
        wabaId: `${providerPhoneNumberId}1`,
        displayPhoneNumber: "+961 70 876 543",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 1000,
        active: true,
        isDefault: true,
      },
    });
  });

  afterAll(async () => {
    try {
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
    } finally {
      await worker?.close().catch(() => undefined);
      await app?.close().catch(() => undefined);
      if (metaServer) {
        await closeServer(metaServer).catch(() => undefined);
      }
      delete process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS;
      delete process.env.MEDIA_BINARY_STORAGE_MODE;
    }
  });

  it("measures bounded acceptance latency, error rate, uniqueness and queue drain", async () => {
    const total = readBoundedIntegerEnv("CAPACITY_MESSAGES", 40, 1, 100_000);
    const concurrency = readBoundedIntegerEnv(
      "CAPACITY_CONCURRENCY",
      Math.min(10, total),
      1,
      total,
    );
    const targetRatePerSecond = readBoundedNumberEnv(
      "CAPACITY_TARGET_RPS",
      0,
      0,
      10_000,
    );
    const maxP95Ms = readBoundedNumberEnv("CAPACITY_ACCEPT_P95_MS", 3000, 1, 60_000);
    const maxP99Ms = readBoundedNumberEnv("CAPACITY_ACCEPT_P99_MS", 5000, 1, 60_000);
    const maxErrorRate = readBoundedNumberEnv("CAPACITY_MAX_ERROR_RATE", 0, 0, 1);
    const drainMaxMs = readBoundedIntegerEnv("CAPACITY_DRAIN_MAX_MS", 45_000, 1000, 600_000);

    const runId = `${process.pid}-${Date.now()}`;
    const acceptanceStartedAt = performance.now();
    const attempts = await runBoundedLoad<CapacityAttemptValue>(
      { total, concurrency, targetRatePerSecond },
      async (index) => {
        const response = await request(app.getHttpServer())
          .post("/api/v1/messages")
          .set("X-API-Key", apiKey)
          .set("Idempotency-Key", `capacity-${runId}-${index}`)
          .send({
            to: `+${PHONE}`,
            type: "TEXT",
            payload: { body: `Capacity message ${index}` },
          });
        return {
          status: response.status,
          messageId: response.body.messageId as string | undefined,
        };
      },
    );
    const acceptanceWallMs = performance.now() - acceptanceStartedAt;

    const accepted = attempts.filter(
      (attempt) => attempt.value?.status === 202 && Boolean(attempt.value.messageId),
    );
    const messageIds = accepted
      .map((attempt) => attempt.value?.messageId)
      .filter((messageId): messageId is string => Boolean(messageId));
    const errorRate = (total - accepted.length) / total;
    const latency = summarizeDurations(attempts.map((attempt) => attempt.durationMs));

    expect(errorRate).toBeLessThanOrEqual(maxErrorRate);
    expect(new Set(messageIds).size).toBe(messageIds.length);
    expect(latency.p95Ms).toBeLessThanOrEqual(maxP95Ms);
    expect(latency.p99Ms).toBeLessThanOrEqual(maxP99Ms);

    const drainStartedAt = performance.now();
    await waitForSubmitted(prisma, messageIds, drainMaxMs);
    const drainMs = performance.now() - drainStartedAt;
    expect(drainMs).toBeLessThanOrEqual(drainMaxMs);
    expect(providerCalls).toBe(messageIds.length);

    const totalWallMs = performance.now() - acceptanceStartedAt;
    const report = {
      total,
      concurrency,
      targetRatePerSecond,
      accepted: accepted.length,
      errors: total - accepted.length,
      errorRate,
      acceptanceWallMs: Math.round(acceptanceWallMs),
      latencyMs: {
        min: Math.round(latency.minMs),
        p50: Math.round(latency.p50Ms),
        p95: Math.round(latency.p95Ms),
        p99: Math.round(latency.p99Ms),
        max: Math.round(latency.maxMs),
      },
      drainMs: Math.round(drainMs),
      acceptanceThroughputPerSecond:
        acceptanceWallMs > 0 ? Number((accepted.length / (acceptanceWallMs / 1000)).toFixed(2)) : 0,
      endToEndThroughputPerSecond:
        totalWallMs > 0 ? Number((accepted.length / (totalWallMs / 1000)).toFixed(2)) : 0,
    };
    process.stdout.write(`[capacity-profile] ${JSON.stringify(report)}\n`);
  }, 660_000);
});
