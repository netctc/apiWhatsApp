import { performance } from "node:perf_hooks";

export interface LoadAttempt<T> {
  index: number;
  durationMs: number;
  value?: T;
  error?: string;
}

export interface LoadRunOptions {
  total: number;
  concurrency: number;
  targetRatePerSecond?: number;
}

export interface DurationSummary {
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export async function runBoundedLoad<T>(
  options: LoadRunOptions,
  operation: (index: number) => Promise<T>,
): Promise<LoadAttempt<T>[]> {
  assertPositiveInteger("total", options.total);
  assertPositiveInteger("concurrency", options.concurrency);
  if (options.concurrency > options.total) {
    throw new Error("concurrency cannot exceed total");
  }
  const targetRate = options.targetRatePerSecond ?? 0;
  if (!Number.isFinite(targetRate) || targetRate < 0) {
    throw new Error("targetRatePerSecond must be a non-negative finite number");
  }

  const results = new Array<LoadAttempt<T>>(options.total);
  const startedAt = performance.now();
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.total) {
        return;
      }

      if (targetRate > 0) {
        const scheduledAt = startedAt + (index * 1000) / targetRate;
        const delayMs = scheduledAt - performance.now();
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }

      const attemptStartedAt = performance.now();
      try {
        results[index] = {
          index,
          durationMs: performance.now() - attemptStartedAt,
          value: await operation(index),
        };
      } catch (error) {
        results[index] = {
          index,
          durationMs: performance.now() - attemptStartedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  return results;
}

export function summarizeDurations(durations: number[]): DurationSummary {
  if (durations.length === 0) {
    throw new Error("At least one duration is required");
  }
  const sorted = durations.map((value) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Durations must be non-negative finite numbers");
    }
    return value;
  }).sort((a, b) => a - b);

  return {
    minMs: sorted[0]!,
    p50Ms: percentileSorted(sorted, 0.5),
    p95Ms: percentileSorted(sorted, 0.95),
    p99Ms: percentileSorted(sorted, 0.99),
    maxMs: sorted.at(-1)!,
  };
}

export function readBoundedIntegerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function readBoundedNumberEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

function percentileSorted(sorted: number[], quantile: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index]!;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
