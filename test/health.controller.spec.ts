import { jest } from "@jest/globals";
import { HttpException, HttpStatus } from "@nestjs/common";
import { HealthController } from "../src/health/health.controller.js";

const live = jest.fn();
const ready = jest.fn();
const controller = new HealthController({ live, ready } as never);

describe("HealthController", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    live.mockReturnValue({ status: "ok", uptimeSeconds: 10, timestamp: "2026-09-09T20:00:00.000Z" });
  });

  it("keeps the legacy health route as process-only liveness", () => {
    expect(controller.getHealth()).toEqual({
      status: "ok",
      uptimeSeconds: 10,
      timestamp: "2026-09-09T20:00:00.000Z",
    });
    expect(live).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  });

  it("returns a ready dependency report without changing the status", async () => {
    const report = {
      status: "ready",
      dependencies: {
        postgres: { status: "up", durationMs: 1 },
        redis: { status: "up", durationMs: 2 },
        rabbitmq: { status: "up", durationMs: 3 },
      },
      timestamp: "2026-09-09T20:00:00.000Z",
    };
    ready.mockResolvedValue(report);

    await expect(controller.ready()).resolves.toEqual(report);
  });

  it("raises HTTP 503 with the dependency report when readiness fails", async () => {
    const report = {
      status: "not_ready",
      dependencies: {
        postgres: { status: "up", durationMs: 1 },
        redis: { status: "down", durationMs: 2, error: "unavailable" },
        rabbitmq: { status: "up", durationMs: 3 },
      },
      timestamp: "2026-09-09T20:00:00.000Z",
    };
    ready.mockResolvedValue(report);

    try {
      await controller.ready();
      throw new Error("Expected readiness to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(exception.getResponse()).toEqual(report);
    }
  });
});
