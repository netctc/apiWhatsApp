import { createMonotonicStartGate } from "../scripts/external-capacity-scheduler.mjs";

describe("external capacity scheduler", () => {
  it("does not catch up missed pacing slots after a delay", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const gate = createMonotonicStartGate({
      targetRatePerSecond: 10,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await expect(gate()).resolves.toBe(0);
    await expect(gate()).resolves.toBe(100);

    now = 450;
    await expect(gate()).resolves.toBe(450);
    await expect(gate()).resolves.toBe(550);

    expect(sleeps).toEqual([100, 100]);
  });

  it("stops scheduling at the duration deadline", async () => {
    let now = 0;
    const gate = createMonotonicStartGate({
      targetRatePerSecond: 10,
      deadlineAtMs: 250,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(gate()).resolves.toBe(0);
    await expect(gate()).resolves.toBe(100);
    await expect(gate()).resolves.toBe(200);
    await expect(gate()).resolves.toBeNull();
  });
});
