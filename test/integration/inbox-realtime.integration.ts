import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { InboxRealtimeService } from "../../src/inbox-events/inbox-realtime.service.js";
import type { InboxRealtimeEvent } from "../../src/inbox-events/inbox-event.types.js";

describe("realtime inbox Redis fan-out integration", () => {
  let publisher: InboxRealtimeService;
  let subscriber: InboxRealtimeService;

  beforeAll(() => {
    if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required for integration tests");
    const config = new ConfigService({ REDIS_URL: process.env.REDIS_URL });
    publisher = new InboxRealtimeService(config);
    subscriber = new InboxRealtimeService(config);
  });

  afterAll(async () => {
    await Promise.all([publisher.onModuleDestroy(), subscriber.onModuleDestroy()]);
  });

  it("fans out across service instances without crossing tenant boundaries", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const conversationId = randomUUID();
    const tenantBEvents: InboxRealtimeEvent[] = [];
    let resolveEvent: (event: InboxRealtimeEvent) => void = () => undefined;
    let rejectEvent: (error: Error) => void = () => undefined;
    const eventPromise = new Promise<InboxRealtimeEvent>((resolve, reject) => {
      resolveEvent = resolve;
      rejectEvent = reject;
    });
    const timeout = setTimeout(() => rejectEvent(new Error("Timed out waiting for realtime inbox event")), 3000);
    timeout.unref();

    const unsubscribeA = await subscriber.subscribe(tenantA, (event) => {
      clearTimeout(timeout);
      resolveEvent(event);
    });
    const unsubscribeB = await subscriber.subscribe(tenantB, (event) => tenantBEvents.push(event));

    try {
      await publisher.publish(tenantA, "conversation.updated", { conversationId, unreadCount: 4 });
      const event = await eventPromise;

      expect(event).toMatchObject({
        type: "conversation.updated",
        data: { conversationId, unreadCount: 4 },
      });
      expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
      expect(tenantBEvents).toEqual([]);
    } finally {
      clearTimeout(timeout);
      unsubscribeA();
      unsubscribeB();
    }
  });
});
