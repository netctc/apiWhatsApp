import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaS3StorageService } from "../src/media/media-s3-storage.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const ASSET_ID = "123e4567-e89b-42d3-a456-426614174001";
const KEY = `${TENANT_ID}/${ASSET_ID}`;
const ENV_KEYS = [
  "NODE_ENV",
  "MEDIA_S3_ENDPOINT",
  "MEDIA_S3_BUCKET",
  "MEDIA_S3_REGION",
  "MEDIA_S3_ACCESS_KEY_ID",
  "MEDIA_S3_SECRET_ACCESS_KEY",
  "MEDIA_S3_SESSION_TOKEN",
  "MEDIA_S3_TIMEOUT_MS",
] as const;

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine S3 mock port"));
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

describe("MediaS3StorageService", () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("streams a signed payload to the configured path-style bucket and deletes it", async () => {
    const calls: CapturedRequest[] = [];
    const server = createServer(async (request, response) => {
      const body = await readBody(request);
      calls.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.method === "PUT") {
        response.statusCode = 200;
      } else if (request.method === "DELETE") {
        response.statusCode = 204;
      } else {
        response.statusCode = 404;
      }
      response.end();
    });
    const port = await listen(server);
    const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-s3-test-"));
    const filePath = join(directory, "upload");
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(150_000, 0x41)]);
    await writeFile(filePath, bytes);

    process.env.NODE_ENV = "test";
    process.env.MEDIA_S3_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.MEDIA_S3_BUCKET = "media-bucket";
    process.env.MEDIA_S3_REGION = "eu-west-1";
    process.env.MEDIA_S3_ACCESS_KEY_ID = "test-access";
    process.env.MEDIA_S3_SECRET_ACCESS_KEY = "test-secret";
    process.env.MEDIA_S3_SESSION_TOKEN = "test-session";
    process.env.MEDIA_S3_TIMEOUT_MS = "3000";

    try {
      const service = new MediaS3StorageService();
      await expect(service.putObject(KEY, filePath)).resolves.toBeInstanceOf(Date);
      await expect(service.deleteObject(KEY)).resolves.toBeUndefined();

      expect(calls).toHaveLength(2);
      const put = calls[0];
      expect(put.method).toBe("PUT");
      expect(put.url).toBe(`/media-bucket/${TENANT_ID}/${ASSET_ID}`);
      expect(put.body).toEqual(bytes);
      expect(put.headers["content-length"]).toBe(String(bytes.length));
      expect(put.headers["x-amz-content-sha256"]).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(put.headers["x-amz-security-token"]).toBe("test-session");
      expect(put.headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/eu-west-1\/s3\/aws4_request,/,
      );
      expect(put.headers.authorization).toContain(
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
      );

      expect(calls[1]).toMatchObject({
        method: "DELETE",
        url: `/media-bucket/${TENANT_ID}/${ASSET_ID}`,
      });
    } finally {
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses a signed HEAD request for bucket readiness without exposing configuration", async () => {
    const calls: CapturedRequest[] = [];
    const server = createServer(async (request, response) => {
      calls.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await readBody(request),
      });
      response.statusCode = 200;
      response.end();
    });
    const port = await listen(server);

    process.env.NODE_ENV = "test";
    process.env.MEDIA_S3_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.MEDIA_S3_BUCKET = "media-bucket";
    process.env.MEDIA_S3_ACCESS_KEY_ID = "test-access";
    process.env.MEDIA_S3_SECRET_ACCESS_KEY = "test-secret";

    try {
      const result = await new MediaS3StorageService().diagnostics();
      expect(result).toEqual({ status: "up", mode: "s3" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "HEAD", url: "/media-bucket" });
      expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    } finally {
      await closeServer(server);
    }
  });

  it("treats object deletion 404 as idempotent success", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const port = await listen(server);
    process.env.NODE_ENV = "test";
    process.env.MEDIA_S3_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.MEDIA_S3_BUCKET = "media-bucket";
    process.env.MEDIA_S3_ACCESS_KEY_ID = "test-access";
    process.env.MEDIA_S3_SECRET_ACCESS_KEY = "test-secret";

    try {
      await expect(new MediaS3StorageService().deleteObject(KEY)).resolves.toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it("fails configuration closed and rejects plaintext endpoints outside test mode", async () => {
    process.env.NODE_ENV = "production";
    process.env.MEDIA_S3_ENDPOINT = "http://storage.example.com";
    process.env.MEDIA_S3_BUCKET = "media-bucket";
    process.env.MEDIA_S3_ACCESS_KEY_ID = "test-access";
    process.env.MEDIA_S3_SECRET_ACCESS_KEY = "test-secret";

    const service = new MediaS3StorageService();
    expect(() => service.assertConfigured()).toThrow("MEDIA_S3_ENDPOINT must use HTTPS outside test mode");
    await expect(service.diagnostics()).resolves.toEqual({
      status: "down",
      mode: "s3",
      error: "not_configured",
    });
  });
});
