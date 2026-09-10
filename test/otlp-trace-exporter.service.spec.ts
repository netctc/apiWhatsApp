import { createServer, type IncomingMessage, type Server } from "node:http";
import { OtlpTraceExporterService } from "../src/observability/otlp-trace-exporter.service.js";

const OTEL_ENV_KEYS = [
  "NODE_ENV",
  "OTEL_SERVICE_NAME",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_TIMEOUT",
  "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
  "OTEL_BSP_MAX_QUEUE_SIZE",
  "OTEL_BSP_MAX_EXPORT_BATCH_SIZE",
  "OTEL_BSP_SCHEDULE_DELAY",
] as const;

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
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
        reject(new Error("Unable to determine OTLP mock port"));
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

describe("OtlpTraceExporterService", () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of OTEL_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    for (const key of OTEL_ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("exports sampled spans as OTLP HTTP/JSON with bounded safe metadata", async () => {
    const calls: CapturedRequest[] = [];
    const server = createServer(async (request, response) => {
      calls.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await readBody(request),
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    const port = await listen(server);

    process.env.NODE_ENV = "test";
    process.env.OTEL_SERVICE_NAME = "api-whatsapp-test";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${port}/custom/traces`;
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer%20generic,content-type=text/plain";
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = "authorization=Bearer%20trace";
    process.env.OTEL_BSP_SCHEDULE_DELAY = "60000";

    const service = new OtlpTraceExporterService();
    try {
      service.recordSpan({
        context: {
          requestId: "req-1",
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          parentSpanId: "1111111111111111",
          traceFlags: "01",
        },
        name: "HTTP POST MessagesController.create",
        kind: 2,
        startTimeUnixNano: 1_700_000_000_000_000_000n,
        endTimeUnixNano: 1_700_000_000_100_000_000n,
        attributes: {
          "http.request.method": "POST",
          "http.response.status_code": 202,
          "app.boolean": true,
        },
        statusCode: 0,
      });
      await service.flush();

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "POST", url: "/custom/traces" });
      expect(calls[0].headers["content-type"]).toBe("application/json");
      expect(calls[0].headers.authorization).toBe("Bearer trace");

      const payload = JSON.parse(calls[0].body.toString("utf8")) as {
        resourceSpans: Array<{
          resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
          scopeSpans: Array<{
            scope: { name: string; version: string };
            spans: Array<Record<string, unknown>>;
          }>;
        }>;
      };
      const resource = payload.resourceSpans[0];
      expect(resource.resource.attributes).toEqual(
        expect.arrayContaining([
          { key: "service.name", value: { stringValue: "api-whatsapp-test" } },
          { key: "deployment.environment.name", value: { stringValue: "test" } },
        ]),
      );
      const span = resource.scopeSpans[0].spans[0];
      expect(span).toMatchObject({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        parentSpanId: "1111111111111111",
        flags: 1,
        name: "HTTP POST MessagesController.create",
        kind: 2,
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000000100000000",
        status: { code: 0 },
      });
      expect(span.attributes).toEqual(
        expect.arrayContaining([
          { key: "http.request.method", value: { stringValue: "POST" } },
          { key: "http.response.status_code", value: { intValue: "202" } },
          { key: "app.boolean", value: { boolValue: true } },
        ]),
      );
    } finally {
      await service.onModuleDestroy();
      await closeServer(server);
    }
  });

  it("appends the trace signal path to the generic OTLP endpoint", async () => {
    const calls: CapturedRequest[] = [];
    const server = createServer(async (request, response) => {
      calls.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await readBody(request),
      });
      response.statusCode = 200;
      response.end("{}");
    });
    const port = await listen(server);
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}/collector/`;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
    process.env.OTEL_BSP_SCHEDULE_DELAY = "60000";

    const service = new OtlpTraceExporterService();
    try {
      service.recordSpan({
        context: {
          requestId: "req-2",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          spanId: "bbbbbbbbbbbbbbbb",
          traceFlags: "01",
        },
        name: "worker",
        kind: 5,
        startTimeUnixNano: 10n,
        endTimeUnixNano: 20n,
      });
      await service.flush();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("/collector/v1/traces");
    } finally {
      await service.onModuleDestroy();
      await closeServer(server);
    }
  });

  it("honors the W3C sampling flag and never exports an unsampled span", async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:9/v1/traces";
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
    process.env.OTEL_BSP_SCHEDULE_DELAY = "60000";

    const service = new OtlpTraceExporterService();
    try {
      service.recordSpan({
        context: {
          requestId: "req-3",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          spanId: "bbbbbbbbbbbbbbbb",
          traceFlags: "00",
        },
        name: "not-sampled",
        kind: 1,
        startTimeUnixNano: 10n,
        endTimeUnixNano: 20n,
      });
      await expect(service.flush()).resolves.toBeUndefined();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it("drops a collector failure without failing the application path", async () => {
    const server = createServer(async (request, response) => {
      await readBody(request);
      response.statusCode = 503;
      response.end("unavailable");
    });
    const port = await listen(server);
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${port}/v1/traces`;
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
    process.env.OTEL_BSP_SCHEDULE_DELAY = "60000";

    const service = new OtlpTraceExporterService();
    try {
      service.recordSpan({
        context: {
          requestId: "req-4",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          spanId: "bbbbbbbbbbbbbbbb",
          traceFlags: "01",
        },
        name: "collector-failure",
        kind: 1,
        startTimeUnixNano: 10n,
        endTimeUnixNano: 20n,
      });
      await expect(service.flush()).resolves.toBeUndefined();
    } finally {
      await service.onModuleDestroy();
      await closeServer(server);
    }
  });
});
