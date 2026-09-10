import { createServer, type Server } from "node:http";
import { MediaS3StorageService } from "../src/media/media-s3-storage.service.js";

const ENV_KEYS = [
  "NODE_ENV",
  "MEDIA_S3_ENDPOINT",
  "MEDIA_S3_BUCKET",
  "MEDIA_S3_REGION",
  "MEDIA_S3_ACCESS_KEY_ID",
  "MEDIA_S3_SECRET_ACCESS_KEY",
] as const;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine S3 readiness mock port"));
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

describe("MediaS3StorageService readiness failures", () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("maps a non-success bucket response to a bounded unavailable diagnostic", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 503;
      response.end("provider detail that must not escape");
    });
    const port = await listen(server);
    process.env.NODE_ENV = "test";
    process.env.MEDIA_S3_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.MEDIA_S3_BUCKET = "media-bucket";
    process.env.MEDIA_S3_REGION = "us-east-1";
    process.env.MEDIA_S3_ACCESS_KEY_ID = "test-access";
    process.env.MEDIA_S3_SECRET_ACCESS_KEY = "test-secret";

    try {
      await expect(new MediaS3StorageService().diagnostics()).resolves.toEqual({
        status: "down",
        mode: "s3",
        error: "unavailable",
      });
    } finally {
      await closeServer(server);
    }
  });
});
