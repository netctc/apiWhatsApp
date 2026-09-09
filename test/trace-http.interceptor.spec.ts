import { jest } from "@jest/globals";
import { defer, lastValueFrom, of } from "rxjs";
import { TraceContextService } from "../src/observability/trace-context.service.js";
import { TraceHttpInterceptor } from "../src/observability/trace-http.interceptor.js";

describe("TraceHttpInterceptor", () => {
  const trace = new TraceContextService();
  const interceptor = new TraceHttpInterceptor(trace);

  it("continues the incoming trace while the Nest handler executes", async () => {
    const setHeader = jest.fn();
    const context = {
      getType: () => "http",
      switchToHttp: () => ({
        getRequest: () => ({
          method: "POST",
          headers: {
            traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "x-request-id": "req-123",
          },
        }),
        getResponse: () => ({ setHeader }),
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
  });
});
