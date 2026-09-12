import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";

interface RunnerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function readBody(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // Drain request body.
  }
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

function parseReport(stdout: string): {
  gates: Record<string, boolean>;
  achievedStartRateRatio: number | null;
  operations: { maxOldestPendingAgeSeconds: number };
  passed: boolean;
} {
  const marker = "[external-capacity] ";
  const reportLine = stdout.split("\n").find((line) => line.startsWith(marker));
  expect(reportLine).toBeDefined();
  return JSON.parse(reportLine!.slice(marker.length)) as {
    gates: Record<string, boolean>;
    achievedStartRateRatio: number | null;
    operations: { maxOldestPendingAgeSeconds: number };
    passed: boolean;
  };
}

function snapshot(total: number, submitted: number, pending = 0, oldestPendingAgeSeconds = 0) {
  return {
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
      pending,
      due: pending,
      leased: 0,
      withErrors: 0,
      oldestPendingAgeSeconds,
    },
  };
}

describe("external capacity duration gates", () => {
  it("fails the start-rate gate when the load generator cannot sustain offered rate", async () => {
    let total = 0;
    const apiKey = "slow-runner-key";
    const server = createServer(async (request, response) => {
      if (request.headers["x-api-key"] !== apiKey) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && request.url === "/api/v1/operations/snapshot") {
        sendJson(response, 200, snapshot(total, total));
        return;
      }
      if (request.method === "POST" && request.url === "/api/v1/messages") {
        await readBody(request);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        total += 1;
        sendJson(response, 202, { messageId: `slow-${total}`, status: "QUEUED" });
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
        EXTERNAL_CAPACITY_RECIPIENTS: "+96170876543",
        EXTERNAL_CAPACITY_DURATION_SECONDS: "1",
        EXTERNAL_CAPACITY_MAX_MESSAGES: "20",
        EXTERNAL_CAPACITY_CONCURRENCY: "1",
        EXTERNAL_CAPACITY_TARGET_RPS: "10",
        EXTERNAL_CAPACITY_MIN_START_RATE_RATIO: "0.8",
        EXTERNAL_CAPACITY_ACCEPT_P95_MS: "1000",
        EXTERNAL_CAPACITY_ACCEPT_P99_MS: "1000",
        EXTERNAL_CAPACITY_DRAIN_MAX_MS: "3000",
        EXTERNAL_CAPACITY_SNAPSHOT_INTERVAL_MS: "250",
        EXTERNAL_CAPACITY_REQUEST_TIMEOUT_MS: "1000",
      });

      expect(result.code).toBe(1);
      const report = parseReport(result.stdout);
      expect(report.achievedStartRateRatio).not.toBeNull();
      expect(report.achievedStartRateRatio!).toBeLessThan(0.8);
      expect(report.gates.startRate).toBe(false);
      expect(report.passed).toBe(false);
    } finally {
      await closeServer(server);
    }
  }, 10_000);

  it("fails the optional oldest-outbox-age gate when a sampled maximum exceeds its ceiling", async () => {
    let total = 0;
    let snapshotRequests = 0;
    const apiKey = "oldest-age-key";
    const server = createServer(async (request, response) => {
      if (request.headers["x-api-key"] !== apiKey) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && request.url === "/api/v1/operations/snapshot") {
        snapshotRequests += 1;
        const pending = snapshotRequests === 2 ? 1 : 0;
        sendJson(response, 200, snapshot(total, total, pending, pending ? 7 : 0));
        return;
      }
      if (request.method === "POST" && request.url === "/api/v1/messages") {
        await readBody(request);
        total += 1;
        sendJson(response, 202, { messageId: `age-${total}`, status: "QUEUED" });
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
        EXTERNAL_CAPACITY_RECIPIENTS: "+96170876543",
        EXTERNAL_CAPACITY_MESSAGES: "2",
        EXTERNAL_CAPACITY_CONCURRENCY: "1",
        EXTERNAL_CAPACITY_MAX_OUTBOX_OLDEST_AGE_SECONDS: "5",
        EXTERNAL_CAPACITY_ACCEPT_P95_MS: "1000",
        EXTERNAL_CAPACITY_ACCEPT_P99_MS: "1000",
        EXTERNAL_CAPACITY_DRAIN_MAX_MS: "3000",
        EXTERNAL_CAPACITY_SNAPSHOT_INTERVAL_MS: "250",
        EXTERNAL_CAPACITY_REQUEST_TIMEOUT_MS: "1000",
      });

      expect(result.code).toBe(1);
      const report = parseReport(result.stdout);
      expect(report.operations.maxOldestPendingAgeSeconds).toBe(7);
      expect(report.gates.outboxOldestAge).toBe(false);
      expect(report.passed).toBe(false);
    } finally {
      await closeServer(server);
    }
  }, 10_000);
});
