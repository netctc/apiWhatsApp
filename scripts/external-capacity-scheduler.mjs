import { performance } from "node:perf_hooks";

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a serialized request-start gate that never catches up missed pacing slots.
 * The next permitted start is derived from the previous actual start, so an event-loop
 * or host delay cannot cause multiple queued workers to emit a recovery burst.
 */
export function createMonotonicStartGate({
  targetRatePerSecond,
  deadlineAtMs = null,
  now = () => performance.now(),
  sleep = defaultSleep,
}) {
  if (!Number.isFinite(targetRatePerSecond) || targetRatePerSecond <= 0) {
    throw new Error("targetRatePerSecond must be greater than zero");
  }
  if (deadlineAtMs !== null && !Number.isFinite(deadlineAtMs)) {
    throw new Error("deadlineAtMs must be finite when provided");
  }

  const intervalMs = 1000 / targetRatePerSecond;
  let nextStartAtMs = now();
  let queue = Promise.resolve();

  return async function waitForStart() {
    let release;
    const previous = queue;
    queue = new Promise((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      let current = now();
      if (deadlineAtMs !== null && current >= deadlineAtMs) {
        return null;
      }

      const scheduledStartAtMs = Math.max(current, nextStartAtMs);
      if (deadlineAtMs !== null && scheduledStartAtMs >= deadlineAtMs) {
        return null;
      }

      const waitMs = scheduledStartAtMs - current;
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      current = now();
      if (deadlineAtMs !== null && current >= deadlineAtMs) {
        return null;
      }

      nextStartAtMs = current + intervalMs;
      return current;
    } finally {
      release();
    }
  };
}
