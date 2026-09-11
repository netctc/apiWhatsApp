import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import { minimalJpeg } from "../helpers/media-fixtures.js";

const API_KEY_HASH_SECRET = "media-admission-integration-api-key-secret-0123456789";

function requireInfrastructure(): void {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for integration tests`);
    }
  }
}

function readRawBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine Meta mock port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("media storage admission integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let metaServer: Server;
  let storageRoot: string;
  let tenantId: string;
  let senderId: string;
  let apiKey: string;
  let providerCalls = 0;

  beforeAll(async () => {
    requireInfrastructure();
    storageRoot = await mkdtemp(join(tmpdir(), "api-whatsapp-media-admission-"));

    metaServer = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || !req.url?.endsWith("/media")) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        await readRawBody(req);
        providerCalls += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: `media.admission.${providerCalls}` }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_MEDIA_UPLOAD_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "media-admission-meta-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "media-admission-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "media-admission-access-token";
    process.env.MEDIA_MALWARE_SCAN_MODE = "disabled";
    process.env.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    process.env.MEDIA_FILESYSTEM_STORAGE_PATH = storageRoot;
    process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    process.env.MEDIA_FILESYSTEM_MIN_FREE_PERCENT = "0";
    process.env.MEDIA_ASSET_TTL_DAYS = "7";
    process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS = "3600000";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.media-admission.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "1000";
    process.env.WEBHOOK_PROCESSOR_INTERVAL_MS = "1000";
    process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS = "1000";

    const { AppModule } = await import("../../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: { name: `Media Admission Tenant ${suffix}`, slug: `media-admission-${suffix}` },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "media-admission",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MEDIA_WRITE, ApiScope.MEDIA_READ],
      },
    });

    const providerPhoneNumberId = String(Date.now());
    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId,
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        active: true,
        isDefault: true,
      },
    });
    senderId = sender.id;
  });

  afterAll(async () => {
    delete process.env.MEDIA_BINARY_STORAGE_MODE;
    delete process.env.MEDIA_FILESYSTEM_STORAGE_PATH;
    delete process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES;
    delete process.env.MEDIA_FILESYSTEM_MIN_FREE_PERCENT;
    delete process.env.MEDIA_ASSET_TTL_DAYS;
    delete process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS;

    if (prisma && tenantId) {
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await app?.close();
    if (metaServer) {
      await closeServer(metaServer);
    }
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("rejects a prospective retained file before registry/provider access when it would cross the reserve", async () => {
    const jpeg = minimalJpeg();

    await request(app.getHttpServer())
      .post("/api/v1/media")
      .set("X-API-Key", apiKey)
      .field("senderId", senderId)
      .attach("file", jpeg, { filename: "blocked.jpg", contentType: "image/jpeg" })
      .expect(503);

    expect(providerCalls).toBe(0);
    await expect(prisma.mediaAsset.count({ where: { tenantId } })).resolves.toBe(0);

    process.env.MEDIA_FILESYSTEM_MIN_FREE_BYTES = "0";

    const accepted = await request(app.getHttpServer())
      .post("/api/v1/media")
      .set("X-API-Key", apiKey)
      .field("senderId", senderId)
      .attach("file", jpeg, { filename: "accepted.jpg", contentType: "image/jpeg" })
      .expect(201);

    expect(accepted.body).toEqual(
      expect.objectContaining({
        mediaId: "media.admission.1",
        senderId,
        category: "IMAGE",
      }),
    );
    expect(providerCalls).toBe(1);
    await expect(prisma.mediaAsset.count({ where: { tenantId } })).resolves.toBe(1);
  });
});
