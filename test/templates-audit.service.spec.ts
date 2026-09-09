import { jest } from "@jest/globals";
import { TemplatesService } from "../src/templates/templates.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const API_KEY_ID = "123e4567-e89b-42d3-a456-426614174001";

describe("TemplatesService administrative audit", () => {
  const collisionFindFirst = jest.fn();
  const templateUpsert = jest.fn();
  const templateUpdateMany = jest.fn();
  const auditCreate = jest.fn();
  const transactionClient = {
    messageTemplate: {
      upsert: templateUpsert,
      updateMany: templateUpdateMany,
    },
    auditLog: { create: auditCreate },
  };
  const transaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
  );
  const listTemplates = jest.fn();

  const service = new TemplatesService(
    {
      messageTemplate: { findFirst: collisionFindFirst },
      $transaction: transaction,
    } as never,
    { listTemplates } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    collisionFindFirst.mockResolvedValue(null);
    templateUpsert.mockResolvedValue({});
    templateUpdateMany.mockResolvedValue({ count: 2 });
    auditCreate.mockResolvedValue({ id: "audit-1" });
    listTemplates.mockResolvedValue({
      wabaId: "waba-1",
      senderId: "sender-1",
      templates: [
        {
          id: "provider-template-1",
          name: "vip_offer",
          language: "en_US",
          status: "APPROVED",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Secret offer content" }],
          qualityScore: { score: "GREEN" },
          rejectionReason: undefined,
          raw: { name: "vip_offer", private_provider_field: "sensitive-provider-data" },
        },
        {
          id: "provider-template-2",
          name: "otp_login",
          language: "en_US",
          status: "PAUSED",
          category: "AUTHENTICATION",
          components: [{ type: "BODY", text: "OTP content" }],
          raw: { name: "otp_login" },
        },
      ],
    });
  });

  it("commits catalog mutation and a content-free audit summary in one DB transaction", async () => {
    const result = await service.sync(
      { tenantId: TENANT_ID, apiKeyId: API_KEY_ID, scopes: [] },
      { senderId: "sender-1" },
      { ipAddress: "203.0.113.30", userAgent: "template-admin" },
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(templateUpsert).toHaveBeenCalledTimes(2);
    expect(result.synced).toBe(2);
    expect(result.markedDeleted).toBe(2);

    const audit = auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(audit.data).toEqual(
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorApiKeyId: API_KEY_ID,
        action: "template_catalog.synced",
        entityType: "WhatsAppBusinessAccount",
        entityId: "waba-1",
        ipAddress: "203.0.113.30",
        userAgent: "template-admin",
        metadata: {
          synced: 2,
          markedDeleted: 2,
          statusCounts: { APPROVED: 1, PAUSED: 1 },
          categoryCounts: { MARKETING: 1, AUTHENTICATION: 1 },
        },
      }),
    );

    const serialized = JSON.stringify(audit.data);
    expect(serialized).not.toContain("vip_offer");
    expect(serialized).not.toContain("otp_login");
    expect(serialized).not.toContain("Secret offer content");
    expect(serialized).not.toContain("sensitive-provider-data");
  });
});
