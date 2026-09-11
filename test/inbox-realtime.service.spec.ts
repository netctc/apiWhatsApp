import { ConfigService } from "@nestjs/config";
import { InboxRealtimeService } from "../src/inbox-events/inbox-realtime.service.js";

function serviceWith(values: Record<string, string>): InboxRealtimeService {
  const config = {
    get(name: string) {
      return values[name];
    },
  } as ConfigService;
  return new InboxRealtimeService(config);
}

describe("InboxRealtimeService", () => {
  it("bounds concurrent SSE connections", () => {
    const service = serviceWith({ REDIS_URL: "redis://127.0.0.1:6379", INBOX_SSE_MAX_CONNECTIONS: "2" });
    expect(service.tryAcquireConnection()).toBe(true);
    expect(service.tryAcquireConnection()).toBe(true);
    expect(service.tryAcquireConnection()).toBe(false);
    service.releaseConnection();
    expect(service.tryAcquireConnection()).toBe(true);
  });

  it("uses safe defaults for invalid operational bounds", () => {
    const service = serviceWith({
      REDIS_URL: "redis://127.0.0.1:6379",
      INBOX_SSE_MAX_CONNECTIONS: "0",
      INBOX_SSE_HEARTBEAT_MS: "1",
    });
    expect(service.heartbeatMs()).toBe(15_000);
    expect(service.tryAcquireConnection()).toBe(true);
  });

  it("accepts a bounded heartbeat override", () => {
    const service = serviceWith({
      REDIS_URL: "redis://127.0.0.1:6379",
      INBOX_SSE_HEARTBEAT_MS: "20000",
    });
    expect(service.heartbeatMs()).toBe(20_000);
  });

  it("requires the existing Redis dependency configuration", () => {
    expect(() => serviceWith({})).toThrow("REDIS_URL is required");
  });
});
