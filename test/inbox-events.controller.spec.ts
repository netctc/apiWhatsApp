import { jest } from "@jest/globals";
import { InboxEventsController } from "../src/inbox-events/inbox-events.controller.js";
import type { InboxRealtimeEvent } from "../src/inbox-events/inbox-event.types.js";

const principal = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "22222222-2222-4222-8222-222222222222",
  scopes: ["inbox:read"],
};

function setup(writeResults: boolean[] = []) {
  let listener: ((event: InboxRealtimeEvent) => void) | undefined;
  let shutdownCloser: (() => void) | undefined;
  let requestCloser: (() => void) | undefined;
  const unsubscribe = jest.fn();
  const unregisterCloser = jest.fn();
  const releaseConnection = jest.fn();
  const writes: string[] = [];
  let writeIndex = 0;
  const realtime = {
    tryAcquireConnection: jest.fn(() => true),
    registerConnectionCloser: jest.fn((closer: () => void) => {
      shutdownCloser = closer;
      return unregisterCloser;
    }),
    subscribe: jest.fn(async (_tenantId: string, next: (event: InboxRealtimeEvent) => void) => {
      listener = next;
      return unsubscribe;
    }),
    releaseConnection,
    heartbeatMs: jest.fn(() => 5000),
  };
  const response = {
    writableEnded: false,
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((frame: string) => {
      writes.push(frame);
      const result = writeResults[writeIndex] ?? true;
      writeIndex += 1;
      return result;
    }),
    end: jest.fn(function (this: { writableEnded: boolean }) {
      this.writableEnded = true;
    }),
  };
  const request = {
    once: jest.fn((_event: string, closer: () => void) => {
      requestCloser = closer;
    }),
  };
  return {
    controller: new InboxEventsController(realtime as never),
    realtime,
    response,
    request,
    writes,
    unsubscribe,
    unregisterCloser,
    releaseConnection,
    getListener: () => listener,
    getShutdownCloser: () => shutdownCloser,
    getRequestCloser: () => requestCloser,
  };
}

describe("InboxEventsController", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("emits bounded heartbeat comment frames", async () => {
    jest.useFakeTimers();
    const ctx = setup();
    await ctx.controller.stream(principal as never, ctx.request as never, ctx.response as never);

    expect(ctx.writes).toContain(": connected\n\n");
    jest.advanceTimersByTime(5000);
    expect(ctx.writes).toContain(": heartbeat\n\n");

    ctx.getRequestCloser()?.();
    expect(ctx.releaseConnection).toHaveBeenCalledTimes(1);
  });

  it("disconnects a slow client immediately instead of buffering", async () => {
    const ctx = setup([true, false]);
    await ctx.controller.stream(principal as never, ctx.request as never, ctx.response as never);

    ctx.getListener()?.({
      id: "33333333-3333-4333-8333-333333333333",
      type: "conversation.updated",
      occurredAt: "2026-09-12T00:00:00.000Z",
      data: { conversationId: "44444444-4444-4444-8444-444444444444", unreadCount: 2 },
    });

    expect(ctx.response.end).toHaveBeenCalledTimes(1);
    expect(ctx.unsubscribe).toHaveBeenCalledTimes(1);
    expect(ctx.unregisterCloser).toHaveBeenCalledTimes(1);
    expect(ctx.releaseConnection).toHaveBeenCalledTimes(1);
  });

  it("closes active streams when the application realtime service shuts down", async () => {
    const ctx = setup();
    await ctx.controller.stream(principal as never, ctx.request as never, ctx.response as never);

    ctx.getShutdownCloser()?.();

    expect(ctx.response.end).toHaveBeenCalledTimes(1);
    expect(ctx.unsubscribe).toHaveBeenCalledTimes(1);
    expect(ctx.releaseConnection).toHaveBeenCalledTimes(1);
  });
});
