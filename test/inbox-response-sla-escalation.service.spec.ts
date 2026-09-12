import { jest } from "@jest/globals";
import { InboxResponseSlaEscalationService } from "../src/inbox/inbox-response-sla-escalation.service.js";

const INTERVAL_ENV = "INBOX_SLA_ESCALATION_INTERVAL_MS";

describe("InboxResponseSlaEscalationService", () => {
  const queryRaw = jest.fn();
  const service = new InboxResponseSlaEscalationService({ $queryRaw: queryRaw } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[INTERVAL_ENV];
    queryRaw.mockResolvedValue([]);
  });

  afterEach(() => {
    service.onModuleDestroy();
    delete process.env[INTERVAL_ENV];
  });

  it("returns the number of overdue SLA cycles claimed by the bounded scan", async () => {
    queryRaw.mockResolvedValue([
      { id: "conversation-1", tenantId: "tenant-1" },
      { id: "conversation-2", tenantId: "tenant-2" },
    ]);

    await expect(service.escalateOverdue(new Date("2026-09-12T12:00:00.000Z"))).resolves.toBe(2);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("runs an initial scan before scheduling periodic escalation", async () => {
    process.env[INTERVAL_ENV] = "5000";

    await service.onApplicationBootstrap();

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsafe escalation interval before scanning", async () => {
    process.env[INTERVAL_ENV] = "4999";

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      "INBOX_SLA_ESCALATION_INTERVAL_MS must be an integer between 5000 and 3600000",
    );
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
