import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConsentStatus, MessageStatus } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const PHONE = "96170444333";
const API_KEY_HASH_SECRET = "worker-crash-api-key-hash-secret-0123456789";

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

function waitForSignal(signal: Promise<void>, label: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    timer.unref();
    void signal.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function startWorkerProcess(): ChildProcess {
  return spawn(process.execPath, ["dist/worker.js"], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForWorkerReady(child: ChildProcess, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };

    const finish = () => {
      cleanup();
      resolve();
    };

    const fail = (message: string) => {
      cleanup();
      reject(new Error(`${message}\nWorker output:\n${output}`));
    };

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("Outbound WhatsApp worker is ready") || output.includes("outbound worker started")) {
        finish();
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(`Worker exited before becoming ready (code=${String(code)}, signal=${String(signal)})`);
    };

    const timer = setTimeout(() => fail("Timed out waiting for child worker readiness"), timeoutMs);
    timer.unref();
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function killWorkerAbruptly(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for SIGKILLed worker to exit")), 5000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (!child.kill("SIGKILL")) {
    throw new Error("Unable to send SIGKILL to worker process");
  }
  await exited;
}

async function waitForActiveSecondClaim(
  prisma: PrismaService,
  messageId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        status: true,
        attemptCount: true,
        processingLeaseUntil: true,
      },
    });

    if (
      message?.status === MessageStatus.PROCESSING &&
      message.attemptCount === 2 &&
      message.processingLeaseUntil &&
      message.processingLeaseUntil.getTime() > Date.now()
    ) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for second active processing claim: ${JSON.stringify(message)}`);
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
        providerMessageId: true,
        errorCode: true,
        processingLeaseUntil: true,
      },
    });

    if (message?.status === MessageStatus.SUBMITTED) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for crashed-worker recovery: ${JSON.stringify(message)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("worker crash processing-lease recovery integration", () => {
  let app: INestApplication;
  let recoveryWorker: INestApplicationContext | undefined;
  let crashedWorker: ChildProcess | undefined;
  let prisma: PrismaService;
  let metaServer: Server;
  let tenantId: string;
  let apiKey: string;
  let providerRequests = 0;
  let providerSuccesses = 0;
  let secondRequestSeen: Promise<void>;
  let resolveSecondRequestSeen: () => void;
  let secondRequestClosed: Promise<void>;
  let resolveSecondRequestClosed: () => void;

  beforeAll(async () => {
    requireInfrastructure();

    secondRequestSeen = new Promise<void>((resolve) => {
      resolveSecondRequestSeen = resolve;
    });
    secondRequestClosed = new Promise<void>((resolve) => {
      resolveSecondRequestClosed = resolve;
    });

    metaServer = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || !req.url?.endsWith("/messages")) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }

        await readRawBody(req);
        providerRequests += 1;

        if (providerRequests === 1) {
          res.statusCode = 503;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: 2, message: "Injected transient provider failure" } }));
          return;
        }

        if (providerRequests === 2) {
          res.once("close", resolveSecondRequestClosed);
          resolveSecondRequestSeen();
          return;
        }

        providerSuccesses += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ messages: [{ id: `wamid.worker-crash.${providerSuccesses}` }] }));
      } catch (error) {
        if (!res.destroyed) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
        }
      }
    });
    const metaPort = await listen(metaServer);

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "15000";
    process.env.META_APP_SECRET = "worker-crash-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "worker-crash-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "worker-crash-meta-access-token";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.worker-crash.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "50";
    process.env.OUTBOX_BATCH_SIZE = "20";
    process.env.OUTBOUND_RETRY_DELAYS_MS = "1000";
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

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `Worker Crash Tenant ${suffix}`,
        slug: `worker-crash-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "worker-crash",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_READ, ApiScope.MESSAGES_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "Worker Crash Contact",
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
    if (crashedWorker && crashedWorker.exitCode === null && crashedWorker.signalCode === null) {
      await killWorkerAbruptly(crashedWorker).catch(() => undefined);
    }
    await recoveryWorker?.close();
    await app?.close();

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

  it("recovers an unacked final-attempt delivery after a worker dies with an active lease", async () => {
    crashedWorker = startWorkerProcess();
    await waitForWorkerReady(crashedWorker);

    const response = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `worker-crash-${Date.now()}`)
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "Recover after the worker process disappears" },
      })
      .expect(202);

    const messageId = response.body.messageId as string;
    await waitForSignal(secondRequestSeen, "the final retry request to reach the Meta test double");
    await waitForActiveSecondClaim(prisma, messageId);

    const beforeCrash = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(beforeCrash.status).toBe(MessageStatus.PROCESSING);
    expect(beforeCrash.attemptCount).toBe(2);
    expect(beforeCrash.processingLeaseUntil).not.toBeNull();
    expect(beforeCrash.processingLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(providerRequests).toBe(2);
    expect(providerSuccesses).toBe(0);

    await killWorkerAbruptly(crashedWorker);
    await waitForSignal(secondRequestClosed, "the killed worker Meta socket to close", 5000);

    const { WorkerModule } = await import("../../src/worker/worker.module.js");
    recoveryWorker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });

    await waitForSubmitted(prisma, messageId);

    const recovered = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: { statusEvents: { orderBy: { createdAt: "asc" } } },
    });

    expect(recovered.status).toBe(MessageStatus.SUBMITTED);
    expect(recovered.attemptCount).toBe(3);
    expect(recovered.providerMessageId).toBe("wamid.worker-crash.1");
    expect(recovered.processingLeaseUntil).toBeNull();
    expect(recovered.errorCode).toBeNull();
    expect(recovered.errorMessage).toBeNull();
    expect(recovered.statusEvents.filter((event) => event.status === MessageStatus.PROCESSING)).toHaveLength(3);
    expect(providerRequests).toBe(3);
    expect(providerSuccesses).toBe(1);
  });
});
