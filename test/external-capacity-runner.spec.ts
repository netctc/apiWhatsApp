import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";

interface RunnerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ExternalCapacityReport {
  accepted: number;
  errors: number;
  duplicateAcceptedIds: number;
  latencyMs: { p95: number; p99: number };
  gates: Record<string, boolean>;
  passed: boolean;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine mock server port"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function runRunner(env: NodeJS.ProcessEnv): Promise<RunnerResult> {
  const child = spawn(process.execPath, [resolve("scripts/external-capacity-runner.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  return { code, stdout, stderr };
}

describe("external capacity runner", () => {
  it("measures acceptance and drain against an isolated external target", async () => {
    let total = 0;
    let submitted = 0;
    let postRequests = 0;
    const apiKey = "external-capacity-test-key";
    const recipient = "+96170876543";

    const server = createServer(async (request, response) => {
      if (request.headers["x-api-key"] !== apiKey) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      if (request.method === "GET" && request.url === "/api/v1/operations/snapshot") {
        sendJson(response, 200, {
          messages: {
            total,
            byStatus: {
              CREATED: 0,
              RECEIVED: 0,
              QUEUED: 0,
              PROCESSING: 0,
              SUBMITTED: submitted,
              SENT: 0,
              DELIVERED: 0,
              READ: 0,
              FAILED: 0,
              CANCELLED: 0,
              EXPIRED: 0,
            },
          },
          outbox: {
            pending: 0,
            due: 0,
            leased: 0,
            withErrors: 0,
            oldestPendingAgeSeconds: null,
          },
        });
        return;
      }

      if (request.method === "POST" && request.url === "/api/v1/messages") {
        const body = JSON.parse(await readBody(request)) as {
          to?: string;
          type?: string;
        };
        expect(body.to).toBe(recipient);
        expect(body.type).toBe("TEXT");
        expect(request.headers["idempotency-key"]).toBeDefined();
        postRequests += 1;
        total += 1;
        submitted += 1;
        sendJson(response, 202, { messageId: `message-${postRequests}`, status: "QUEUED" });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    });

    const port = await listen(server);
    try {
      const result = await runRunner({
        EXTERNAL_CAPACITY_CONFIRM_ISOLATED_TEST_ENV: "true",
        EXTERNAL_CAPACITY_BASE_URL: `http://127.0.0.1:${port}`,
        EXTERNAL_CAPACITY_API_KEY: apiKey,
        EXTERNAL_CAPACITY_RECIPIENTS: recipient,
        EXTERNAL_CAPACITY_MESSAGES: "8",
        EXTERNAL_CAPACITY_CONCURRENCY: "4",
        EXTERNAL_CAPACITY_ACCEPT_P95_MS: "1000",
        EXTERNAL_CAPACITY_ACCEPT_P99_MS: "1000",
        EXTERNAL_CAPACITY_DRAIN_MAX_MS: "3000",
        EXTERNAL_CAPACITY_SNAPSHOT_INTERVAL_MS: "250",
        EXTERNAL_CAPACITY_REQUEST_TIMEOUT_MS: "1000",
      });

      expect(result.code).toBe(0);
      expect(postRequests).toBe(8);
      expect(result.stdout).not.toContain(apiKey);
      expect(result.stdout).not.toContain(recipient);
      expect(result.stderr).not.toContain(apiKey);

      const marker = "[external-capacity] ";
      const reportLine = result.stdout.split("\n").find((line) => line.startsWith(marker));
      expect(reportLine).toBeDefined();
      const report = JSON.parse(reportLine!.slice(marker.length)) as ExternalCapacityReport;
      expect(report).toMatchObject({
        accepted: 8,
        errors: 0,
        duplicateAcceptedIds: 0,
        passed: true,
      });
      expect(report.latencyMs.p95).toBeGreaterThan(0);
      expect(report.latencyMs.p99).toBeGreaterThan(0);
      expect(Object.values(report.gates).every(Boolean)).toBe(true);
    } finally {
      await closeServer(server);
    }
  }, 10_000);

  it("refuses to generate traffic without the isolated-test confirmation", async () => {
    const apiKey = "must-not-leak";
    const result = await runRunner({
      EXTERNAL_CAPACITY_CONFIRM_ISOLATED_TEST_ENV: "false",
      EXTERNAL_CAPACITY_BASE_URL: "http://127.0.0.1:1",
      EXTERNAL_CAPACITY_API_KEY: apiKey,
      EXTERNAL_CAPACITY_RECIPIENTS: "+96170876543",
      EXTERNAL_CAPACITY_MESSAGES: "1",
      EXTERNAL_CAPACITY_CONCURRENCY: "1",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("EXTERNAL_CAPACITY_CONFIRM_ISOLATED_TEST_ENV=true");
    expect(result.stderr).not.toContain(apiKey);
  });
});
