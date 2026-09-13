import { jest } from "@jest/globals";
import { OperationalHealthService } from "../src/health/operational-health.service.js";
import { APP_VERSION } from "../src/version.js";

describe("OperationalHealthService", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalRabbitMqUrl = process.env.RABBITMQ_URL;
  const originalAppRevision = process.env.APP_REVISION;
  const diagnostics = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    diagnostics.mockResolvedValue({ status: "up", mode: "disabled" });
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
    if (originalRabbitMqUrl === undefined) {
      delete process.env.RABBITMQ_URL;
    } else {
      process.env.RABBITMQ_URL = originalRabbitMqUrl;
    }
    if (originalAppRevision === undefined) {
      delete process.env.APP_REVISION;
    } else {
      process.env.APP_REVISION = originalAppRevision;
    }
  });

  it("reports process liveness and safe build identity without touching external dependencies", () => {
    delete process.env.REDIS_URL;
    delete process.env.RABBITMQ_URL;
    process.env.APP_REVISION = "fc15a222-test";
    const queryRaw = jest.fn();
    const service = new OperationalHealthService(
      { $queryRaw: queryRaw } as never,
      { diagnostics } as never,
    );

    const report = service.live();

    expect(report.status).toBe("ok");
    expect(report.version).toBe(APP_VERSION);
    expect(report.revision).toBe("fc15a222-test");
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("does not expose unsafe deployment revisions", () => {
    process.env.APP_REVISION = "unsafe revision with spaces";
    const service = new OperationalHealthService(
      { $queryRaw: jest.fn() } as never,
      { diagnostics } as never,
    );

    expect(service.live()).not.toHaveProperty("revision");
  });

  it("reports missing Redis and RabbitMQ configuration as not ready while PostgreSQL and disabled storage are up", async () => {
    delete process.env.REDIS_URL;
    delete process.env.RABBITMQ_URL;
    const queryRaw = jest.fn().mockResolvedValue([{ ok: 1 }]);
    const service = new OperationalHealthService(
      { $queryRaw: queryRaw } as never,
      { diagnostics } as never,
    );

    const report = await service.ready();

    expect(report.status).toBe("not_ready");
    expect(report.dependencies.postgres.status).toBe("up");
    expect(report.dependencies.redis).toEqual(
      expect.objectContaining({ status: "down", error: "not_configured" }),
    );
    expect(report.dependencies.rabbitmq).toEqual(
      expect.objectContaining({ status: "down", error: "not_configured" }),
    );
    expect(report.dependencies.mediaStorage).toEqual({ status: "up", mode: "disabled" });
    expect(diagnostics).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });
});
