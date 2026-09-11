import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jest } from "@jest/globals";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { MediaBinaryStorageService } from "../../src/media/media-binary-storage.service.js";
import { MediaMalwareScannerService } from "../../src/media/media-malware-scanner.service.js";
import { MediaService } from "../../src/media/media.service.js";
import { MetaSenderResolverService } from "../../src/meta/meta-sender-resolver.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import { invalidOggOpusFixtures, validOggOpus } from "../helpers/ogg-opus-fixtures.js";

const KEY_SECRET = "opus-integration-key-secret-01234567890123456789";
const ACCESS_TOKEN = "opus-integration-provider-token";
const SCANNER_MARKER = "EICAR_TEST_MARKER";

async function listen(server: ReturnType<typeof createTcpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function startScanner() {
  const payloads: Buffer[] = [];
  const sockets = new Set<Socket>();
  const command = Buffer.from("zINSTREAM\0", "ascii");
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(5000, () => socket.destroy());
    let pending = Buffer.alloc(0);
    let commandRead = false;
    let finished = false;
    let total = 0;
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      if (finished) return;
      pending = Buffer.concat([pending, chunk]);
      if (!commandRead) {
        if (pending.length < command.length) return;
        if (!pending.subarray(0, command.length).equals(command)) {
          finished = true;
          socket.end("stream: invalid command ERROR\0");
          return;
        }
        pending = pending.subarray(command.length);
        commandRead = true;
      }
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(0);
        if (size === 0) {
          finished = true;
          const bytes = Buffer.concat(chunks);
          payloads.push(bytes);
          socket.end(bytes.includes(Buffer.from(SCANNER_MARKER))
            ? "stream: Test-Marker FOUND\0" : "stream: OK\0");
          return;
        }
        // All test fixtures are below 70 KiB. Bound the controlled scanner seam.
        if (total + size > 128 * 1024) {
          finished = true;
          socket.end("stream: fixture too large ERROR\0");
          return;
        }
        if (pending.length < 4 + size) return;
        chunks.push(Buffer.from(pending.subarray(4, 4 + size)));
        total += size;
        pending = pending.subarray(4 + size);
      }
    });
  });
  const port = await listen(server);
  return {
    port, payloads,
    async close() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

describe("Ogg Opus multipart admission integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let scanner: Awaited<ReturnType<typeof startScanner>>;
  let meta: Server;
  let storageRoot: string;
  let tenantId: string;
  let senderId: string;
  let apiKey: string;
  const originalEnv = new Map<string, string | undefined>();
  const providerUploads: Buffer[] = [];
  let providerRequests = 0;

  function configure(values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
  }

  beforeAll(async () => {
    for (const key of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[key]) throw new Error(`${key} is required for integration tests`);
    }
    storageRoot = await mkdtemp(join(tmpdir(), "api-whatsapp-opus-storage-"));
    scanner = await startScanner();
    meta = createServer(async (req, res) => {
      providerRequests += 1;
      try {
        assert.equal(req.method, "POST");
        assert.ok(req.url?.endsWith("/media"));
        assert.equal(req.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk as Uint8Array);
          total += bytes.length;
          assert.ok(total <= 128 * 1024, "Unexpectedly large provider fixture");
          chunks.push(bytes);
        }
        const form = await new Response(new Uint8Array(Buffer.concat(chunks)), {
          headers: { "content-type": req.headers["content-type"] ?? "" },
        }).formData();
        const file = form.get("file");
        assert.ok(file && typeof file !== "string");
        const bytes = Buffer.from(await file.arrayBuffer());
        assert.equal(file.type, "audio/ogg");
        assert.equal(form.get("messaging_product"), "whatsapp");
        assert.deepEqual(scanner.payloads.at(-1), bytes, "Scan must precede provider upload");
        const asset = await prisma.mediaAsset.findFirstOrThrow({
          where: { tenantId, senderId, providerMediaId: null, failedAt: null },
        });
        assert.equal(asset.scanMode, "CLAMAV");
        assert.equal(asset.scanStatus, "CLEAN");
        assert.equal(asset.storageMode, "FILESYSTEM");
        assert.ok(asset.storedAt);
        assert.equal(asset.storageKey, `${tenantId}/${asset.id}`);
        assert.deepEqual(await readFile(join(storageRoot, asset.storageKey!)), bytes,
          "Retained bytes and registry must exist before provider upload");
        providerUploads.push(bytes);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: `media.opus.integration.${providerUploads.length}` }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const port = await listen(meta);
    configure({
      NODE_ENV: "test",
      API_KEY_HASH_SECRET: KEY_SECRET,
      META_GRAPH_API_VERSION: "v99.0",
      META_GRAPH_API_BASE_URL: `http://127.0.0.1:${port}`,
      META_HTTP_TIMEOUT_MS: "3000",
      META_MEDIA_UPLOAD_TIMEOUT_MS: "3000",
      META_APP_SECRET: "opus-integration-app-secret",
      META_WEBHOOK_VERIFY_TOKEN: "opus-integration-verify-token",
      TEST_OPUS_META_TOKEN: ACCESS_TOKEN,
      MEDIA_MALWARE_SCAN_MODE: "clamav",
      MEDIA_CLAMAV_HOST: "127.0.0.1",
      MEDIA_CLAMAV_PORT: String(scanner.port),
      MEDIA_CLAMAV_TIMEOUT_MS: "3000",
      MEDIA_BINARY_STORAGE_MODE: "filesystem",
      MEDIA_FILESYSTEM_STORAGE_PATH: storageRoot,
      MEDIA_FILESYSTEM_MIN_FREE_BYTES: "0",
      MEDIA_FILESYSTEM_MIN_FREE_PERCENT: "0",
      MEDIA_ASSET_TTL_DAYS: "7",
      MEDIA_ASSET_CLEANUP_INTERVAL_MS: "3600000",
      OUTBOUND_QUEUE_NAME: `whatsapp.opus.${randomUUID()}`,
      OUTBOX_POLL_INTERVAL_MS: "1000",
      WEBHOOK_PROCESSOR_INTERVAL_MS: "1000",
      CAMPAIGN_PROCESSOR_INTERVAL_MS: "1000",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
    });
    const { AppModule } = await import("../../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
    const tenant = await prisma.tenant.create({
      data: { name: "Opus Integration", slug: `opus-${randomUUID()}` },
    });
    tenantId = tenant.id;
    const generated = generateApiKey();
    apiKey = generated.rawKey;
    await prisma.apiKey.create({ data: {
      tenantId, name: "opus-integration", prefix: generated.prefix,
      keyHash: hashApiKey(apiKey, KEY_SECRET), scopes: [ApiScope.MEDIA_WRITE, ApiScope.MEDIA_READ],
    } });
    const providerPhoneNumberId = `${Date.now()}${process.pid}`;
    const sender = await prisma.whatsAppPhoneNumber.create({ data: {
      tenantId, providerPhoneNumberId, wabaId: `${providerPhoneNumberId}1`,
      displayPhoneNumber: "+961 70 111 222", credentialRef: "env:TEST_OPUS_META_TOKEN",
      rateLimitPerSecond: 100, active: true, isDefault: true,
    } });
    senderId = sender.id;
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (run: () => Promise<unknown>) => {
      try { await run(); } catch (error) { failures.push(error); }
    };
    if (prisma && tenantId) await cleanup(() => prisma.tenant.deleteMany({ where: { id: tenantId } }));
    if (app) await cleanup(() => app.close());
    if (scanner) await cleanup(() => scanner.close());
    if (meta) await cleanup(async () => {
      meta.closeAllConnections();
      if (meta.listening) await new Promise<void>((resolve, reject) => {
        meta.close((error) => error ? reject(error) : resolve());
      });
    });
    if (storageRoot) await cleanup(() => rm(storageRoot, { recursive: true, force: true }));
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (failures.length) throw new AggregateError(failures, "Opus integration cleanup failed");
  });

  function upload(bytes: Buffer) {
    return request(app.getHttpServer()).post("/api/v1/media")
      .set("X-API-Key", apiKey).field("senderId", senderId)
      .attach("file", bytes, { filename: "client-audio.ogg", contentType: "audio/ogg" });
  }

  function observe() {
    const storage = app.get(MediaBinaryStorageService);
    return {
      upload: jest.spyOn(app.get(MediaService), "upload"),
      target: jest.spyOn(storage, "targetFor"),
      capacity: jest.spyOn(storage, "assertCapacityFor"),
      stage: jest.spyOn(storage, "stage"),
      scan: jest.spyOn(app.get(MediaMalwareScannerService), "scan"),
      resolve: jest.spyOn(app.get(MetaSenderResolverService), "resolveForTenant"),
      reserve: jest.spyOn(prisma.mediaAsset, "create"),
    };
  }

  async function expectTemporaryRemoved(observed: ReturnType<typeof observe>) {
    expect(observed.upload).toHaveBeenCalledTimes(1);
    const path = observed.upload.mock.calls[0]?.[2]?.path;
    expect(typeof path).toBe("string");
    await expect(stat(path!)).rejects.toMatchObject({ code: "ENOENT" });
  }

  it.each([
    { name: "mono audio", bytes: validOggOpus() },
    { name: "continued tags at the 64 KiB boundary", bytes: validOggOpus({ tagBytes: 65_536 }) },
  ])("scans, retains and uploads $name without changing bytes", async ({ bytes }) => {
    const observed = observe();
    const calls = providerRequests;
    const scans = scanner.payloads.length;
    const response = await upload(bytes).expect(201);
    expect(response.body).toEqual({
      mediaId: `media.opus.integration.${providerUploads.length}`,
      senderId, category: "AUDIO", mimeType: "audio/ogg", size: bytes.length,
    });
    expect(providerRequests).toBe(calls + 1);
    expect(providerUploads.at(-1)).toEqual(bytes);
    expect(scanner.payloads).toHaveLength(scans + 1);
    expect(scanner.payloads.at(-1)).toEqual(bytes);
    expect(observed.reserve).toHaveBeenCalledTimes(1);
    expect(observed.stage).toHaveBeenCalledTimes(1);
    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { tenantId, providerMediaId: response.body.mediaId },
    });
    expect(asset.providerUploadedAt).not.toBeNull();
    expect(asset.failedAt).toBeNull();
    const detail = await request(app.getHttpServer()).get(`/api/v1/media/${asset.id}`)
      .set("X-API-Key", apiKey).expect(200);
    expect(detail.body).toEqual(expect.objectContaining({
      state: "ACTIVE", category: "AUDIO", scanMode: "CLAMAV", scanStatus: "CLEAN", binaryRetained: true,
    }));
    expect(detail.body).not.toHaveProperty("storageKey");
    await expectTemporaryRemoved(observed);
  });

  it.each(invalidOggOpusFixtures())("rejects $name before downstream effects", async ({ bytes }) => {
    const observed = observe();
    const calls = providerRequests;
    const scans = scanner.payloads.length;
    const rows = await prisma.mediaAsset.count({ where: { tenantId } });
    const files = (await readdir(storageRoot, { recursive: true })).sort();
    const response = await upload(bytes).expect(400);
    expect(response.body.message).toBe("Media file content does not match declared MIME type: audio/ogg");
    for (const spy of [observed.target, observed.capacity, observed.scan, observed.resolve, observed.reserve, observed.stage]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(providerRequests).toBe(calls);
    expect(scanner.payloads).toHaveLength(scans);
    expect(await prisma.mediaAsset.count({ where: { tenantId } })).toBe(rows);
    expect((await readdir(storageRoot, { recursive: true })).sort()).toEqual(files);
    await expectTemporaryRemoved(observed);
  });

  it("still rejects scanner-detected content inside structurally valid Opus tags", async () => {
    const observed = observe();
    const bytes = validOggOpus({ vendor: SCANNER_MARKER });
    const calls = providerRequests;
    const scans = scanner.payloads.length;
    const rows = await prisma.mediaAsset.count({ where: { tenantId } });
    const response = await upload(bytes).expect(422);
    expect(response.body.message).toBe("Media file was rejected by security scanning");
    expect(scanner.payloads).toHaveLength(scans + 1);
    expect(scanner.payloads.at(-1)).toEqual(bytes);
    expect(observed.resolve).not.toHaveBeenCalled();
    expect(observed.reserve).not.toHaveBeenCalled();
    expect(observed.stage).not.toHaveBeenCalled();
    expect(providerRequests).toBe(calls);
    expect(await prisma.mediaAsset.count({ where: { tenantId } })).toBe(rows);
    await expectTemporaryRemoved(observed);
  });

  it("fails closed for valid Opus when the required scanner is unavailable", async () => {
    await scanner.close();
    const observed = observe();
    const calls = providerRequests;
    const response = await upload(validOggOpus()).expect(503);
    expect(response.body.message).toBe("Media security scanning is unavailable");
    expect(observed.scan).toHaveBeenCalledTimes(1);
    expect(observed.resolve).not.toHaveBeenCalled();
    expect(observed.reserve).not.toHaveBeenCalled();
    expect(observed.stage).not.toHaveBeenCalled();
    expect(providerRequests).toBe(calls);
    await expectTemporaryRemoved(observed);
  });

  it("keeps malformed-file rejection independent of scanner availability", async () => {
    await scanner.close();
    const observed = observe();
    const calls = providerRequests;
    await upload(invalidOggOpusFixtures()[0]!.bytes).expect(400);
    expect(observed.scan).not.toHaveBeenCalled();
    expect(observed.target).not.toHaveBeenCalled();
    expect(observed.resolve).not.toHaveBeenCalled();
    expect(observed.reserve).not.toHaveBeenCalled();
    expect(observed.stage).not.toHaveBeenCalled();
    expect(providerRequests).toBe(calls);
    await expectTemporaryRemoved(observed);
  });
});
