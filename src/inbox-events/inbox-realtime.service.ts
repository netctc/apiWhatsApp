import { randomUUID } from "node:crypto";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import {
  INBOX_EVENT_TYPES,
  type InboxEventData,
  type InboxEventType,
  type InboxRealtimeEnvelope,
  type InboxRealtimeEvent,
} from "./inbox-event.types.js";

const CHANNEL = "api-whatsapp:inbox-events:v1";
const DEFAULT_MAX_CONNECTIONS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_STATUSES = new Set(["OPEN", "PENDING", "RESOLVED"]);
const CONVERSATION_PRIORITIES = new Set(["LOW", "NORMAL", "HIGH", "URGENT"]);

@Injectable()
export class InboxRealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(InboxRealtimeService.name);
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Map<string, Set<(event: InboxRealtimeEvent) => void>>();
  private readonly connectionClosers = new Set<() => void>();
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
      data: this.safeData(data),
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

  registerConnectionCloser(closer: () => void): () => void {
    this.connectionClosers.add(closer);
    return () => this.connectionClosers.delete(closer);
  }

  releaseConnection(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
  }

  heartbeatMs(): number {
    return this.boundedInteger("INBOX_SSE_HEARTBEAT_MS", 15_000, 5_000, 60_000);
  }

  async onModuleDestroy(): Promise<void> {
    for (const closeConnection of [...this.connectionClosers]) closeConnection();
    this.connectionClosers.clear();
    this.listeners.clear();
    await Promise.all([this.close(this.publisher), this.close(this.subscriber)]);
  }

  private dispatch(payload: string): void {
    try {
      const parsed = JSON.parse(payload) as unknown;
      const envelope = this.safeEnvelope(parsed);
      if (!envelope) return;
      const listeners = this.listeners.get(envelope.tenantId);
      if (!listeners) return;
      for (const listener of listeners) listener(envelope.event);
    } catch {
      this.logger.warn("Ignored malformed realtime inbox event");
    }
  }

  private safeEnvelope(value: unknown): InboxRealtimeEnvelope | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    const tenantId = this.uuid(candidate.tenantId);
    const rawEvent = candidate.event;
    if (!tenantId || !rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) return undefined;
    const event = rawEvent as Record<string, unknown>;
    const id = this.uuid(event.id);
    const type = typeof event.type === "string" && INBOX_EVENT_TYPES.includes(event.type as InboxEventType)
      ? event.type as InboxEventType
      : undefined;
    const occurredAt = typeof event.occurredAt === "string" && !Number.isNaN(Date.parse(event.occurredAt))
      ? event.occurredAt
      : undefined;
    if (!id || !type || !occurredAt) return undefined;
    return {
      tenantId,
      event: { id, type, occurredAt, data: this.safeData(event.data) },
    };
  }

  private safeData(value: unknown): InboxEventData {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const data = value as Record<string, unknown>;
    const conversationId = this.uuid(data.conversationId);
    const messageId = this.uuid(data.messageId);
    const noteId = this.uuid(data.noteId);
    const cannedResponseId = this.uuid(data.cannedResponseId);
    const assignedAgentId = data.assignedAgentId === null ? null : this.uuid(data.assignedAgentId);
    const assignedTeamId = data.assignedTeamId === null ? null : this.uuid(data.assignedTeamId);
    const status = typeof data.status === "string" && CONVERSATION_STATUSES.has(data.status) ? data.status : undefined;
    const priority = typeof data.priority === "string" && CONVERSATION_PRIORITIES.has(data.priority) ? data.priority : undefined;
    const unreadCount = Number.isInteger(data.unreadCount) && (data.unreadCount as number) >= 0
      ? data.unreadCount as number
      : undefined;
    const revision = Number.isInteger(data.revision) && (data.revision as number) >= 1
      ? data.revision as number
      : undefined;
    return {
      ...(conversationId ? { conversationId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(noteId ? { noteId } : {}),
      ...(cannedResponseId ? { cannedResponseId } : {}),
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(data.assignedAgentId === null || assignedAgentId ? { assignedAgentId } : {}),
      ...(data.assignedTeamId === null || assignedTeamId ? { assignedTeamId } : {}),
      ...(unreadCount === undefined ? {} : { unreadCount }),
      ...(revision === undefined ? {} : { revision }),
      ...(typeof data.active === "boolean" ? { active: data.active } : {}),
    };
  }

  private uuid(value: unknown): string | undefined {
    return typeof value === "string" && UUID.test(value) ? value : undefined;
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
