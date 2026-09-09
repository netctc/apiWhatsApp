import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { MetricsTokenGuard } from "../src/observability/metrics-token.guard.js";

function context(authorization?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as never;
}

describe("MetricsTokenGuard", () => {
  const guard = new MetricsTokenGuard();
  const originalToken = process.env.METRICS_BEARER_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.METRICS_BEARER_TOKEN;
    } else {
      process.env.METRICS_BEARER_TOKEN = originalToken;
    }
  });

  it("fails closed when a strong monitoring token is not configured", () => {
    delete process.env.METRICS_BEARER_TOKEN;
    expect(() => guard.canActivate(context())).toThrow(ServiceUnavailableException);

    process.env.METRICS_BEARER_TOKEN = "too-short";
    expect(() => guard.canActivate(context())).toThrow(ServiceUnavailableException);
  });

  it("rejects missing or incorrect bearer credentials", () => {
    process.env.METRICS_BEARER_TOKEN = "a".repeat(48);

    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context(`Bearer ${"b".repeat(48)}`))).toThrow(
      UnauthorizedException,
    );
  });

  it("accepts the exact monitoring bearer token", () => {
    const token = "monitoring-token-with-at-least-32-bytes-1234";
    process.env.METRICS_BEARER_TOKEN = token;

    expect(guard.canActivate(context(`Bearer ${token}`))).toBe(true);
  });
});
