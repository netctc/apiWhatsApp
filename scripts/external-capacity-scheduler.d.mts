export interface MonotonicStartGateOptions {
  targetRatePerSecond: number;
  deadlineAtMs?: number | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createMonotonicStartGate(
  options: MonotonicStartGateOptions,
): () => Promise<number | null>;
