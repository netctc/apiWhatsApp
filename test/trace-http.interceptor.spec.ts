import { jest } from "@jest/globals";
import { defer, lastValueFrom, of } from "rxjs";
import { TraceContextService } from "../src/observability/trace-context.service.js";
import { TraceHttpInterceptor } from "../src/observability/trace-http.interceptor.js";

describe("TraceHttpInterceptor", () => {
  const trace = new TraceContextService();
  const recordSpan = jest.fn();
  const interceptor = new TraceHttpInterceptor(trace, { recordSpan } as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("continues the incoming trace and exports the same server span context", async () => {
    const setHeader = jest.fn();
    const context = {
      getType: () => "http",
      getClass: () => ({ name: "MessagesController" }),
      getHandler: () => ({ name: "create" }),
      switchToHttp: () => ({
        getRequest: () => ({
          method: "POST",
          headers: {
            traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "x-request-id": "req-123",
          },
        }),
        getResponse: () => ({ setHeader, statusCode: 202 }),
      }),
    } as never;

    let observedTraceId: string | undefined;
    let observedRequestId: string | undefined;
    const next = {
      handle: () =>
        defer(() => {
          observedTraceId = trace.current()?.traceId;
          observedRequestId = trace.current()?.requestId;
          return of("ok");
        }),
    } as never;

    await expect(lastValueFrom(interceptor.intercept(context, next))).resolves.toBe("ok");

    expect(observedTraceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(observedRequestId).toBe("req-123");
    expect(setHeader).toHaveBeenCalledWith("x-request-id", "req-123");
    expect(setHeader).toHaveBeenCalledWith(
      "traceparent",
      expect.stringMatching(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/),
    );
    expect(recordSpan).toHaveBeenCalledTimes(1);
    expect(recordSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          parentSpanId: "00f067aa0ba902b7",
          requestId: "req-123",
        }),
        name: "HTTP POST MessagesController.create",
        kind: 2,
        attributes: {
          "http.request.method": "POST",
          "http.response.status_code": 202,
          "code.namespace": "MessagesController",
          "code.function": "create",
        },
        statusCode: 0,
      }),
    );
  });
});
