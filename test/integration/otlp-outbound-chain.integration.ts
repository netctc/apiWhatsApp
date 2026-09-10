import { createServer, type IncomingMessage, type Server } from "node:http";
import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConsentStatus, MessageStatus } from "../../src/generated/prisma/client.js";
import { OtlpTraceExporterService } from "../../src/observability/otlp-trace-exporter.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const INCOMING_PARENT_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${INCOMING_PARENT_SPAN_ID}-01`;
const PHONE = "96170987654";
const API_KEY_HASH_SECRET = "otlp-outbound-chain-api-key-secret-0123456789";

interface CollectorCall {
  method?: string;
  url?: string;
  body: Buffer;
}

interface MetaCall {
  method?: string;
  url?: string;
  traceparent?: string | string[];
  body: Record<string, unknown>;
}

interface ExportedSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  attributes?: Array<{ key: string; value: Record<string, unknown> }>;
  status?: { code?: number };
}

function requireInfrastructure(): void {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for integration tests`);
    }
  }
}

async function readRawBody(incoming: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(incoming: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(incoming);
  return raw.length > 0 ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine integration mock port"));
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

async function waitForSubmitted(prisma: PrismaService, messageId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { status: true, errorCode: true, errorMessage: true },
    });
    if (message?.status === MessageStatus.SUBMITTED) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for submitted message: ${JSON.stringify(message)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function spansFromCalls(calls: CollectorCall[]): ExportedSpan[] {
  return calls.flatMap((call) => {
    const payload = JSON.parse(call.body.toString("utf8")) as {
      resourceSpans?: Array<{
        scopeSpans?: Array<{ spans?: ExportedSpan[] }>;
      }>;
    };
    return (payload.resourceSpans ?? []).flatMap((resource) =>
      (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
    );
  });
}

describe("distributed outbound OTLP trace integration", () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let appExporter: OtlpTraceExporterService;
  let workerExporter: OtlpTraceExporterService;
  let collector: Server;
  let metaServer: Server;
  let tenantId: string;
  let apiKey: string;
  const collectorCalls: CollectorCall[] = [];
  const metaCalls: MetaCall[] = [];

  beforeAll(async () => {
    requireInfrastructure();

    collector = createServer(async (incoming, response) => {
      collectorCalls.push({
        method: incoming.method,
        url: incoming.url,
        body: await readRawBody(incoming),
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    const collectorPort = await listen(collector);

    metaServer = createServer(async (incoming, response) => {
      if (incoming.method !== "POST" || !incoming.url?.endsWith("/messages")) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      metaCalls.push({
        method: incoming.method,
        url: incoming.url,
        traceparent: incoming.headers.traceparent,
        body: await readJsonBody(incoming),
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ messages: [{ id: "wamid.otlp.outbound.chain" }] }));
    });
    const metaPort = await listen(metaServer);

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "otlp-outbound-chain-meta-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "otlp-outbound-chain-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "otlp-outbound-chain-access-token";
    process.env.MEDIA_MALWARE_SCAN_MODE = "disabled";
    process.env.MEDIA_BINARY_STORAGE_MODE = "disabled";
    process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS = "3600000";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.otlp.outbound.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "50";
    process.env.OUTBOX_BATCH_SIZE = "20";
    process.env.OUTBOUND_WORKER_PREFETCH = "20";
    process.env.OUTBOUND_WORKER_PREFETCH_TRANSACTIONAL = "20";
    process.env.OUTBOUND_MESSAGE_LEASE_MS = "5000";
    process.env.DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND = "100";
    process.env.WEBHOOK_PROCESSOR_INTERVAL_MS = "1000";
    process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS = "1000";
    process.env.OTEL_SERVICE_NAME = "api-whatsapp-outbound-chain-test";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${collectorPort}/v1/traces`;
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = "3000";
    process.env.OTEL_BSP_SCHEDULE_DELAY = "60000";
    process.env.OTEL_TRACES_SAMPLER = "parentbased_always_on";

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
    appExporter = app.get(OtlpTraceExporterService);
    workerExporter = worker.get(OtlpTraceExporterService);

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `OTLP Outbound Tenant ${suffix}`,
        slug: `otlp-outbound-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "otlp-outbound",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MESSAGES_WRITE],
      },
    });

    await prisma.contact.create({
      data: {
        tenantId,
        phone: PHONE,
        name: "OTLP Outbound Contact",
        consentStatus: ConsentStatus.OPTED_IN,
        consentSource: "integration-test",
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
        displayPhoneNumber: "+961 70 987 654",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 100,
        active: true,
        isDefault: true,
      },
    });
  });

  afterAll(async () => {
    await Promise.allSettled([
      worker ? worker.close() : Promise.resolve(),
      app ? app.close() : Promise.resolve(),
    ]);

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
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.apiKey.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
    } finally {
      if (metaServer) {
        await closeServer(metaServer).catch(() => undefined);
      }
      if (collector) {
        await closeServer(collector).catch(() => undefined);
      }

      delete process.env.OTEL_SERVICE_NAME;
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT;
      delete process.env.OTEL_BSP_SCHEDULE_DELAY;
      delete process.env.OTEL_TRACES_SAMPLER;
      delete process.env.OTEL_TRACES_SAMPLER_ARG;
      delete process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS;
      delete process.env.MEDIA_BINARY_STORAGE_MODE;
    }
  });

  it("exports SERVER -> PRODUCER -> CONSUMER -> CLIENT for one traced outbound delivery", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/messages")
      .set("X-API-Key", apiKey)
      .set("Idempotency-Key", `otlp-outbound-${Date.now()}`)
      .set("traceparent", TRACEPARENT)
      .set("x-request-id", "otlp-outbound-request")
      .send({
        to: `+${PHONE}`,
        type: "TEXT",
        payload: { body: "OTLP outbound integration message" },
      })
      .expect(202);

    const returnedTraceparent = String(response.headers.traceparent);
    expect(returnedTraceparent).toMatch(new RegExp(`^00-${TRACE_ID}-([0-9a-f]{16})-01$`));
    const serverSpanId = returnedTraceparent.split("-")[2];

    await waitForSubmitted(prisma, response.body.messageId as string);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await Promise.all([appExporter.flush(), workerExporter.flush()]);

    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0].traceparent).toBeUndefined();

    const tracedSpans = spansFromCalls(collectorCalls).filter((span) => span.traceId === TRACE_ID);
    const server = tracedSpans.find((span) => span.kind === 2 && span.name?.startsWith("HTTP POST "));
    const producer = tracedSpans.find(
      (span) => span.kind === 4 && span.name === "rabbitmq publish whatsapp.outbound",
    );
    const consumer = tracedSpans.find(
      (span) => span.kind === 5 && span.name === "whatsapp.outbound.process",
    );
    const client = tracedSpans.find(
      (span) => span.kind === 3 && span.name === "meta.whatsapp send_message",
    );

    expect(server).toMatchObject({
      traceId: TRACE_ID,
      spanId: serverSpanId,
      parentSpanId: INCOMING_PARENT_SPAN_ID,
      kind: 2,
      status: { code: 0 },
    });
    expect(producer).toMatchObject({
      traceId: TRACE_ID,
      parentSpanId: serverSpanId,
      kind: 4,
      status: { code: 0 },
    });
    expect(consumer).toMatchObject({
      traceId: TRACE_ID,
      parentSpanId: producer?.spanId,
      kind: 5,
      status: { code: 0 },
    });
    expect(client).toMatchObject({
      traceId: TRACE_ID,
      parentSpanId: consumer?.spanId,
      kind: 3,
      status: { code: 0 },
    });

    expect(producer?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(consumer?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(client?.spanId).toMatch(/^[0-9a-f]{16}$/);

    const serialized = JSON.stringify(tracedSpans);
    expect(serialized).not.toContain(response.body.messageId as string);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain("OTLP outbound integration message");
    expect(serialized).not.toContain("otlp-outbound-request");
  });
});
