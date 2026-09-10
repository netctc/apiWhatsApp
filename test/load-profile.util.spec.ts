import { jest } from "@jest/globals";
import {
  readBoundedIntegerEnv,
  readBoundedNumberEnv,
  runBoundedLoad,
  summarizeDurations,
} from "./load-profile.util.js";

const ENV_KEYS = ["TEST_LOAD_INTEGER", "TEST_LOAD_NUMBER"] as const;

describe("load profile utilities", () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("bounds concurrent operations while preserving indexed results", async () => {
    let active = 0;
    let peak = 0;

    const results = await runBoundedLoad({ total: 12, concurrency: 3 }, async (index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return `value-${index}`;
    });

    expect(peak).toBe(3);
    expect(results).toHaveLength(12);
    expect(results.map((result) => result.index)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect(results.map((result) => result.value)).toEqual(
      Array.from({ length: 12 }, (_, index) => `value-${index}`),
    );
    expect(results.every((result) => result.durationMs >= 4)).toBe(true);
  });

  it("captures individual operation failures without abandoning sibling work", async () => {
    const results = await runBoundedLoad({ total: 5, concurrency: 2 }, async (index) => {
      if (index === 2) {
        throw new Error("expected failure");
      }
      return index;
    });

    expect(results).toHaveLength(5);
    expect(results[2]).toMatchObject({ index: 2, error: "expected failure" });
    expect(results.filter((result) => result.value !== undefined)).toHaveLength(4);
  });

  it("calculates nearest-rank latency percentiles", () => {
    expect(summarizeDurations([100, 10, 90, 20, 80, 30, 70, 40, 60, 50])).toEqual({
      minMs: 10,
      p50Ms: 50,
      p95Ms: 100,
      p99Ms: 100,
      maxMs: 100,
    });
  });

  it("validates load dimensions and target rate", async () => {
    await expect(
      runBoundedLoad({ total: 2, concurrency: 3 }, async () => undefined),
    ).rejects.toThrow("concurrency cannot exceed total");
    await expect(
      runBoundedLoad({ total: 2, concurrency: 1, targetRatePerSecond: -1 }, async () => undefined),
    ).rejects.toThrow("targetRatePerSecond must be a non-negative finite number");
  });

  it("reads bounded integer and number environment configuration", () => {
    expect(readBoundedIntegerEnv("TEST_LOAD_INTEGER", 5, 1, 10)).toBe(5);
    expect(readBoundedNumberEnv("TEST_LOAD_NUMBER", 0, 0, 1)).toBe(0);

    process.env.TEST_LOAD_INTEGER = "8";
    process.env.TEST_LOAD_NUMBER = "0.25";
    expect(readBoundedIntegerEnv("TEST_LOAD_INTEGER", 5, 1, 10)).toBe(8);
    expect(readBoundedNumberEnv("TEST_LOAD_NUMBER", 0, 0, 1)).toBe(0.25);

    process.env.TEST_LOAD_INTEGER = "11";
    process.env.TEST_LOAD_NUMBER = "2";
    expect(() => readBoundedIntegerEnv("TEST_LOAD_INTEGER", 5, 1, 10)).toThrow(
      "TEST_LOAD_INTEGER must be an integer between 1 and 10",
    );
    expect(() => readBoundedNumberEnv("TEST_LOAD_NUMBER", 0, 0, 1)).toThrow(
      "TEST_LOAD_NUMBER must be a number between 0 and 1",
    );
  });
});
