import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";

function requireInfrastructure(): void {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for integration tests`);
    }
  }
}

describe("media storage diagnostics integration", () => {
  let app: INestApplication;
  let storageRoot: string;

  beforeAll(async () => {
    requireInfrastructure();
    storageRoot = await mkdtemp(join(tmpdir(), "api-whatsapp-media-health-"));

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = "media-health-integration-api-key-secret-0123456789";
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_APP_SECRET = "media-health-integration-meta-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "media-health-integration-verify-token";
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = storageRoot;
    process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES = "0";
    process.env.MEDIA_FILESYSTEM_MIN_FREE_PERCENT = "0";
    process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS = "3600000";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.media-health.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "1000";
    process.env.WEBHOOK_PROCESSOR_INTERVAL_MS = "1000";
    process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS = "1000";

    const { AppModule } = await import("../../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, "127.0.0.1");
  });

  afterAll(async () => {
    delete process.env.MEDIA_BINARY_STORAGE_MODE;
    delete process.env.MEDIA_FILESYSTEM_STORAGE_PATH;
    delete process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES;
    delete process.env.MEDIA_FILESYSTEM_MIN_FREE_PERCENT;
    delete process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS;

    await app?.close();
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("reports configured filesystem capacity and removes readiness when the reserve is breached", async () => {
    const healthy = await request(app.getHttpServer()).get("/api/health/ready").expect(200);

    expect(healthy.body.status).toBe("ready");
    expect(healthy.body.dependencies.mediaStorage).toEqual(
      expect.objectContaining({
        status: "up",
        mode: "filesystem",
        totalBytes: expect.any(Number),
        freeBytes: expect.any(Number),
        freePercent: expect.any(Number),
        minimumFreeBytes: 0,
        minimumFreePercent: 0,
      }),
    );
    expect(healthy.body.dependencies.mediaStorage).not.toHaveProperty("path");

    process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);

    const lowCapacity = await request(app.getHttpServer()).get("/api/health/ready").expect(503);
    expect(lowCapacity.body.status).toBe("not_ready");
    expect(lowCapacity.body.dependencies.mediaStorage).toEqual(
      expect.objectContaining({
        status: "down",
        mode: "filesystem",
        error: "low_capacity",
        minimumFreeBytes: Number.MAX_SAFE_INTEGER,
      }),
    );
    expect(lowCapacity.body.dependencies.postgres.status).toBe("up");
    expect(lowCapacity.body.dependencies.redis.status).toBe("up");
    expect(lowCapacity.body.dependencies.rabbitmq.status).toBe("up");
  });
});
