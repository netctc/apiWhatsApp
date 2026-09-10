import { Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_PATTERN = /^[0-9a-f]{2}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACE_ID_RATIO_RANGE = 1n << 63n;
const TRACE_ID_RATIO_PRECISION = 1n << 53n;
const DEFAULT_SAMPLER: TraceSamplerName = "parentbased_always_on";

export interface TraceContext {
  requestId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: string;
}

export interface TraceCarrier {
  traceId: string;
  parentSpanId?: string;
  traceFlags?: string;
  requestId?: string;
}

type TraceSamplerName =
  | "always_on"
  | "always_off"
  | "traceidratio"
  | "parentbased_always_on"
  | "parentbased_always_off"
  | "parentbased_traceidratio";

interface TraceSamplerConfiguration {
  name: TraceSamplerName;
  ratioThreshold: bigint;
}

@Injectable()
export class TraceContextService {
  private readonly logger = new Logger(TraceContextService.name);
  private readonly storage = new AsyncLocalStorage<TraceContext>();
  private readonly sampler: TraceSamplerConfiguration;

  constructor() {
    this.sampler = this.readSampler();
  }

  current(): TraceContext | undefined {
    return this.storage.getStore();
  }

  run<T>(context: TraceContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  createIncoming(traceparent?: string, requestId?: string): TraceContext {
    const parsed = this.parseTraceparent(traceparent);
    const traceId = parsed?.traceId ?? this.randomTraceId();
    return {
      requestId: this.safeRequestId(requestId),
      traceId,
      spanId: this.randomSpanId(),
      ...(parsed ? { parentSpanId: parsed.parentSpanId } : {}),
      traceFlags: this.samplingFlags(traceId, parsed?.traceFlags, Boolean(parsed)),
    };
  }

  runFromParent<T>(carrier: TraceCarrier | undefined, callback: () => T): T {
    const traceId = carrier?.traceId && this.validTraceId(carrier.traceId)
      ? carrier.traceId
      : this.randomTraceId();
    const parentSpanId = carrier?.parentSpanId && this.validSpanId(carrier.parentSpanId)
      ? carrier.parentSpanId
      : undefined;
    const parentFlags = carrier?.traceFlags && TRACE_FLAGS_PATTERN.test(carrier.traceFlags)
      ? carrier.traceFlags
      : parentSpanId
        ? "01"
        : undefined;

    return this.run(
      {
        requestId: this.safeRequestId(carrier?.requestId),
        traceId,
        spanId: this.randomSpanId(),
        ...(parentSpanId ? { parentSpanId } : {}),
        traceFlags: this.samplingFlags(traceId, parentFlags, Boolean(parentSpanId)),
      },
      callback,
    );
  }

  carrier(): TraceCarrier | undefined {
    const current = this.current();
    if (!current) {
      return undefined;
    }
    return {
      traceId: current.traceId,
      parentSpanId: current.spanId,
      traceFlags: current.traceFlags,
      requestId: current.requestId,
    };
  }

  traceparent(context = this.current()): string | undefined {
    if (!context) {
      return undefined;
    }
    return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
  }

  parseCarrier(value: unknown): TraceCarrier | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    const candidate = value as {
      traceId?: unknown;
      parentSpanId?: unknown;
      traceFlags?: unknown;
      requestId?: unknown;
    };
    if (typeof candidate.traceId !== "string" || !this.validTraceId(candidate.traceId)) {
      return undefined;
    }

    return {
      traceId: candidate.traceId,
      ...(typeof candidate.parentSpanId === "string" && this.validSpanId(candidate.parentSpanId)
        ? { parentSpanId: candidate.parentSpanId }
        : {}),
      ...(typeof candidate.traceFlags === "string" && TRACE_FLAGS_PATTERN.test(candidate.traceFlags)
        ? { traceFlags: candidate.traceFlags }
        : {}),
      ...(typeof candidate.requestId === "string" && REQUEST_ID_PATTERN.test(candidate.requestId)
        ? { requestId: candidate.requestId }
        : {}),
    };
  }

  private parseTraceparent(value?: string):
    | { traceId: string; parentSpanId: string; traceFlags: string }
    | undefined {
    if (!value) {
      return undefined;
    }
    const match = TRACEPARENT_PATTERN.exec(value.trim().toLowerCase());
    if (!match) {
      return undefined;
    }
    const [, traceId, parentSpanId, traceFlags] = match;
    if (!this.validTraceId(traceId) || !this.validSpanId(parentSpanId)) {
      return undefined;
    }
    return { traceId, parentSpanId, traceFlags };
  }

  private readSampler(): TraceSamplerConfiguration {
    const rawName = (process.env.OTEL_TRACES_SAMPLER ?? DEFAULT_SAMPLER).trim().toLowerCase();
    const name = this.supportedSampler(rawName);
    if (!name) {
      this.logger.error(
        `Unsupported OTEL_TRACES_SAMPLER=${rawName}; using ${DEFAULT_SAMPLER}`,
      );
      return { name: DEFAULT_SAMPLER, ratioThreshold: TRACE_ID_RATIO_RANGE };
    }

    if (name !== "traceidratio" && name !== "parentbased_traceidratio") {
      return { name, ratioThreshold: TRACE_ID_RATIO_RANGE };
    }

    return {
      name,
      ratioThreshold: this.readRatioThreshold(process.env.OTEL_TRACES_SAMPLER_ARG),
    };
  }

  private supportedSampler(value: string): TraceSamplerName | undefined {
    switch (value) {
      case "always_on":
      case "always_off":
      case "traceidratio":
      case "parentbased_always_on":
      case "parentbased_always_off":
      case "parentbased_traceidratio":
        return value;
      default:
        return undefined;
    }
  }

  private readRatioThreshold(raw: string | undefined): bigint {
    if (raw === undefined || raw.trim() === "") {
      return TRACE_ID_RATIO_RANGE;
    }
    const ratio = Number(raw);
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      this.logger.error("Invalid OTEL_TRACES_SAMPLER_ARG; using trace ratio 1.0");
      return TRACE_ID_RATIO_RANGE;
    }
    if (ratio <= 0) {
      return 0n;
    }
    if (ratio >= 1) {
      return TRACE_ID_RATIO_RANGE;
    }

    const scaled = BigInt(Math.floor(ratio * Number(TRACE_ID_RATIO_PRECISION)));
    return scaled * (TRACE_ID_RATIO_RANGE / TRACE_ID_RATIO_PRECISION);
  }

  private samplingFlags(traceId: string, parentFlags: string | undefined, hasParent: boolean): string {
    const existingFlags = parentFlags && TRACE_FLAGS_PATTERN.test(parentFlags)
      ? Number.parseInt(parentFlags, 16)
      : 0;
    let sampled: boolean;

    switch (this.sampler.name) {
      case "always_on":
        sampled = true;
        break;
      case "always_off":
        sampled = false;
        break;
      case "traceidratio":
        sampled = this.sampleTraceId(traceId);
        break;
      case "parentbased_always_off":
        sampled = hasParent ? (existingFlags & 0x01) === 0x01 : false;
        break;
      case "parentbased_traceidratio":
        sampled = hasParent
          ? (existingFlags & 0x01) === 0x01
          : this.sampleTraceId(traceId);
        break;
      case "parentbased_always_on":
      default:
        sampled = hasParent ? (existingFlags & 0x01) === 0x01 : true;
        break;
    }

    const flags = (existingFlags & 0xfe) | (sampled ? 0x01 : 0x00);
    return flags.toString(16).padStart(2, "0");
  }

  private sampleTraceId(traceId: string): boolean {
    if (this.sampler.ratioThreshold <= 0n) {
      return false;
    }
    if (this.sampler.ratioThreshold >= TRACE_ID_RATIO_RANGE) {
      return true;
    }
    const low64 = BigInt(`0x${traceId.slice(16)}`);
    const positive63 = low64 >> 1n;
    return positive63 < this.sampler.ratioThreshold;
  }

  private safeRequestId(value?: string): string {
    return value && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
  }

  private validTraceId(value: string): boolean {
    return TRACE_ID_PATTERN.test(value) && value !== "00000000000000000000000000000000";
  }

  private validSpanId(value: string): boolean {
    return SPAN_ID_PATTERN.test(value) && value !== "0000000000000000";
  }

  private randomTraceId(): string {
    return randomBytes(16).toString("hex");
  }

  private randomSpanId(): string {
    return randomBytes(8).toString("hex");
  }
}
