import { TraceContextService } from "../src/observability/trace-context.service.js";

const SAMPLER_ENV_KEYS = ["OTEL_TRACES_SAMPLER", "OTEL_TRACES_SAMPLER_ARG"] as const;

describe("TraceContextService", () => {
  const originalEnv = new Map<string, string | undefined>();
  let service: TraceContextService;

  beforeAll(() => {
    for (const key of SAMPLER_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
  });

  beforeEach(() => {
    delete process.env.OTEL_TRACES_SAMPLER;
    delete process.env.OTEL_TRACES_SAMPLER_ARG;
    service = new TraceContextService();
  });

  afterAll(() => {
    for (const key of SAMPLER_ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("continues a valid W3C traceparent with a new server span", () => {
    const context = service.createIncoming(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "request-123",
    );

    expect(context.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(context.parentSpanId).toBe("00f067aa0ba902b7");
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(context.spanId).not.toBe(context.parentSpanId);
    expect(context.traceFlags).toBe("01");
    expect(context.requestId).toBe("request-123");
  });

  it("creates a safe root trace when incoming identifiers are invalid", () => {
    const context = service.createIncoming(
      "00-00000000000000000000000000000000-0000000000000000-01",
      "unsafe request id with spaces",
    );

    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.traceId).not.toBe("00000000000000000000000000000000");
    expect(context.parentSpanId).toBeUndefined();
    expect(context.traceFlags).toBe("01");
    expect(context.requestId).not.toBe("unsafe request id with spaces");
  });

  it("exports the current span as a parent carrier and restores it in asynchronous work", async () => {
    const incoming = service.createIncoming(undefined, "req-1");

    await service.run(incoming, async () => {
      await Promise.resolve();
      const carrier = service.carrier();
      expect(carrier).toEqual({
        traceId: incoming.traceId,
        parentSpanId: incoming.spanId,
        traceFlags: incoming.traceFlags,
        requestId: incoming.requestId,
      });

      service.runFromParent(carrier, () => {
        const worker = service.current();
        expect(worker?.traceId).toBe(incoming.traceId);
        expect(worker?.parentSpanId).toBe(incoming.spanId);
        expect(worker?.spanId).not.toBe(incoming.spanId);
        expect(worker?.traceFlags).toBe(incoming.traceFlags);
        expect(worker?.requestId).toBe(incoming.requestId);
      });
    });
  });

  it("ignores invalid optional carrier fields without rejecting a valid trace id", () => {
    expect(
      service.parseCarrier({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        parentSpanId: "bad",
        traceFlags: "bad",
        requestId: "bad value with spaces",
      }),
    ).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736" });
  });

  it("uses parentbased_always_on by default and preserves an upstream unsampled decision", () => {
    const context = service.createIncoming(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
    );
    expect(context.traceFlags).toBe("00");
    expect(service.createIncoming().traceFlags).toBe("01");
  });

  it("supports parentbased_traceidratio without overriding a valid parent decision", () => {
    process.env.OTEL_TRACES_SAMPLER = "parentbased_traceidratio";
    process.env.OTEL_TRACES_SAMPLER_ARG = "0";
    service = new TraceContextService();

    expect(service.createIncoming().traceFlags).toBe("00");
    expect(
      service.createIncoming(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      ).traceFlags,
    ).toBe("01");
    expect(
      service.createIncoming(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
      ).traceFlags,
    ).toBe("00");
  });

  it("supports non-parent always_off sampling by clearing only the sampled flag", () => {
    process.env.OTEL_TRACES_SAMPLER = "always_off";
    service = new TraceContextService();

    const context = service.createIncoming(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03",
    );
    expect(context.traceFlags).toBe("02");
  });

  it("uses a deterministic nested trace-id ratio decision", () => {
    process.env.OTEL_TRACES_SAMPLER = "traceidratio";
    process.env.OTEL_TRACES_SAMPLER_ARG = "0.5";
    service = new TraceContextService();

    const lowTrace = service.createIncoming(
      "00-11111111111111110000000000000001-00f067aa0ba902b7-00",
    );
    const highTrace = service.createIncoming(
      "00-1111111111111111ffffffffffffffff-00f067aa0ba902b7-01",
    );
    expect(lowTrace.traceFlags).toBe("01");
    expect(highTrace.traceFlags).toBe("00");
  });

  it("defaults an invalid ratio argument to 1.0 without blocking traces", () => {
    process.env.OTEL_TRACES_SAMPLER = "parentbased_traceidratio";
    process.env.OTEL_TRACES_SAMPLER_ARG = "not-a-ratio";
    service = new TraceContextService();

    expect(service.createIncoming().traceFlags).toBe("01");
  });
});
