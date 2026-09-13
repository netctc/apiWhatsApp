import { spawn } from "node:child_process";

interface SchedulerProbe {
  noCatchUp: {
    starts: Array<number | null>;
    sleeps: number[];
  };
  deadline: Array<number | null>;
  earlyWake: {
    starts: Array<number | null>;
    sleeps: number[];
  };
}

async function probeScheduler(): Promise<SchedulerProbe> {
  const source = `
    import { resolve } from "node:path";
    import { pathToFileURL } from "node:url";

    const schedulerUrl = pathToFileURL(resolve("scripts/external-capacity-scheduler.mjs")).href;
    const { createMonotonicStartGate } = await import(schedulerUrl);

    let now = 0;
    const sleeps = [];
    const gate = createMonotonicStartGate({
      targetRatePerSecond: 10,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    const starts = [await gate(), await gate()];
    now = 450;
    starts.push(await gate(), await gate());

    now = 0;
    const deadlineGate = createMonotonicStartGate({
      targetRatePerSecond: 10,
      deadlineAtMs: 250,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const deadline = [
      await deadlineGate(),
      await deadlineGate(),
      await deadlineGate(),
      await deadlineGate(),
    ];

    let earlyNow = 0;
    let wokeEarly = false;
    const earlySleeps = [];
    const earlyGate = createMonotonicStartGate({
      targetRatePerSecond: 4,
      deadlineAtMs: 1000,
      now: () => earlyNow,
      sleep: async (ms) => {
        earlySleeps.push(ms);
        if (!wokeEarly && ms > 1) {
          earlyNow += ms - 0.5;
          wokeEarly = true;
          return;
        }
        earlyNow += ms;
      },
    });
    const earlyStarts = [
      await earlyGate(),
      await earlyGate(),
      await earlyGate(),
      await earlyGate(),
      await earlyGate(),
    ];

    process.stdout.write(JSON.stringify({
      noCatchUp: { starts, sleeps },
      deadline,
      earlyWake: { starts: earlyStarts, sleeps: earlySleeps },
    }));
  `;

  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
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

  if (code !== 0) {
    throw new Error(`Scheduler probe failed with code ${code}: ${stderr}`);
  }
  return JSON.parse(stdout) as SchedulerProbe;
}

describe("external capacity scheduler", () => {
  it("keeps monotonic no-catch-up pacing and enforces the deadline", async () => {
    const result = await probeScheduler();

    expect(result.noCatchUp.starts).toEqual([0, 100, 450, 550]);
    expect(result.noCatchUp.sleeps).toEqual([100, 100]);
    expect(result.deadline).toEqual([0, 100, 200, null]);
  });

  it("does not start early when the timer wakes before the scheduled slot", async () => {
    const result = await probeScheduler();
    const completedStarts = result.earlyWake.starts.slice(0, 4) as number[];

    expect(result.earlyWake.starts[4]).toBeNull();
    expect(completedStarts).toHaveLength(4);
    expect(completedStarts[0]).toBe(0);
    for (let index = 1; index < completedStarts.length; index += 1) {
      expect(completedStarts[index] - completedStarts[index - 1]).toBeGreaterThanOrEqual(250);
    }
    expect(result.earlyWake.sleeps.length).toBeGreaterThanOrEqual(4);
  });
});
