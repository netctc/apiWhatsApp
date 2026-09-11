import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "realtime-auth-integration-secret-0123456789abcdef";
const ROUTE = "/api/v1/inbox/events";

describe("realtime inbox HTTP authorization integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let writeOnlyKey: string;
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required for integration tests`);
    }

    const env = {
      NODE_ENV: "test",
      API_KEY_HASH_SECRET: HASH_SECRET,
      OUTBOUND_QUEUE_NAME: `whatsapp.realtime-auth.${randomUUID()}`,
      OUTBOX_POLL_INTERVAL_MS: "60000",
      WEBHOOK_PROCESSOR_INTERVAL_MS: "60000",
      CAMPAIGN_PROCESSOR_INTERVAL_MS: "60000",
    };
    for (const [name, value] of Object.entries(env)) {
      originalEnv.set(name, process.env[name]);
      process.env[name] = value;
    }

    const { AppModule } = await import("../../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);

    const tenant = await prisma.tenant.create({
      data: { name: "Realtime auth tenant", slug: `realtime-auth-${randomUUID()}` },
    });
    tenantId = tenant.id;

    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "Realtime write-only key",
        prefix: generated.prefix,
        keyHash: hashApiKey(generated.rawKey, HASH_SECRET),
        scopes: [ApiScope.INBOX_WRITE, ApiScope.MEDIA_WRITE],
      },
    });
    writeOnlyKey = generated.rawKey;
  });

  afterAll(async () => {
    if (prisma && tenantId) {
      await prisma.apiKey.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    if (app) await app.close();
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("rejects unauthenticated stream requests before opening SSE", async () => {
    const response = await request(app.getHttpServer())
      .get(ROUTE)
      .set("Accept", "text/event-stream")
      .expect(401);

    expect(response.body.message).toBe("X-API-Key header is required");
  });

  it("rejects write and media scopes when inbox:read is absent", async () => {
    const response = await request(app.getHttpServer())
      .get(ROUTE)
      .set("Accept", "text/event-stream")
      .set("X-API-Key", writeOnlyKey)
      .expect(403);

    expect(response.body.message).toContain(ApiScope.INBOX_READ);
  });
});
