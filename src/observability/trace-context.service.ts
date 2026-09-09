import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_PATTERN = /^[0-9a-f]{2}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

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

@Injectable()
export class TraceContextService {
  private readonly storage = new AsyncLocalStorage<TraceContext>();

  current(): TraceContext | undefined {
    return this.storage.getStore();
  }

  run<T>(context: TraceContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  createIncoming(traceparent?: string, requestId?: string): TraceContext {
    const parsed = this.parseTraceparent(traceparent);
    return {
      requestId: this.safeRequestId(requestId),
      traceId: parsed?.traceId ?? this.randomTraceId(),
      spanId: this.randomSpanId(),
      ...(parsed ? { parentSpanId: parsed.parentSpanId } : {}),
      traceFlags: parsed?.traceFlags ?? "01",
    };
  }

  runFromParent<T>(carrier: TraceCarrier | undefined, callback: () => T): T {
    const traceId = carrier?.traceId && this.validTraceId(carrier.traceId)
      ? carrier.traceId
      : this.randomTraceId();
    const parentSpanId = carrier?.parentSpanId && this.validSpanId(carrier.parentSpanId)
      ? carrier.parentSpanId
      : undefined;
    const traceFlags = carrier?.traceFlags && TRACE_FLAGS_PATTERN.test(carrier.traceFlags)
      ? carrier.traceFlags
      : "01";

    return this.run(
      {
        requestId: this.safeRequestId(carrier?.requestId),
        traceId,
        spanId: this.randomSpanId(),
        ...(parentSpanId ? { parentSpanId } : {}),
        traceFlags,
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
