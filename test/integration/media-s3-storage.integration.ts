import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { MediaAssetRetentionService } from "../../src/media/media-asset-retention.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const API_KEY_HASH_SECRET = "media-s3-integration-api-key-secret-0123456789abcdef";
const BUCKET = "media-integration-bucket";

interface S3Call {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

function requireInfrastructure(): void {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for integration tests`);
    }
  }
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine integration mock port"));
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

describe("S3 retained media integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let retention: MediaAssetRetentionService;
  let metaServer: Server;
  let s3Server: Server;
  let tenantId: string;
  let senderId: string;
  let apiKey: string;
  let providerCalls = 0;
  const s3Calls: S3Call[] = [];
  const sequence: string[] = [];

  beforeAll(async () => {
    requireInfrastructure();

    s3Server = createServer(async (req, res) => {
      const body = await readRawBody(req);
      s3Calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === "HEAD" && req.url === `/${BUCKET}`) {
        sequence.push("s3-head");
        res.statusCode = 200;
      } else if (req.method === "PUT" && req.url?.startsWith(`/${BUCKET}/`)) {
        sequence.push("s3-put");
        res.statusCode = 200;
      } else if (req.method === "DELETE" && req.url?.startsWith(`/${BUCKET}/`)) {
        sequence.push("s3-delete");
        res.statusCode = 204;
      } else {
        res.statusCode = 404;
      }
      res.end();
    });
    const s3Port = await listen(s3Server);

    metaServer = createServer(async (req, res) => {
      if (req.method !== "POST" || !req.url?.endsWith("/media")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      await readRawBody(req);
      sequence.push("meta-upload");
      providerCalls += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `media.s3.integration.${providerCalls}` }));
    });
    const metaPort = await listen(metaServer);

    process.env.NODE_ENV = "test";
    process.env.API_KEY_HASH_SECRET = API_KEY_HASH_SECRET;
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_MEDIA_UPLOAD_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "media-s3-integration-meta-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "media-s3-integration-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "media-s3-integration-meta-access-token";
    process.env.MEDIA_MALWARE_SCAN_MODE = "disabled";
    process.env.MEDIA_BINARY_STORAGE_MODE = "s3";
    process.env.MEDIA_S3_ENDPOINT = `http://127.0.0.1:${s3Port}`;
    process.env.MEDIA_S3_BUCKET = BUCKET;
    process.env.MEDIA_S3_REGION = "us-east-1";
    process.env.MEDIA_S3_ACCESS_KEY_ID = "integration-access";
    process.env.MEDIA_S3_SECRET_ACCESS_KEY = "integration-secret";
    process.env.MEDIA_S3_TIMEOUT_MS = "3000";
    process.env.MEDIA_ASSET_TTL_DAYS = "7";
    process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS = "3600000";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.media-s3.${process.pid}.${Date.now()}`;
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
    const tenant = await prisma.tenant.create({
      data: {
        name: `Media S3 Tenant ${suffix}`,
        slug: `media-s3-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "media-s3-integration",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [ApiScope.MEDIA_READ, ApiScope.MEDIA_WRITE, ApiScope.OPERATIONS_READ],
      },
    });

    const providerPhoneNumberId = String(Date.now());
    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId,
        wabaId: `${providerPhoneNumberId}1`,
        displayPhoneNumber: "+961 70 444 333",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 100,
        active: true,
        isDefault: true,
      },
    });
    senderId = sender.id;
  });

  afterAll(async () => {
    if (prisma && tenantId) {
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await app?.close();
    if (metaServer) {
      await closeServer(metaServer);
    }
    if (s3Server) {
      await closeServer(s3Server);
    }

    delete process.env.MEDIA_BINARY_STORAGE_MODE;
    delete process.env.MEDIA_S3_ENDPOINT;
    delete process.env.MEDIA_S3_BUCKET;
    delete process.env.MEDIA_S3_REGION;
    delete process.env.MEDIA_S3_ACCESS_KEY_ID;
    delete process.env.MEDIA_S3_SECRET_ACCESS_KEY;
    delete process.env.MEDIA_S3_TIMEOUT_MS;
    delete process.env.MEDIA_ASSET_TTL_DAYS;
    delete process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS;
    process.env.MEDIA_MALWARE_SCAN_MODE = "disabled";
  });

  it("persists in S3 before Meta, reports readiness/inventory, and deletes expired objects first", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x42, 0x43, 0xff, 0xd9]);
    const initialPutCalls = s3Calls.filter((call) => call.method === "PUT").length;
    const initialProviderCalls = providerCalls;

    const ready = await request(app.getHttpServer()).get("/api/health/ready").expect(200);
    expect(ready.body.status).toBe("ready");
    expect(ready.body.dependencies.mediaStorage).toEqual({ status: "up", mode: "s3" });

    const upload = await request(app.getHttpServer())
      .post("/api/v1/media")
      .set("X-API-Key", apiKey)
      .field("senderId", senderId)
      .attach("file", jpeg, {
        filename: "client-name.jpg",
        contentType: "image/jpeg",
      })
      .expect(201);

    expect(providerCalls).toBe(initialProviderCalls + 1);
    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { tenantId, providerMediaId: upload.body.mediaId },
    });
    expect(asset.storageMode).toBe("S3");
    expect(asset.storageKey).toBe(`${tenantId}/${asset.id}`);
    expect(asset.storedAt).not.toBeNull();

    const puts = s3Calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(initialPutCalls + 1);
    const put = puts.at(-1)!;
    expect(put.url).toBe(`/${BUCKET}/${tenantId}/${asset.id}`);
    expect(put.body).toEqual(jpeg);
    expect(put.headers["content-length"]).toBe(String(jpeg.length));
    expect(put.headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update(jpeg).digest("hex"),
    );
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(sequence.indexOf("s3-put")).toBeLessThan(sequence.indexOf("meta-upload"));

    const lookup = await request(app.getHttpServer())
      .get(`/api/v1/media/${asset.id}`)
      .set("X-API-Key", apiKey)
      .expect(200);
    expect(lookup.body.storageMode).toBe("S3");
    expect(lookup.body.binaryRetained).toBe(true);
    expect(lookup.body).not.toHaveProperty("storageKey");
    expect(JSON.stringify(lookup.body)).not.toContain(BUCKET);
    expect(JSON.stringify(lookup.body)).not.toContain("integration-secret");

    const operations = await request(app.getHttpServer())
      .get("/api/v1/operations/snapshot")
      .set("X-API-Key", apiKey)
      .expect(200);
    expect(operations.body.mediaAssets).toEqual(
      expect.objectContaining({
        total: 1,
        providerUploaded: 1,
        failed: 0,
        retainedBinaries: 1,
        retainedBytes: jpeg.length,
      }),
    );

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(retention.purgeExpired(new Date())).resolves.toBe(1);

    const deleteCall = s3Calls.find(
      (call) => call.method === "DELETE" && call.url === `/${BUCKET}/${tenantId}/${asset.id}`,
    );
    expect(deleteCall).toBeDefined();
    await expect(prisma.mediaAsset.findUnique({ where: { id: asset.id } })).resolves.toBeNull();
    expect(sequence.indexOf("s3-delete")).toBeGreaterThan(sequence.indexOf("meta-upload"));
  });
});
