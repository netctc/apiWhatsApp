#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createMonotonicStartGate } from "./external-capacity-scheduler.mjs";

const SUCCESS_STATUSES = ["SUBMITTED", "SENT", "DELIVERED", "READ"];
const IN_FLIGHT_STATUSES = ["CREATED", "QUEUED", "PROCESSING"];
const FAILURE_STATUSES = ["FAILED", "CANCELLED", "EXPIRED"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readInteger(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readNumber(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
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
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requireConfirmation() {
  if (process.env.EXTERNAL_CAPACITY_CONFIRM_ISOLATED_TEST_ENV?.trim().toLowerCase() !== "true") {
    throw new Error(
      "EXTERNAL_CAPACITY_CONFIRM_ISOLATED_TEST_ENV=true is required before generating traffic",
    );
  }
}

function parseBaseUrl() {
  const url = new URL(requireEnv("EXTERNAL_CAPACITY_BASE_URL"));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("EXTERNAL_CAPACITY_BASE_URL must use http or https");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url;
}

function parseRecipients() {
  const values = requireEnv("EXTERNAL_CAPACITY_RECIPIENTS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.some((value) => !/^\+[1-9]\d{7,14}$/.test(value))) {
    throw new Error("EXTERNAL_CAPACITY_RECIPIENTS must contain comma-separated E.164 numbers");
  }
  return values;
}

function parseRunLabel() {
  const value = process.env.EXTERNAL_CAPACITY_PROFILE_NAME?.trim() || "profile-c-external";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error(
      "EXTERNAL_CAPACITY_PROFILE_NAME must contain only letters, numbers, dot, underscore, or dash",
    );
  }
  return value;
}

function countStatuses(snapshot, statuses) {
  return statuses.reduce(
    (sum, status) => sum + Number(snapshot?.messages?.byStatus?.[status] ?? 0),
    0,
  );
}

function statusDeltas(baseline, current) {
  const keys = new Set([
    ...Object.keys(baseline?.messages?.byStatus ?? {}),
    ...Object.keys(current?.messages?.byStatus ?? {}),
  ]);
  return Object.fromEntries(
    [...keys].sort().map((status) => [
      status,
      Number(current?.messages?.byStatus?.[status] ?? 0) -
        Number(baseline?.messages?.byStatus?.[status] ?? 0),
    ]),
  );
}

function summarizeDurations(values) {
  if (values.length === 0) {
    return { min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) => {
    const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
    return sorted[index];
  };
  return {
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted[sorted.length - 1],
  };
}

async function requestJson(url, options, timeoutMs) {
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
  return { response, body };
}

function createOperationsTelemetry(baseline) {
  return {
    samples: 1,
    snapshotErrors: 0,
    maxOutboxPending: Number(baseline.outbox?.pending ?? 0),
    maxOutboxDue: Number(baseline.outbox?.due ?? 0),
    maxOutboxLeased: Number(baseline.outbox?.leased ?? 0),
    maxOldestPendingAgeSeconds: Number(baseline.outbox?.oldestPendingAgeSeconds ?? 0),
  };
}

function observeSnapshot(telemetry, snapshot) {
  telemetry.samples += 1;
  telemetry.maxOutboxPending = Math.max(
    telemetry.maxOutboxPending,
    Number(snapshot.outbox?.pending ?? 0),
  );
  telemetry.maxOutboxDue = Math.max(telemetry.maxOutboxDue, Number(snapshot.outbox?.due ?? 0));
  telemetry.maxOutboxLeased = Math.max(
    telemetry.maxOutboxLeased,
    Number(snapshot.outbox?.leased ?? 0),
  );
  telemetry.maxOldestPendingAgeSeconds = Math.max(
    telemetry.maxOldestPendingAgeSeconds,
    Number(snapshot.outbox?.oldestPendingAgeSeconds ?? 0),
  );
}

function assertCleanBaseline(snapshot) {
  const pending = Number(snapshot.outbox?.pending ?? 0);
  const due = Number(snapshot.outbox?.due ?? 0);
  const leased = Number(snapshot.outbox?.leased ?? 0);
  const inFlight = countStatuses(snapshot, IN_FLIGHT_STATUSES);
  if (pending !== 0 || due !== 0 || leased !== 0 || inFlight !== 0) {
    throw new Error(
      "The isolated test tenant must start without pending outbox work or in-flight messages",
    );
  }
}

async function runLoad(
  { total, maxMessages, concurrency, targetRatePerSecond, durationSeconds },
  task,
) {
  const results = [];
  const durationMode = durationSeconds > 0;
  const deadlineAtMs = durationMode ? performance.now() + durationSeconds * 1000 : null;
  const attemptLimit = durationMode ? maxMessages : total;
  const waitForStart =
    targetRatePerSecond > 0
      ? createMonotonicStartGate({ targetRatePerSecond, deadlineAtMs })
      : null;
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= attemptLimit) {
        return;
      }

      if (durationMode && performance.now() >= deadlineAtMs) {
        return;
      }

      if (waitForStart) {
        const startedSlot = await waitForStart();
        if (startedSlot === null) {
          return;
        }
      }

      if (durationMode && performance.now() >= deadlineAtMs) {
        return;
      }

      const startedAt = performance.now();
      try {
        const value = await task(index);
        results.push({
          index,
          startedAt,
          durationMs: performance.now() - startedAt,
          ...value,
        });
      } catch {
        results.push({
          index,
          startedAt,
          durationMs: performance.now() - startedAt,
          status: 0,
          messageId: undefined,
          transportError: true,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, attemptLimit) }, () => worker()));
  results.sort((left, right) => left.index - right.index);
  return results;
}

async function main() {
  requireConfirmation();

  const baseUrl = parseBaseUrl();
  const apiKey = requireEnv("EXTERNAL_CAPACITY_API_KEY");
  const recipients = parseRecipients();
  const profileName = parseRunLabel();
  const total = readInteger("EXTERNAL_CAPACITY_MESSAGES", 100_000, 1, 1_000_000);
  const durationSeconds = readInteger("EXTERNAL_CAPACITY_DURATION_SECONDS", 0, 0, 21_600);
  const maxMessages = readInteger("EXTERNAL_CAPACITY_MAX_MESSAGES", 1_000_000, 1, 1_000_000);
  const attemptLimit = durationSeconds > 0 ? maxMessages : total;
  const concurrency = readInteger("EXTERNAL_CAPACITY_CONCURRENCY", 500, 1, attemptLimit);
  const targetRatePerSecond = readNumber("EXTERNAL_CAPACITY_TARGET_RPS", 0, 0, 10_000);
  const minStartRateRatio = readNumber("EXTERNAL_CAPACITY_MIN_START_RATE_RATIO", 0.95, 0, 1);
  const maxOutboxPending = readOptionalInteger(
    "EXTERNAL_CAPACITY_MAX_OUTBOX_PENDING",
    0,
    1_000_000_000,
  );
  const maxOutboxOldestAgeSeconds = readOptionalInteger(
    "EXTERNAL_CAPACITY_MAX_OUTBOX_OLDEST_AGE_SECONDS",
    0,
    86_400,
  );
  const maxP95Ms = readNumber("EXTERNAL_CAPACITY_ACCEPT_P95_MS", 3000, 1, 60_000);
  const maxP99Ms = readNumber("EXTERNAL_CAPACITY_ACCEPT_P99_MS", 5000, 1, 60_000);
  const maxErrorRate = readNumber("EXTERNAL_CAPACITY_MAX_ERROR_RATE", 0, 0, 1);
  const drainMaxMs = readInteger(
    "EXTERNAL_CAPACITY_DRAIN_MAX_MS",
    1_800_000,
    1000,
    86_400_000,
  );
  const snapshotIntervalMs = readInteger(
    "EXTERNAL_CAPACITY_SNAPSHOT_INTERVAL_MS",
    5000,
    250,
    60_000,
  );
  const requestTimeoutMs = readInteger(
    "EXTERNAL_CAPACITY_REQUEST_TIMEOUT_MS",
    10_000,
    100,
    120_000,
  );
  const senderId = process.env.EXTERNAL_CAPACITY_SENDER_ID?.trim() || undefined;

  if (durationSeconds === 0 && total > maxMessages) {
    throw new Error("EXTERNAL_CAPACITY_MESSAGES must not exceed EXTERNAL_CAPACITY_MAX_MESSAGES");
  }
  if (durationSeconds > 0 && targetRatePerSecond <= 0) {
    throw new Error("EXTERNAL_CAPACITY_TARGET_RPS must be greater than zero in duration mode");
  }
  if (durationSeconds > 0) {
    const minimumRequiredStarts = Math.ceil(
      durationSeconds * targetRatePerSecond * minStartRateRatio,
    );
    if (maxMessages < minimumRequiredStarts) {
      throw new Error(
        `EXTERNAL_CAPACITY_MAX_MESSAGES must be at least ${minimumRequiredStarts} to satisfy EXTERNAL_CAPACITY_MIN_START_RATE_RATIO`,
      );
    }
  }

  const messagesUrl = new URL("/api/v1/messages", baseUrl);
  const snapshotUrl = new URL("/api/v1/operations/snapshot", baseUrl);
  const commonHeaders = { "X-API-Key": apiKey };

  const getSnapshot = async () => {
    const { response, body } = await requestJson(
      snapshotUrl,
      { method: "GET", headers: commonHeaders },
      requestTimeoutMs,
    );
    if (response.status !== 200 || !body || typeof body !== "object") {
      throw new Error(`Operations snapshot request failed with HTTP ${response.status}`);
    }
    return body;
  };

  const baseline = await getSnapshot();
  assertCleanBaseline(baseline);
  const operations = createOperationsTelemetry(baseline);
  let stopMonitoring = false;

  const monitoringPromise = (async () => {
    while (!stopMonitoring) {
      await sleep(snapshotIntervalMs);
      if (stopMonitoring) {
        break;
      }
      try {
        observeSnapshot(operations, await getSnapshot());
      } catch {
        operations.snapshotErrors += 1;
      }
    }
  })();

  const runToken = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const acceptanceStartedAt = performance.now();
  const attempts = await runLoad(
    { total, maxMessages, concurrency, targetRatePerSecond, durationSeconds },
    async (index) => {
      const requestBody = {
        to: recipients[index % recipients.length],
        type: "TEXT",
        ...(senderId ? { senderId } : {}),
        payload: { body: `External capacity ${profileName} ${runToken} ${index}` },
      };
      const { response, body } = await requestJson(
        messagesUrl,
        {
          method: "POST",
          headers: {
            ...commonHeaders,
            "Content-Type": "application/json",
            "Idempotency-Key": `external-capacity-${runToken}-${index}`,
          },
          body: JSON.stringify(requestBody),
        },
        requestTimeoutMs,
      );
      return {
        status: response.status,
        messageId:
          response.status === 202 && body && typeof body.messageId === "string"
            ? body.messageId
            : undefined,
        transportError: false,
      };
    },
  );
  const acceptanceWallMs = performance.now() - acceptanceStartedAt;

  stopMonitoring = true;

  const attempted = attempts.length;
  const accepted = attempts.filter(
    (attempt) => attempt.status === 202 && typeof attempt.messageId === "string",
  );
  const uniqueMessageIds = new Set(accepted.map((attempt) => attempt.messageId));
  const errorRate = attempted > 0 ? (attempted - accepted.length) / attempted : 1;
  const latency = summarizeDurations(attempts.map((attempt) => attempt.durationMs));
  const httpStatusCounts = {};
  let transportErrors = 0;
  for (const attempt of attempts) {
    if (attempt.transportError || attempt.status === 0) {
      transportErrors += 1;
      continue;
    }
    httpStatusCounts[String(attempt.status)] = (httpStatusCounts[String(attempt.status)] ?? 0) + 1;
  }

  const expectedDurationStarts =
    durationSeconds > 0 ? durationSeconds * targetRatePerSecond : null;
  const achievedStartRatePerSecond =
    durationSeconds > 0 ? attempted / durationSeconds : null;
  const achievedStartRateRatio =
    expectedDurationStarts && expectedDurationStarts > 0
      ? attempted / expectedDurationStarts
      : null;

  const baselineTotal = Number(baseline.messages?.total ?? 0);
  const baselineSuccessful = countStatuses(baseline, SUCCESS_STATUSES);
  const baselineFailures = countStatuses(baseline, FAILURE_STATUSES);
  const drainStartedAt = performance.now();
  const drainDeadline = Date.now() + drainMaxMs;
  let finalSnapshot = baseline;
  let drainCompleted = accepted.length === 0;
  let contaminationDetected = false;

  while (!drainCompleted && Date.now() < drainDeadline) {
    await sleep(snapshotIntervalMs);
    try {
      finalSnapshot = await getSnapshot();
      observeSnapshot(operations, finalSnapshot);
    } catch {
      operations.snapshotErrors += 1;
      continue;
    }

    const totalDelta = Number(finalSnapshot.messages?.total ?? 0) - baselineTotal;
    const successfulDelta = countStatuses(finalSnapshot, SUCCESS_STATUSES) - baselineSuccessful;
    const failureDelta = countStatuses(finalSnapshot, FAILURE_STATUSES) - baselineFailures;
    const inFlightDelta =
      countStatuses(finalSnapshot, IN_FLIGHT_STATUSES) - countStatuses(baseline, IN_FLIGHT_STATUSES);
    const pending = Number(finalSnapshot.outbox?.pending ?? 0);

    if (totalDelta > accepted.length) {
      contaminationDetected = true;
      break;
    }

    drainCompleted =
      totalDelta === accepted.length &&
      successfulDelta === accepted.length &&
      failureDelta === 0 &&
      inFlightDelta === 0 &&
      pending === 0;
  }

  if (finalSnapshot === baseline || (!drainCompleted && !contaminationDetected)) {
    try {
      finalSnapshot = await getSnapshot();
      observeSnapshot(operations, finalSnapshot);
    } catch {
      operations.snapshotErrors += 1;
    }
  }

  const drainMs = performance.now() - drainStartedAt;
  const totalDelta = Number(finalSnapshot.messages?.total ?? 0) - baselineTotal;
  const successfulDelta = countStatuses(finalSnapshot, SUCCESS_STATUSES) - baselineSuccessful;
  const failureDelta = countStatuses(finalSnapshot, FAILURE_STATUSES) - baselineFailures;
  const finalStatusDeltas = statusDeltas(baseline, finalSnapshot);
  const totalWallMs = performance.now() - acceptanceStartedAt;
  await monitoringPromise;

  const gates = {
    errorRate: errorRate <= maxErrorRate,
    uniqueMessageIds: uniqueMessageIds.size === accepted.length,
    p95: latency.p95 <= maxP95Ms,
    p99: latency.p99 <= maxP99Ms,
    drain: drainCompleted,
    isolatedTenant: !contaminationDetected && totalDelta === accepted.length,
    ...(durationSeconds > 0
      ? { startRate: achievedStartRateRatio >= minStartRateRatio }
      : {}),
    ...(maxOutboxPending !== null
      ? { outboxPending: operations.maxOutboxPending <= maxOutboxPending }
      : {}),
    ...(maxOutboxOldestAgeSeconds !== null
      ? {
          outboxOldestAge:
            operations.maxOldestPendingAgeSeconds <= maxOutboxOldestAgeSeconds,
        }
      : {}),
  };
  const passed = Object.values(gates).every(Boolean);

  const report = {
    profileName,
    environmentClass: "external-isolated-test",
    total: durationSeconds > 0 ? attempted : total,
    mode: durationSeconds > 0 ? "duration" : "fixed-count",
    configuredMessages: total,
    durationSeconds,
    maxMessages,
    attempted,
    concurrency,
    targetRatePerSecond,
    minStartRateRatio: durationSeconds > 0 ? minStartRateRatio : null,
    achievedStartRatePerSecond:
      achievedStartRatePerSecond === null
        ? null
        : Number(achievedStartRatePerSecond.toFixed(2)),
    achievedStartRateRatio:
      achievedStartRateRatio === null ? null : Number(achievedStartRateRatio.toFixed(4)),
    recipientCount: recipients.length,
    accepted: accepted.length,
    errors: attempted - accepted.length,
    errorRate,
    duplicateAcceptedIds: accepted.length - uniqueMessageIds.size,
    transportErrors,
    httpStatusCounts,
    acceptanceWallMs: Math.round(acceptanceWallMs),
    latencyMs: {
      min: Math.round(latency.min),
      p50: Math.round(latency.p50),
      p95: Math.round(latency.p95),
      p99: Math.round(latency.p99),
      max: Math.round(latency.max),
    },
    drainMs: Math.round(drainMs),
    totalMessageDelta: totalDelta,
    successfulStatusDelta: successfulDelta,
    failureStatusDelta: failureDelta,
    finalStatusDeltas,
    operations: {
      samples: operations.samples,
      snapshotErrors: operations.snapshotErrors,
      maxOutboxPending: operations.maxOutboxPending,
      maxOutboxDue: operations.maxOutboxDue,
      maxOutboxLeased: operations.maxOutboxLeased,
      maxOldestPendingAgeSeconds: operations.maxOldestPendingAgeSeconds,
      configuredMaxOutboxPending: maxOutboxPending,
      configuredMaxOutboxOldestAgeSeconds: maxOutboxOldestAgeSeconds,
      finalOutboxPending: Number(finalSnapshot.outbox?.pending ?? 0),
      finalOldestPendingAgeSeconds: Number(finalSnapshot.outbox?.oldestPendingAgeSeconds ?? 0),
    },
    acceptanceThroughputPerSecond:
      acceptanceWallMs > 0 ? Number((accepted.length / (acceptanceWallMs / 1000)).toFixed(2)) : 0,
    endToEndThroughputPerSecond:
      totalWallMs > 0 ? Number((accepted.length / (totalWallMs / 1000)).toFixed(2)) : 0,
    gates,
    passed,
  };

  process.stdout.write(`[external-capacity] ${JSON.stringify(report)}\n`);
  if (!passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "External capacity runner failed";
  process.stderr.write(`[external-capacity] ERROR ${message}\n`);
  process.exitCode = 1;
});
