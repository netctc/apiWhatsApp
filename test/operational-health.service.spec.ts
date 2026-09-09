import { jest } from "@jest/globals";
import { OperationalHealthService } from "../src/health/operational-health.service.js";

describe("OperationalHealthService", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalRabbitMqUrl = process.env.RABBITMQ_URL;

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
  });

  it("reports process liveness without touching external dependencies", () => {
    delete process.env.REDIS_URL;
    delete process.env.RABBITMQ_URL;
    const queryRaw = jest.fn();
    const service = new OperationalHealthService({ $queryRaw: queryRaw } as never);

    const report = service.live();

    expect(report.status).toBe("ok");
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("reports missing Redis and RabbitMQ configuration as not ready while PostgreSQL is up", async () => {
    delete process.env.REDIS_URL;
    delete process.env.RABBITMQ_URL;
    const queryRaw = jest.fn().mockResolvedValue([{ ok: 1 }]);
    const service = new OperationalHealthService({ $queryRaw: queryRaw } as never);

    const report = await service.ready();

    expect(report.status).toBe("not_ready");
    expect(report.dependencies.postgres.status).toBe("up");
    expect(report.dependencies.redis).toEqual(
      expect.objectContaining({ status: "down", error: "not_configured" }),
    );
    expect(report.dependencies.rabbitmq).toEqual(
      expect.objectContaining({ status: "down", error: "not_configured" }),
    );

    await service.onModuleDestroy();
  });
});
