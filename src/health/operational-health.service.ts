import { Injectable, OnModuleDestroy } from "@nestjs/common";
import amqp, { type ChannelModel } from "amqplib";
import { Redis } from "ioredis";
import { Prisma } from "../generated/prisma/client.js";
import {
  MediaBinaryStorageService,
  type MediaBinaryStorageDiagnostics,
} from "../media/media-binary-storage.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

export type DependencyHealthStatus = "up" | "down";
export type DependencyHealthError = "not_configured" | "timeout" | "unavailable";

export interface DependencyHealthCheck {
  status: DependencyHealthStatus;
  durationMs: number;
  error?: DependencyHealthError;
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  dependencies: {
    postgres: DependencyHealthCheck;
    redis: DependencyHealthCheck;
    rabbitmq: DependencyHealthCheck;
    mediaStorage: MediaBinaryStorageDiagnostics;
  };
  timestamp: string;
}

class DependencyTimeoutError extends Error {}
class DependencyNotConfiguredError extends Error {}

@Injectable()
export class OperationalHealthService implements OnModuleDestroy {
  private readonly redis?: Redis;
  private rabbitConnection?: ChannelModel;
  private rabbitConnectionPromise?: Promise<ChannelModel>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaStorage: MediaBinaryStorageService,
  ) {
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: this.timeoutMs(),
      });
    }
  }

  live() {
    return {
      status: "ok" as const,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  async ready(): Promise<ReadinessReport> {
    const timeoutMs = this.timeoutMs();
    const [postgres, redis, rabbitmq, mediaStorage] = await Promise.all([
      this.checkDependency(() => this.checkPostgres(), timeoutMs),
      this.checkDependency(() => this.checkRedis(), timeoutMs),
      this.checkDependency(() => this.checkRabbitMq(), timeoutMs),
      this.mediaStorage.diagnostics(),
    ]);

    const ready =
      postgres.status === "up" &&
      redis.status === "up" &&
      rabbitmq.status === "up" &&
      mediaStorage.status === "up";

    return {
      status: ready ? "ready" : "not_ready",
      dependencies: { postgres, redis, rabbitmq, mediaStorage },
      timestamp: new Date().toISOString(),
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis && this.redis.status !== "end") {
      await this.redis.quit().catch(() => this.redis?.disconnect());
    }
    await this.rabbitConnection?.close().catch(() => undefined);
    this.rabbitConnection = undefined;
  }

  private async checkPostgres(): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ ok: number }>>(Prisma.sql`
      SELECT 1::int AS "ok"
    `);
    if (rows[0]?.ok !== 1) {
      throw new Error("Unexpected PostgreSQL readiness response");
    }
  }

  private async checkRedis(): Promise<void> {
    if (!this.redis) {
      throw new DependencyNotConfiguredError("REDIS_URL is not configured");
    }

    if (this.redis.status === "end") {
      throw new Error("Redis health connection is closed");
    }
    if (this.redis.status === "wait") {
      await this.redis.connect();
    } else if (this.redis.status !== "ready") {
      await this.waitForRedisReady();
    }

    const response = await this.redis.ping();
    if (response !== "PONG") {
      throw new Error("Unexpected Redis readiness response");
    }
  }

  private async checkRabbitMq(): Promise<void> {
    const connection = await this.getRabbitConnection();
    const channel = await connection.createChannel();
    await channel.close();
  }

  private async getRabbitConnection(): Promise<ChannelModel> {
    if (this.rabbitConnection) {
      return this.rabbitConnection;
    }
    if (this.rabbitConnectionPromise) {
      return this.rabbitConnectionPromise;
    }

    const rabbitMqUrl = process.env.RABBITMQ_URL;
    if (!rabbitMqUrl) {
      throw new DependencyNotConfiguredError("RABBITMQ_URL is not configured");
    }

    this.rabbitConnectionPromise = amqp
      .connect(rabbitMqUrl, { timeout: this.timeoutMs() })
      .then((connection) => {
        this.rabbitConnection = connection;
        connection.on("close", () => {
          this.rabbitConnection = undefined;
        });
        return connection;
      })
      .finally(() => {
        this.rabbitConnectionPromise = undefined;
      });

    return this.rabbitConnectionPromise;
  }

  private waitForRedisReady(): Promise<void> {
    const redis = this.redis;
    if (!redis) {
      throw new DependencyNotConfiguredError("REDIS_URL is not configured");
    }

    return new Promise<void>((resolve, reject) => {
      const onReady = () => finish(resolve);
      const onError = () => finish(() => reject(new Error("Redis connection error")));
      const onEnd = () => finish(() => reject(new Error("Redis connection ended")));
      const timer = setTimeout(
        () => finish(() => reject(new DependencyTimeoutError("Redis readiness timeout"))),
        this.timeoutMs(),
      );

      const cleanup = () => {
        clearTimeout(timer);
        redis.off("ready", onReady);
        redis.off("error", onError);
        redis.off("end", onEnd);
      };
      const finish = (callback: () => void) => {
        cleanup();
        callback();
      };

      redis.once("ready", onReady);
      redis.once("error", onError);
      redis.once("end", onEnd);
    });
  }

  private async checkDependency(
    operation: () => Promise<void>,
    timeoutMs: number,
  ): Promise<DependencyHealthCheck> {
    const startedAt = Date.now();
    try {
      await this.withTimeout(operation(), timeoutMs);
      return { status: "up", durationMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: "down",
        durationMs: Date.now() - startedAt,
        error:
          error instanceof DependencyNotConfiguredError
            ? "not_configured"
            : error instanceof DependencyTimeoutError
              ? "timeout"
              : "unavailable",
      };
    }
  }

  private withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DependencyTimeoutError("Dependency readiness timeout")),
        timeoutMs,
      );
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private timeoutMs(): number {
    const value = Number(process.env.HEALTH_DEPENDENCY_TIMEOUT_MS ?? 1500);
    return Number.isInteger(value) && value >= 250 && value <= 10000 ? value : 1500;
  }
}
