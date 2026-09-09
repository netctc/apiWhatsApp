import { TraceContextService } from "../src/observability/trace-context.service.js";

describe("TraceContextService", () => {
  const service = new TraceContextService();

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
});
