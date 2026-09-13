import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { APP_VERSION } from "../src/version.js";

interface RunnerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface CertificationReport {
  error?: string;
  gates?: Record<string, boolean>;
  passed: boolean;
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
  const child = spawn(process.execPath, [resolve("scripts/production-certification.mjs")], {
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

function reportFrom(stdout: string): CertificationReport {
  const marker = "[production-certification] ";
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(marker));
  if (!line) {
    throw new Error("Certification report line was not emitted");
  }
  return JSON.parse(line.slice(marker.length)) as CertificationReport;
}

function baseEnv(port: number, apiKey: string): NodeJS.ProcessEnv {
  return {
    CERTIFICATION_CONFIRM_PRODUCTION_LIKE_ENV: "true",
    CERTIFICATION_BASE_URL: `http://127.0.0.1:${port}`,
    CERTIFICATION_API_KEY: apiKey,
    CERTIFICATION_REQUIRE_HTTPS: "false",
    CERTIFICATION_EXPECTED_VERSION: APP_VERSION,
    CERTIFICATION_EXPECTED_REVISION: "release-test-revision",
    CERTIFICATION_REQUEST_TIMEOUT_MS: "1000",
    CERTIFICATION_MAX_READY_MS: "1000",
    CERTIFICATION_MAX_OUTBOX_PENDING: "0",
    CERTIFICATION_MAX_OUTBOX_DUE: "0",
    CERTIFICATION_MAX_OUTBOX_WITH_ERRORS: "0",
    CERTIFICATION_MAX_OUTBOX_OLDEST_AGE_SECONDS: "60",
    CERTIFICATION_MAX_INBOX_OVERDUE_UNESCALATED: "",
    CERTIFICATION_MAX_INBOX_ESCALATED_UNRESOLVED: "",
  };
}

function certificationServer(
  apiKey: string,
  options: { version?: string; outboxPending?: number } = {},
): ReturnType<typeof createServer> {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/api/health/live") {
      sendJson(response, 200, {
        status: "ok",
        version: options.version ?? APP_VERSION,
        revision: "release-test-revision",
        uptimeSeconds: 10,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (request.method === "GET" && request.url === "/api/health/ready") {
      sendJson(response, 200, {
        status: "ready",
        dependencies: {
          postgres: { status: "up", durationMs: 1 },
          redis: { status: "up", durationMs: 1 },
          rabbitmq: { status: "up", durationMs: 1 },
          mediaStorage: { status: "up", mode: "disabled", durationMs: 0 },
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (request.method === "GET" && request.url === "/api/v1/operations/snapshot") {
      if (request.headers["x-api-key"] !== apiKey) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const pending = options.outboxPending ?? 0;
      sendJson(response, 200, {
        outbox: {
          pending,
          due: pending,
          leased: 0,
          withErrors: 0,
          oldestPendingAgeSeconds: pending > 0 ? 5 : null,
        },
        inboxResponseSla: {
          waitingForResponse: 0,
          overdueUnescalated: 0,
          escalatedUnresolved: 0,
          oldestOverdueAgeSeconds: null,
        },
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  });
}

describe("production certification runner", () => {
  it("certifies an exact healthy build without leaking the API key", async () => {
    const apiKey = "certification-secret-key";
    const server = certificationServer(apiKey);
    const port = await listen(server);
    try {
      const result = await runRunner(baseEnv(port, apiKey));
      const report = reportFrom(result.stdout);

      expect(result.code).toBe(0);
      expect(report.passed).toBe(true);
      expect(Object.values(report.gates ?? {}).every(Boolean)).toBe(true);
      expect(result.stdout).not.toContain(apiKey);
      expect(result.stderr).not.toContain(apiKey);
    } finally {
      await closeServer(server);
    }
  });

  it("refuses to contact a target without explicit production-like confirmation", async () => {
    const apiKey = "must-not-leak";
    const result = await runRunner({
      CERTIFICATION_CONFIRM_PRODUCTION_LIKE_ENV: "false",
      CERTIFICATION_BASE_URL: "http://127.0.0.1:1",
      CERTIFICATION_API_KEY: apiKey,
      CERTIFICATION_REQUIRE_HTTPS: "false",
    });
    const report = reportFrom(result.stdout);

    expect(result.code).toBe(1);
    expect(report).toMatchObject({ error: "confirmation_required", passed: false });
    expect(result.stdout).not.toContain(apiKey);
    expect(result.stderr).not.toContain(apiKey);
  });

  it("fails certification when the deployed version does not match", async () => {
    const apiKey = "version-test-key";
    const server = certificationServer(apiKey, { version: "9.9.9" });
    const port = await listen(server);
    try {
      const result = await runRunner(baseEnv(port, apiKey));
      const report = reportFrom(result.stdout);

      expect(result.code).toBe(1);
      expect(report.gates?.version).toBe(false);
      expect(report.passed).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("fails certification when queue backlog exceeds the configured gate", async () => {
    const apiKey = "backlog-test-key";
    const server = certificationServer(apiKey, { outboxPending: 2 });
    const port = await listen(server);
    try {
      const result = await runRunner(baseEnv(port, apiKey));
      const report = reportFrom(result.stdout);

      expect(result.code).toBe(1);
      expect(report.gates?.outboxPending).toBe(false);
      expect(report.gates?.outboxDue).toBe(false);
      expect(report.passed).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});
