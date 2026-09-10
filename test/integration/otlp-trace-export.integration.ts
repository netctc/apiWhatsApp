import { createServer, type IncomingMessage, type Server } from "node:http";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { OtlpTraceExporterService } from "../../src/observability/otlp-trace-exporter.service.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

function requireInfrastructure(): void {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for integration tests`);
    }
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
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
        reject(new Error("Unable to determine OTLP integration mock port"));
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

describe("OTLP trace export integration", () => {
  let app: INestApplication;
  let collector: Server;
  let exporter: OtlpTraceExporterService;
  const calls: CapturedRequest[] = [];

  beforeAll(async () => {
    requireInfrastructure();
    collector = createServer(async (incoming, response) => {
      calls.push({
        method: incoming.method,
        url: incoming.url,
        headers: incoming.headers,
        body: await readBody(incoming),
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    const collectorPort = await listen(collector);

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = "otlp-integration-api-key-secret-0123456789";
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_APP_SECRET = "otlp-integration-meta-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "otlp-integration-verify-token";
    process.env.MEDIA_MALWARE_SCAN_MODE = "disabled";
    process.env.MEDIA_BINARY_STORAGE_MODE = "disabled";
    process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS = "3600000";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.otlp.integration.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "1000";
    process.env.WEBHOOK_PROCESSOR_INTERVAL_MS = "1000";
    process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS = "1000";
    process.env.OTEL_SERVICE_NAME = "api-whatsapp-integration";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${collectorPort}/v1/traces`;
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = "3000";
    process.env.OTEL_BSP_SCHEDULE_DELAY = "60000";

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
    exporter = app.get(OtlpTraceExporterService);
  });

  afterAll(async () => {
    await app?.close();
    if (collector) {
      await closeServer(collector);
    }

    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT;
    delete process.env.OTEL_BSP_SCHEDULE_DELAY;
    delete process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS;
    delete process.env.MEDIA_BINARY_STORAGE_MODE;
  });

  it("continues a W3C parent and exports the completed Nest server span", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/health/live")
      .set("traceparent", `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`)
      .set("x-request-id", "otlp-integration-request")
      .expect(200);

    const returnedTraceparent = String(response.headers.traceparent);
    expect(returnedTraceparent).toMatch(
      new RegExp(`^00-${TRACE_ID}-([0-9a-f]{16})-01$`),
    );
    const spanId = returnedTraceparent.split("-")[2];

    await exporter.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "/v1/traces" });
    expect(calls[0].headers["content-type"]).toBe("application/json");

    const payload = JSON.parse(calls[0].body.toString("utf8")) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
        scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
      }>;
    };
    const resource = payload.resourceSpans[0];
    expect(resource.resource.attributes).toEqual(
      expect.arrayContaining([
        { key: "service.name", value: { stringValue: "api-whatsapp-integration" } },
      ]),
    );

    const span = resource.scopeSpans[0].spans[0];
    expect(span).toMatchObject({
      traceId: TRACE_ID,
      spanId,
      parentSpanId: PARENT_SPAN_ID,
      kind: 2,
      status: { code: 0 },
    });
    expect(span.name).toMatch(/^HTTP GET /);

    const serialized = JSON.stringify(span);
    expect(serialized).not.toContain("otlp-integration-request");
    expect(serialized).not.toContain("traceparent");
    expect(serialized).not.toContain("/api/health/live");
  });
});
