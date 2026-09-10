import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { APP_VERSION } from "../version.js";
import type { TraceContext } from "./trace-context.service.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_QUEUE_SIZE = 2_048;
const MAX_QUEUE_SIZE = 10_000;
const DEFAULT_BATCH_SIZE = 512;
const DEFAULT_SCHEDULE_DELAY_MS = 5_000;
const MAX_SCHEDULE_DELAY_MS = 60_000;
const MAX_ATTRIBUTES = 32;
const MAX_ATTRIBUTE_KEY_LENGTH = 128;
const MAX_ATTRIBUTE_STRING_LENGTH = 512;
const OTLP_HTTP_JSON_PROTOCOL = "http/json";

export type OtlpSpanKind = 1 | 2 | 3 | 4 | 5;
export type OtlpSpanStatusCode = 0 | 1 | 2;
export type OtlpAttributeValue = string | number | boolean;

export interface OtlpSpanInput {
  context: TraceContext;
  name: string;
  kind: OtlpSpanKind;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes?: Record<string, OtlpAttributeValue>;
  statusCode?: OtlpSpanStatusCode;
}

interface OtlpExporterConfiguration {
  endpoint: URL;
  headers: Record<string, string>;
  timeoutMs: number;
  maxQueueSize: number;
  maxBatchSize: number;
  scheduleDelayMs: number;
  serviceName: string;
}

interface QueuedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  flags: number;
  name: string;
  kind: OtlpSpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{
    key: string;
    value: {
      stringValue?: string;
      boolValue?: boolean;
      intValue?: string;
      doubleValue?: number;
    };
  }>;
  status: { code: OtlpSpanStatusCode };
}

@Injectable()
export class OtlpTraceExporterService implements OnModuleDestroy {
  private readonly logger = new Logger(OtlpTraceExporterService.name);
  private readonly configuration?: OtlpExporterConfiguration;
  private readonly queue: QueuedSpan[] = [];
  private flushTimer?: NodeJS.Timeout;
  private flushInFlight?: Promise<void>;
  private droppedSpans = 0;
  private shuttingDown = false;

  constructor() {
    try {
      this.configuration = this.readConfiguration();
    } catch {
      this.logger.error("OpenTelemetry trace exporter disabled because its configuration is invalid");
      this.configuration = undefined;
    }

    if (this.configuration) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, this.configuration.scheduleDelayMs);
      this.flushTimer.unref();
    }
  }

  recordSpan(input: OtlpSpanInput): void {
    const config = this.configuration;
    if (!config || this.shuttingDown || !this.isSampled(input.context.traceFlags)) {
      return;
    }
    if (input.endTimeUnixNano < input.startTimeUnixNano) {
      return;
    }
    if (this.queue.length >= config.maxQueueSize) {
      this.droppedSpans += 1;
      if (this.droppedSpans === 1 || this.droppedSpans % 100 === 0) {
        this.logger.warn(`Dropped ${this.droppedSpans} OpenTelemetry spans because the local queue is full`);
      }
      return;
    }

    this.queue.push({
      traceId: input.context.traceId,
      spanId: input.context.spanId,
      ...(input.context.parentSpanId ? { parentSpanId: input.context.parentSpanId } : {}),
      flags: Number.parseInt(input.context.traceFlags, 16) & 0xff,
      name: input.name.slice(0, 256),
      kind: input.kind,
      startTimeUnixNano: input.startTimeUnixNano.toString(),
      endTimeUnixNano: input.endTimeUnixNano.toString(),
      attributes: this.attributes(input.attributes),
      status: { code: input.statusCode ?? 0 },
    });

    if (this.queue.length >= config.maxBatchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    const config = this.configuration;
    if (!config || this.queue.length === 0) {
      return;
    }
    if (this.flushInFlight) {
      await this.flushInFlight;
      return;
    }

    const pendingAtStart = this.queue.length;
    const operation = this.flushPending(config, pendingAtStart).finally(() => {
      this.flushInFlight = undefined;
    });
    this.flushInFlight = operation;
    await operation;
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.flushInFlight) {
      await this.flushInFlight;
    }
    while (this.queue.length > 0) {
      await this.flush();
    }
  }

  private async flushPending(config: OtlpExporterConfiguration, pending: number): Promise<void> {
    let remaining = pending;
    while (remaining > 0) {
      const batchSize = Math.min(config.maxBatchSize, remaining);
      const batch = this.queue.splice(0, batchSize);
      remaining -= batch.length;
      if (batch.length === 0) {
        return;
      }

      try {
        await this.exportBatch(config, batch);
      } catch {
        this.logger.warn(`OpenTelemetry trace export failed; dropped ${batch.length} spans`);
      }
    }
  }

  private async exportBatch(config: OtlpExporterConfiguration, batch: QueuedSpan[]): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    timeout.unref();

    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          ...config.headers,
          "content-type": "application/json",
        },
        body: JSON.stringify(this.payload(config, batch)),
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        throw new Error(`OTLP collector returned HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private payload(config: OtlpExporterConfiguration, spans: QueuedSpan[]) {
    const resourceAttributes = [
      this.stringAttribute("service.name", config.serviceName),
      this.stringAttribute("service.version", APP_VERSION),
    ];
    const environment = process.env.NODE_ENV?.trim();
    if (environment) {
      resourceAttributes.push(this.stringAttribute("deployment.environment.name", environment.slice(0, 128)));
    }

    return {
      resourceSpans: [
        {
          resource: { attributes: resourceAttributes },
          scopeSpans: [
            {
              scope: {
                name: "apiWhatsApp.observability",
                version: APP_VERSION,
              },
              spans,
            },
          ],
        },
      ],
    };
  }

  private readConfiguration(): OtlpExporterConfiguration | undefined {
    const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
    const genericEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    if (!tracesEndpoint && !genericEndpoint) {
      return undefined;
    }

    const protocol = (
      process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ??
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL ??
      OTLP_HTTP_JSON_PROTOCOL
    ).trim().toLowerCase();
    if (protocol !== OTLP_HTTP_JSON_PROTOCOL) {
      throw new Error("Only OTLP HTTP/JSON trace export is supported");
    }

    const endpoint = tracesEndpoint
      ? this.parseEndpoint(tracesEndpoint)
      : this.traceEndpointFromGeneric(this.parseEndpoint(genericEndpoint!));
    const timeoutMs = this.readInteger(
      process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? process.env.OTEL_EXPORTER_OTLP_TIMEOUT,
      DEFAULT_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS,
    );
    const maxQueueSize = this.readInteger(
      process.env.OTEL_BSP_MAX_QUEUE_SIZE,
      DEFAULT_QUEUE_SIZE,
      1,
      MAX_QUEUE_SIZE,
    );
    const maxBatchSize = this.readInteger(
      process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
      1,
      maxQueueSize,
    );
    const scheduleDelayMs = this.readInteger(
      process.env.OTEL_BSP_SCHEDULE_DELAY,
      DEFAULT_SCHEDULE_DELAY_MS,
      100,
      MAX_SCHEDULE_DELAY_MS,
    );
    const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || "apiWhatsApp";

    return {
      endpoint,
      headers: this.readHeaders(),
      timeoutMs,
      maxQueueSize,
      maxBatchSize,
      scheduleDelayMs,
      serviceName: serviceName.slice(0, 128),
    };
  }

  private parseEndpoint(raw: string): URL {
    let endpoint: URL;
    try {
      endpoint = new URL(raw);
    } catch {
      throw new Error("OTLP trace endpoint must be an absolute URL");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("OTLP trace endpoint must use HTTP or HTTPS");
    }
    if (endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error("OTLP trace endpoint cannot contain credentials or a fragment");
    }
    return endpoint;
  }

  private traceEndpointFromGeneric(endpoint: URL): URL {
    const result = new URL(endpoint.toString());
    result.pathname = `${result.pathname.replace(/\/+$/, "")}/v1/traces`;
    return result;
  }

  private readHeaders(): Record<string, string> {
    const headers = {
      ...this.parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
      ...this.parseHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    };
    for (const name of ["content-type", "content-length", "host", "connection", "transfer-encoding"]) {
      delete headers[name];
    }
    return headers;
  }

  private parseHeaders(raw: string | undefined): Record<string, string> {
    if (!raw?.trim()) {
      return {};
    }

    const result: Record<string, string> = {};
    for (const entry of raw.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        throw new Error("Invalid OTLP exporter header configuration");
      }
      const name = entry.slice(0, separator).trim().toLowerCase();
      const encodedValue = entry.slice(separator + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
        throw new Error("Invalid OTLP exporter header name");
      }
      let value: string;
      try {
        value = decodeURIComponent(encodedValue);
      } catch {
        throw new Error("Invalid OTLP exporter header value");
      }
      if (/\r|\n/.test(value)) {
        throw new Error("Invalid OTLP exporter header value");
      }
      result[name] = value;
    }
    return result;
  }

  private readInteger(
    raw: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    if (raw === undefined || raw.trim() === "") {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`OpenTelemetry integer setting must be between ${minimum} and ${maximum}`);
    }
    return value;
  }

  private isSampled(traceFlags: string): boolean {
    return (Number.parseInt(traceFlags, 16) & 0x01) === 0x01;
  }

  private attributes(values?: Record<string, OtlpAttributeValue>): QueuedSpan["attributes"] {
    if (!values) {
      return [];
    }
    const attributes: QueuedSpan["attributes"] = [];
    for (const [key, value] of Object.entries(values).slice(0, MAX_ATTRIBUTES)) {
      if (!key || key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
        continue;
      }
      if (typeof value === "string") {
        attributes.push(this.stringAttribute(key, value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH)));
      } else if (typeof value === "boolean") {
        attributes.push({ key, value: { boolValue: value } });
      } else if (Number.isFinite(value)) {
        attributes.push(
          Number.isInteger(value)
            ? { key, value: { intValue: String(value) } }
            : { key, value: { doubleValue: value } },
        );
      }
    }
    return attributes;
  }

  private stringAttribute(key: string, value: string): QueuedSpan["attributes"][number] {
    return { key, value: { stringValue: value } };
  }
}
