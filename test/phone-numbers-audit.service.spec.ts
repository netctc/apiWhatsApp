import { jest } from "@jest/globals";
import { PhoneNumbersService } from "../src/phone-numbers/phone-numbers.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const API_KEY_ID = "123e4567-e89b-42d3-a456-426614174001";
const SENDER_ID = "123e4567-e89b-42d3-a456-426614174002";

describe("PhoneNumbersService administrative audit", () => {
  const globalFindUnique = jest.fn();
  const globalFindFirst = jest.fn();
  const txFindFirst = jest.fn();
  const txUpdateMany = jest.fn();
  const txCreate = jest.fn();
  const auditCreate = jest.fn();
  const transactionClient = {
    whatsAppPhoneNumber: {
      findFirst: txFindFirst,
      updateMany: txUpdateMany,
      create: txCreate,
    },
    auditLog: { create: auditCreate },
  };
  const transaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
  );

  const service = new PhoneNumbersService({
    whatsAppPhoneNumber: {
      findUnique: globalFindUnique,
      findFirst: globalFindFirst,
    },
    $transaction: transaction,
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    globalFindUnique.mockResolvedValue(null);
    globalFindFirst.mockResolvedValue(null);
    txFindFirst.mockResolvedValue(null);
    txUpdateMany.mockResolvedValue({ count: 0 });
    txCreate.mockResolvedValue({
      id: SENDER_ID,
      tenantId: TENANT_ID,
      providerPhoneNumberId: "1234567890",
      wabaId: "waba-1",
      displayPhoneNumber: "+961 70 111 222",
      verifiedName: "Acme",
      credentialRef: "env:META_SUPER_SECRET_TOKEN",
      rateLimitPerSecond: 75,
      active: true,
      isDefault: true,
    });
    auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("commits a safe audit event in the same transaction as sender creation", async () => {
    await service.create(
      { tenantId: TENANT_ID, apiKeyId: API_KEY_ID, scopes: [] },
      {
        providerPhoneNumberId: "1234567890",
        wabaId: "waba-1",
        displayPhoneNumber: "+961 70 111 222",
        verifiedName: "Acme",
        credentialRef: "env:META_SUPER_SECRET_TOKEN",
        rateLimitPerSecond: 75,
        isDefault: true,
      },
      { ipAddress: "203.0.113.10", userAgent: "integration-admin" },
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const audit = auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(audit.data).toEqual(
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorApiKeyId: API_KEY_ID,
        action: "whatsapp_phone_number.created",
        entityType: "WhatsAppPhoneNumber",
        entityId: SENDER_ID,
        ipAddress: "203.0.113.10",
        userAgent: "integration-admin",
      }),
    );

    const serialized = JSON.stringify(audit.data);
    expect(serialized).not.toContain("META_SUPER_SECRET_TOKEN");
    expect(serialized).not.toContain("+961 70 111 222");
    expect(serialized).not.toContain("credentialRef");
  });

  it("keeps legacy/internal tenant-id calls compatible without fabricating an audit actor", async () => {
    await service.create(TENANT_ID, {
      providerPhoneNumberId: "1234567890",
      credentialRef: "env:META_SUPER_SECRET_TOKEN",
    });

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
