#!/usr/bin/env node

import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json");
const PACKAGE_VERSION = packageMetadata.version;
const SAFE_REVISION = /^[A-Za-z0-9._-]{1,64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

class CertificationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function emit(report) {
  process.stdout.write(`[production-certification] ${JSON.stringify(report)}\n`);
}

function requireConfirmation() {
  if (process.env.CERTIFICATION_CONFIRM_PRODUCTION_LIKE_ENV?.trim().toLowerCase() !== "true") {
    throw new CertificationError("confirmation_required");
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new CertificationError(`${name.toLowerCase()}_required`);
  }
  return value;
}

function readBoolean(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new CertificationError(`${name.toLowerCase()}_invalid`);
}

function readInteger(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CertificationError(`${name.toLowerCase()}_invalid`);
  }
  return value;
}

function readOptionalInteger(name, min, max) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CertificationError(`${name.toLowerCase()}_invalid`);
  }
  return value;
}

function parseBaseUrl(requireHttps) {
  let url;
  try {
    url = new URL(requireEnv("CERTIFICATION_BASE_URL"));
  } catch (error) {
    if (error instanceof CertificationError) {
      throw error;
    }
    throw new CertificationError("certification_base_url_invalid");
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new CertificationError("https_required");
  }
  if (!requireHttps && url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CertificationError("certification_base_url_invalid");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url;
}

function expectedVersion() {
  const value = process.env.CERTIFICATION_EXPECTED_VERSION?.trim() || PACKAGE_VERSION;
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new CertificationError("expected_version_invalid");
  }
  return value;
}

function expectedRevision() {
  const value = process.env.CERTIFICATION_EXPECTED_REVISION?.trim();
  if (!value) {
    return null;
  }
  if (!SAFE_REVISION.test(value)) {
    throw new CertificationError("expected_revision_invalid");
  }
  return value;
}

async function requestJson(url, options, timeoutMs) {
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  } catch {
    throw new CertificationError("request_failed");
  }
}

function dependencySummary(dependencies) {
  const result = {};
  for (const name of ["postgres", "redis", "rabbitmq", "mediaStorage"]) {
    const dependency = dependencies?.[name];
    if (!dependency || typeof dependency !== "object") {
      result[name] = { status: "unknown" };
      continue;
    }
    result[name] = {
      status: typeof dependency.status === "string" ? dependency.status : "unknown",
      ...(Number.isFinite(Number(dependency.durationMs))
        ? { durationMs: Number(dependency.durationMs) }
        : {}),
      ...(typeof dependency.error === "string" ? { error: dependency.error } : {}),
      ...(name === "mediaStorage" && typeof dependency.mode === "string"
        ? { mode: dependency.mode }
        : {}),
    };
  }
  return result;
}

function allDependenciesUp(dependencies) {
  return ["postgres", "redis", "rabbitmq", "mediaStorage"].every(
    (name) => dependencies?.[name]?.status === "up",
  );
}

function nonNegative(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

async function main() {
  requireConfirmation();

  const requireHttps = readBoolean("CERTIFICATION_REQUIRE_HTTPS", true);
  const baseUrl = parseBaseUrl(requireHttps);
  const apiKey = requireEnv("CERTIFICATION_API_KEY");
  const expected = {
    version: expectedVersion(),
    revision: expectedRevision(),
  };
  const requestTimeoutMs = readInteger("CERTIFICATION_REQUEST_TIMEOUT_MS", 5000, 100, 30_000);
  const maxReadyMs = readInteger("CERTIFICATION_MAX_READY_MS", 3000, 1, 30_000);
  const maxOutboxPending = readInteger("CERTIFICATION_MAX_OUTBOX_PENDING", 0, 0, 1_000_000_000);
  const maxOutboxDue = readInteger("CERTIFICATION_MAX_OUTBOX_DUE", 0, 0, 1_000_000_000);
  const maxOutboxWithErrors = readInteger(
    "CERTIFICATION_MAX_OUTBOX_WITH_ERRORS",
    0,
    0,
    1_000_000_000,
  );
  const maxOutboxOldestAgeSeconds = readInteger(
    "CERTIFICATION_MAX_OUTBOX_OLDEST_AGE_SECONDS",
    60,
    0,
    86_400,
  );
  const maxInboxOverdueUnescalated = readOptionalInteger(
    "CERTIFICATION_MAX_INBOX_OVERDUE_UNESCALATED",
    0,
    1_000_000_000,
  );
  const maxInboxEscalatedUnresolved = readOptionalInteger(
    "CERTIFICATION_MAX_INBOX_ESCALATED_UNRESOLVED",
    0,
    1_000_000_000,
  );

  const liveUrl = new URL("/api/health/live", baseUrl);
  const readyUrl = new URL("/api/health/ready", baseUrl);
  const operationsUrl = new URL("/api/v1/operations/snapshot", baseUrl);

  const liveStarted = performance.now();
  const liveResponse = await requestJson(liveUrl, { method: "GET" }, requestTimeoutMs);
  const liveMs = performance.now() - liveStarted;

  const readyStarted = performance.now();
  const readyResponse = await requestJson(readyUrl, { method: "GET" }, requestTimeoutMs);
  const readyMs = performance.now() - readyStarted;

  const operationsResponse = await requestJson(
    operationsUrl,
    { method: "GET", headers: { "X-API-Key": apiKey } },
    requestTimeoutMs,
  );

  const live = liveResponse.body && typeof liveResponse.body === "object" ? liveResponse.body : {};
  const readiness =
    readyResponse.body && typeof readyResponse.body === "object" ? readyResponse.body : {};
  const operations =
    operationsResponse.body && typeof operationsResponse.body === "object"
      ? operationsResponse.body
      : {};

  const outbox = operations.outbox && typeof operations.outbox === "object" ? operations.outbox : {};
  const inbox =
    operations.inboxResponseSla && typeof operations.inboxResponseSla === "object"
      ? operations.inboxResponseSla
      : {};

  const gates = {
    liveHttp: liveResponse.status === 200,
    liveStatus: live.status === "ok",
    version: live.version === expected.version,
    ...(expected.revision !== null ? { revision: live.revision === expected.revision } : {}),
    readyHttp: readyResponse.status === 200,
    readyStatus: readiness.status === "ready",
    readyDependencies: allDependenciesUp(readiness.dependencies),
    readyLatency: readyMs <= maxReadyMs,
    operationsHttp: operationsResponse.status === 200,
    outboxPending: nonNegative(outbox.pending) <= maxOutboxPending,
    outboxDue: nonNegative(outbox.due) <= maxOutboxDue,
    outboxWithErrors: nonNegative(outbox.withErrors) <= maxOutboxWithErrors,
    outboxOldestAge:
      nonNegative(outbox.oldestPendingAgeSeconds) <= maxOutboxOldestAgeSeconds,
    ...(maxInboxOverdueUnescalated !== null
      ? {
          inboxOverdueUnescalated:
            nonNegative(inbox.overdueUnescalated) <= maxInboxOverdueUnescalated,
        }
      : {}),
    ...(maxInboxEscalatedUnresolved !== null
      ? {
          inboxEscalatedUnresolved:
            nonNegative(inbox.escalatedUnresolved) <= maxInboxEscalatedUnresolved,
        }
      : {}),
  };
  const passed = Object.values(gates).every(Boolean);

  const report = {
    environmentClass: "production-like-certification",
    expected,
    live: {
      httpStatus: liveResponse.status,
      status: typeof live.status === "string" ? live.status : null,
      version: typeof live.version === "string" ? live.version : null,
      revision: typeof live.revision === "string" ? live.revision : null,
      latencyMs: Math.round(liveMs),
    },
    readiness: {
      httpStatus: readyResponse.status,
      status: typeof readiness.status === "string" ? readiness.status : null,
      latencyMs: Math.round(readyMs),
      maxLatencyMs: maxReadyMs,
      dependencies: dependencySummary(readiness.dependencies),
    },
    operations: {
      httpStatus: operationsResponse.status,
      generatedAt: typeof operations.generatedAt === "string" ? operations.generatedAt : null,
      outbox: {
        pending: nonNegative(outbox.pending),
        due: nonNegative(outbox.due),
        leased: nonNegative(outbox.leased),
        withErrors: nonNegative(outbox.withErrors),
        oldestPendingAgeSeconds: nonNegative(outbox.oldestPendingAgeSeconds),
      },
      inboxResponseSla: {
        waitingForResponse: nonNegative(inbox.waitingForResponse),
        overdueUnescalated: nonNegative(inbox.overdueUnescalated),
        escalatedUnresolved: nonNegative(inbox.escalatedUnresolved),
        oldestOverdueAgeSeconds: nonNegative(inbox.oldestOverdueAgeSeconds),
      },
    },
    thresholds: {
      maxOutboxPending,
      maxOutboxDue,
      maxOutboxWithErrors,
      maxOutboxOldestAgeSeconds,
      maxInboxOverdueUnescalated,
      maxInboxEscalatedUnresolved,
    },
    gates,
    passed,
    checkedAt: new Date().toISOString(),
  };

  emit(report);
  if (!passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  emit({
    environmentClass: "production-like-certification",
    error: error instanceof CertificationError ? error.code : "certification_failed",
    passed: false,
    checkedAt: new Date().toISOString(),
  });
  process.exitCode = 1;
});
