import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer, type IncomingMessage, type Server } from "node:http";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { MediaAssetRetentionService } from "../../src/media/media-asset-retention.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const API_KEY_HASH_SECRET = "media-registry-integration-api-key-secret-0123456789";
const TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

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

async function createKey(
  prisma: PrismaService,
  tenantId: string,
  name: string,
  scopes: ApiScope[],
): Promise<string> {
  const generated = generateApiKey();
  await prisma.apiKey.create({
    data: {
      tenantId,
      name,
      prefix: generated.prefix,
      keyHash: hashApiKey(generated.rawKey, API_KEY_HASH_SECRET),
      scopes,
    },
  });
  return generated.rawKey;
}

describe("media asset registry integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let retention: MediaAssetRetentionService;
  let metaServer: Server;
  let tenantId: string;
  let otherTenantId: string;
  let senderId: string;
  let readWriteKey: string;
  let writeOnlyKey: string;
  let otherTenantReadKey: string;
  let providerCalls = 0;

  beforeAll(async () => {
    requireInfrastructure();

    metaServer = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || !req.url?.endsWith("/media")) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }

        await readRawBody(req);
        providerCalls += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: `media.registry.integration.${providerCalls}` }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_MEDIA_UPLOAD_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "media-registry-integration-meta-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "media-registry-integration-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "media-registry-integration-access-token";
    process.env.MEDIA_MALWARE_SCAN_MODE = "disabled";
    process.env.MEDIA_ASSET_TTL_DAYS = String(TTL_DAYS);
    process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS = "3600000";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.media-registry.${process.pid}.${Date.now()}`;
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
    prisma = app.get(PrismaService);
    retention = app.get(MediaAssetRetentionService);

    const suffix = `${process.pid}-${Date.now()}`;
    const [tenant, otherTenant] = await Promise.all([
      prisma.tenant.create({
        data: {
          name: `Media Registry Tenant ${suffix}`,
          slug: `media-registry-${suffix}`,
        },
      }),
      prisma.tenant.create({
        data: {
          name: `Media Registry Other Tenant ${suffix}`,
          slug: `media-registry-other-${suffix}`,
        },
      }),
    ]);
    tenantId = tenant.id;
    otherTenantId = otherTenant.id;

    [readWriteKey, writeOnlyKey, otherTenantReadKey] = await Promise.all([
      createKey(prisma, tenantId, "media-read-write", [ApiScope.MEDIA_READ, ApiScope.MEDIA_WRITE]),
      createKey(prisma, tenantId, "media-write-only", [ApiScope.MEDIA_WRITE]),
      createKey(prisma, otherTenantId, "media-read-other", [ApiScope.MEDIA_READ]),
    ]);

    const providerPhoneNumberId = String(Date.now());
    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId,
        wabaId: `${providerPhoneNumberId}1`,
        displayPhoneNumber: "+961 70 333 222",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 100,
        active: true,
        isDefault: true,
      },
    });
    senderId = sender.id;
  });

  afterAll(async () => {
    delete process.env.MEDIA_ASSET_TTL_DAYS;
    delete process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS;
    process.env.MEDIA_MALWARE_SCAN_MODE = "disabled";

    if (prisma) {
      if (tenantId) {
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
      if (otherTenantId) {
        await prisma.tenant.deleteMany({ where: { id: otherTenantId } });
      }
    }

    await app?.close();
    if (metaServer) {
      await closeServer(metaServer);
    }
  });

  it("persists successful upload metadata and exposes it only through media:read", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x42, 0xff, 0xd9]);

    const upload = await request(app.getHttpServer())
      .post("/api/v1/media")
      .set("X-API-Key", readWriteKey)
      .field("senderId", senderId)
      .attach("file", jpeg, {
        filename: "registry.jpg",
        contentType: "image/jpeg",
      })
      .expect(201);

    expect(upload.body).toEqual({
      mediaId: "media.registry.integration.1",
      senderId,
      category: "IMAGE",
      mimeType: "image/jpeg",
      size: jpeg.length,
    });
    expect(providerCalls).toBe(1);

    const persisted = await prisma.mediaAsset.findFirstOrThrow({
      where: {
        tenantId,
        providerMediaId: upload.body.mediaId,
      },
    });
    expect(persisted.tenantId).toBe(tenantId);
    expect(persisted.senderId).toBe(senderId);
    expect(persisted.category).toBe("IMAGE");
    expect(persisted.mimeType).toBe("image/jpeg");
    expect(persisted.size).toBe(jpeg.length);
    expect(persisted.scanMode).toBe("DISABLED");
    expect(persisted.scanStatus).toBe("NOT_SCANNED");
    expect(persisted.failureCode).toBeNull();
    expect(persisted.failedAt).toBeNull();
    expect(persisted.providerUploadedAt).not.toBeNull();
    expect(persisted.expiresAt).not.toBeNull();
    const ttlFromCreation = persisted.expiresAt!.getTime() - persisted.createdAt.getTime();
    expect(ttlFromCreation).toBeGreaterThan(TTL_DAYS * DAY_MS - 5000);
    expect(ttlFromCreation).toBeLessThanOrEqual(TTL_DAYS * DAY_MS);

    const list = await request(app.getHttpServer())
      .get("/api/v1/media")
      .set("X-API-Key", readWriteKey)
      .expect(200);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: persisted.id,
          mediaId: upload.body.mediaId,
          senderId,
          state: "ACTIVE",
          scanMode: "DISABLED",
          scanStatus: "NOT_SCANNED",
        }),
      ]),
    );

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/media/${persisted.id}`)
      .set("X-API-Key", readWriteKey)
      .expect(200);
    expect(detail.body).toEqual(
      expect.objectContaining({
        assetId: persisted.id,
        mediaId: upload.body.mediaId,
        state: "ACTIVE",
      }),
    );

    await request(app.getHttpServer())
      .get(`/api/v1/media/${persisted.id}`)
      .set("X-API-Key", otherTenantReadKey)
      .expect(404);

    await request(app.getHttpServer())
      .get("/api/v1/media")
      .set("X-API-Key", writeOnlyKey)
      .expect(403);
  });

  it("derives EXPIRED from local TTL and purges expired registry metadata", async () => {
    const providerUploadedAt = new Date(Date.now() - 2 * DAY_MS);
    const expiresAt = new Date(Date.now() - DAY_MS);
    const expired = await prisma.mediaAsset.create({
      data: {
        tenantId,
        senderId,
        providerMediaId: `media.registry.expired.${Date.now()}`,
        category: "IMAGE",
        mimeType: "image/jpeg",
        size: 12,
        scanMode: "CLAMAV",
        scanStatus: "CLEAN",
        providerUploadedAt,
        expiresAt,
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/media/${expired.id}`)
      .set("X-API-Key", readWriteKey)
      .expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        assetId: expired.id,
        mediaId: expired.providerMediaId,
        state: "EXPIRED",
        scanMode: "CLAMAV",
        scanStatus: "CLEAN",
      }),
    );

    await expect(retention.purgeExpired()).resolves.toBeGreaterThanOrEqual(1);
    await request(app.getHttpServer())
      .get(`/api/v1/media/${expired.id}`)
      .set("X-API-Key", readWriteKey)
      .expect(404);
  });
});
