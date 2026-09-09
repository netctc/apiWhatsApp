import { jest } from "@jest/globals";
import { SegmentsService } from "../src/segments/segments.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const API_KEY_ID = "123e4567-e89b-42d3-a456-426614174001";
const SEGMENT_ID = "123e4567-e89b-42d3-a456-426614174003";

describe("SegmentsService administrative audit", () => {
  const globalFindFirst = jest.fn();
  const segmentCreate = jest.fn();
  const auditCreate = jest.fn();
  const transactionClient = {
    contactSegment: { create: segmentCreate },
    auditLog: { create: auditCreate },
  };
  const transaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
  );

  const service = new SegmentsService({
    contactSegment: { findFirst: globalFindFirst },
    $transaction: transaction,
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    globalFindFirst.mockResolvedValue(null);
    segmentCreate.mockResolvedValue({
      id: SEGMENT_ID,
      tenantId: TENANT_ID,
      name: "VIP Renewals",
      description: "Internal audience",
      definition: {
        language: "en_US",
        tagsAny: ["vip", "renewal:2026"],
        tagsAll: ["marketing"],
      },
      active: true,
    });
    auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("audits segment creation using only criteria counts, not tag values", async () => {
    await service.create(
      { tenantId: TENANT_ID, apiKeyId: API_KEY_ID, scopes: [] },
      {
        name: " VIP Renewals ",
        description: " Internal audience ",
        definition: {
          language: "en_US",
          tagsAny: ["VIP", "renewal:2026"],
          tagsAll: ["Marketing"],
        },
      },
      { ipAddress: "203.0.113.20", userAgent: "segment-admin" },
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const audit = auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(audit.data).toEqual(
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorApiKeyId: API_KEY_ID,
        action: "contact_segment.created",
        entityType: "ContactSegment",
        entityId: SEGMENT_ID,
        ipAddress: "203.0.113.20",
        userAgent: "segment-admin",
        metadata: {
          name: "VIP Renewals",
          active: true,
          criteria: {
            languageConfigured: true,
            tagsAnyCount: 2,
            tagsAllCount: 1,
          },
        },
      }),
    );

    const serialized = JSON.stringify(audit.data);
    expect(serialized).not.toContain("renewal:2026");
    expect(serialized).not.toContain("marketing");
    expect(serialized).not.toContain("vip");
  });
});
