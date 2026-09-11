import { randomUUID } from "node:crypto";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import type {
  InboxEventData,
  InboxEventType,
  InboxRealtimeEnvelope,
  InboxRealtimeEvent,
} from "./inbox-event.types.js";

const CHANNEL = "api-whatsapp:inbox-events:v1";
const DEFAULT_MAX_CONNECTIONS = 500;

@Injectable()
export class InboxRealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(InboxRealtimeService.name);
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Map<string, Set<(event: InboxRealtimeEvent) => void>>();
  private subscribed = false;
  private activeConnections = 0;

  constructor(private readonly config: ConfigService) {
    const redisUrl = this.config.get<string>("REDIS_URL");
    if (!redisUrl) throw new Error("REDIS_URL is required");
    const options = { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false } as const;
    this.publisher = new Redis(redisUrl, options);
    this.subscriber = new Redis(redisUrl, options);
    this.subscriber.on("message", (channel, payload) => {
      if (channel !== CHANNEL) return;
      this.dispatch(payload);
    });
    this.publisher.on("error", () => this.logger.warn("Realtime inbox Redis publisher error"));
    this.subscriber.on("error", () => this.logger.warn("Realtime inbox Redis subscriber error"));
  }

  async publish(tenantId: string, type: InboxEventType, data: InboxEventData): Promise<void> {
    const event: InboxRealtimeEvent = {
      id: randomUUID(),
      type,
      occurredAt: new Date().toISOString(),
      data: { ...data },
    };
    const envelope: InboxRealtimeEnvelope = { tenantId, event };
    try {
      await this.ensurePublisher();
      await this.publisher.publish(CHANNEL, JSON.stringify(envelope));
    } catch {
      // Realtime delivery is an invalidation hint; committed REST/PostgreSQL state remains authoritative.
      this.logger.warn(`Unable to publish realtime inbox event type=${type}`);
    }
  }

  async subscribe(tenantId: string, listener: (event: InboxRealtimeEvent) => void): Promise<() => void> {
    await this.ensureSubscriber();
    let tenantListeners = this.listeners.get(tenantId);
    if (!tenantListeners) {
      tenantListeners = new Set();
      this.listeners.set(tenantId, tenantListeners);
    }
    tenantListeners.add(listener);
    return () => {
      tenantListeners?.delete(listener);
      if (tenantListeners?.size === 0) this.listeners.delete(tenantId);
    };
  }

  tryAcquireConnection(): boolean {
    if (this.activeConnections >= this.maxConnections()) return false;
    this.activeConnections += 1;
    return true;
  }

  releaseConnection(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
  }

  heartbeatMs(): number {
    return this.boundedInteger("INBOX_SSE_HEARTBEAT_MS", 15_000, 5_000, 60_000);
  }

  async onModuleDestroy(): Promise<void> {
    this.listeners.clear();
    await Promise.all([this.close(this.publisher), this.close(this.subscriber)]);
  }

  private dispatch(payload: string): void {
    try {
      const parsed = JSON.parse(payload) as Partial<InboxRealtimeEnvelope>;
      if (!parsed || typeof parsed.tenantId !== "string" || !parsed.event || typeof parsed.event !== "object") return;
      const listeners = this.listeners.get(parsed.tenantId);
      if (!listeners) return;
      for (const listener of listeners) listener(parsed.event as InboxRealtimeEvent);
    } catch {
      this.logger.warn("Ignored malformed realtime inbox event");
    }
  }

  private maxConnections(): number {
    return this.boundedInteger("INBOX_SSE_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS, 1, 100_000);
  }

  private boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
    const candidate = Number(this.config.get(name) ?? fallback);
    return Number.isInteger(candidate) && candidate >= minimum && candidate <= maximum ? candidate : fallback;
  }

  private async ensurePublisher(): Promise<void> {
    if (this.publisher.status === "wait") await this.publisher.connect();
    if (this.publisher.status === "end") throw new Error("Realtime inbox publisher is closed");
  }

  private async ensureSubscriber(): Promise<void> {
    if (this.subscriber.status === "wait") await this.subscriber.connect();
    if (this.subscriber.status === "end") throw new Error("Realtime inbox subscriber is closed");
    if (!this.subscribed) {
      await this.subscriber.subscribe(CHANNEL);
      this.subscribed = true;
    }
  }

  private async close(client: Redis): Promise<void> {
    if (client.status === "end") return;
    await client.quit().catch(() => client.disconnect());
  }
}
