import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const API_KEY_HASH_SECRET = "mounted-secret-integration-api-key-secret-0123456789";

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

describe("mounted sender secret reference integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let metaServer: Server;
  let secretRoot: string;
  let secretPath: string;
  let tenantId: string;
  let apiKey: string;
  const authorizationHeaders: string[] = [];

  beforeAll(async () => {
    requireInfrastructure();
    secretRoot = await mkdtemp(join(tmpdir(), "api-whatsapp-mounted-secret-"));
    secretPath = join(secretRoot, "meta-access-token");
    await writeFile(secretPath, "mounted-token-v1\n", { mode: 0o600 });

    metaServer = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || !req.url?.endsWith("/media")) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }

        await readRawBody(req);
        authorizationHeaders.push(req.headers.authorization ?? "");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: `media.mounted-secret.${authorizationHeaders.length}` }));
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
    process.env.META_MEDIA_UPLOAD_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = "mounted-secret-meta-app-secret";
    process.env.META_WEBHOOK_VERIFY_TOKEN = "mounted-secret-verify-token";
    process.env.SECRET_FILE_ROOTS = secretRoot;
    process.env.MEDIA_MALWARE_SCAN_MODE = "disabled";
    process.env.MEDIA_BINARY_STORAGE_MODE = "disabled";
    process.env.MEDIA_ASSET_TTL_DAYS = "7";
    process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS = "3600000";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.mounted-secret.${process.pid}.${Date.now()}`;
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
      data: {
        name: `Mounted Secret Tenant ${suffix}`,
        slug: `mounted-secret-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "mounted-secret",
        prefix: generated.prefix,
        keyHash: hashApiKey(apiKey, API_KEY_HASH_SECRET),
        scopes: [
          ApiScope.PHONE_NUMBERS_READ,
          ApiScope.PHONE_NUMBERS_WRITE,
          ApiScope.MEDIA_READ,
          ApiScope.MEDIA_WRITE,
        ],
      },
    });
  });

  afterAll(async () => {
    try {
      if (prisma && tenantId) {
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
    } finally {
      await app?.close().catch(() => undefined);
      if (metaServer) {
        await closeServer(metaServer).catch(() => undefined);
      }
      if (secretRoot) {
        await rm(secretRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      delete process.env.SECRET_FILE_ROOTS;
      delete process.env.MEDIA_ASSET_TTL_DAYS;
      delete process.env.MEDIA_ASSET_CLEANUP_INTERVAL_MS;
    }
  });

  it("registers a file: sender and observes mounted secret rotation without restarting the API", async () => {
    const providerPhoneNumberId = String(Date.now());
    const sender = await request(app.getHttpServer())
      .post("/api/v1/phone-numbers")
      .set("X-API-Key", apiKey)
      .send({
        providerPhoneNumberId,
        credentialRef: `file:${secretPath}`,
        isDefault: true,
      })
      .expect(201);

    expect(sender.body).toEqual(
      expect.objectContaining({
        providerPhoneNumberId,
        credentialRef: `file:${secretPath}`,
        active: true,
        isDefault: true,
      }),
    );

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x42, 0xff, 0xd9]);
    const first = await request(app.getHttpServer())
      .post("/api/v1/media")
      .set("X-API-Key", apiKey)
      .attach("file", jpeg, { filename: "first.jpg", contentType: "image/jpeg" })
      .expect(201);

    expect(first.body.mediaId).toBe("media.mounted-secret.1");
    expect(authorizationHeaders).toEqual(["Bearer mounted-token-v1"]);

    const rotatedPath = join(secretRoot, "meta-access-token-next");
    await writeFile(rotatedPath, "mounted-token-v2\n", { mode: 0o600 });
    await rename(rotatedPath, secretPath);

    const second = await request(app.getHttpServer())
      .post("/api/v1/media")
      .set("X-API-Key", apiKey)
      .attach("file", jpeg, { filename: "second.jpg", contentType: "image/jpeg" })
      .expect(201);

    expect(second.body.mediaId).toBe("media.mounted-secret.2");
    expect(authorizationHeaders).toEqual([
      "Bearer mounted-token-v1",
      "Bearer mounted-token-v2",
    ]);
  });
});
