import { jest } from "@jest/globals";
import { ForbiddenException } from "@nestjs/common";
import { ApiKeysService } from "../src/api-keys/api-keys.service.js";
import { ApiScope } from "../src/auth/auth.constants.js";

describe("ApiKeysService", () => {
  const apiKeyCreate = jest.fn();
  const apiKeyFindFirst = jest.fn();
  const apiKeyUpdate = jest.fn();
  const auditCreate = jest.fn();

  const transactionClient = {
    apiKey: {
      create: apiKeyCreate,
      findFirst: apiKeyFindFirst,
      update: apiKeyUpdate,
    },
    auditLog: { create: auditCreate },
  };

  const runTransaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
  );
  const service = new ApiKeysService({
    $transaction: runTransaction,
    apiKey: { findMany: jest.fn() },
  } as never);

  const principal = {
    tenantId: "123e4567-e89b-12d3-a456-426614174000",
    apiKeyId: "1dd2cc1d-c7c8-4822-ab16-29700ee9d3d4",
    scopes: [ApiScope.API_KEYS_WRITE, ApiScope.MESSAGES_READ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.API_KEY_HASH_SECRET = "test-api-key-hash-secret-with-sufficient-length";
  });

  afterAll(() => {
    delete process.env.API_KEY_HASH_SECRET;
  });

  it("prevents delegated API keys from granting scopes they do not hold", async () => {
    await expect(
      service.create(principal, {}, {
        name: "escalated",
        scopes: [ApiScope.MESSAGES_WRITE],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("creates an allowed API key and audit record without persisting the raw key in audit metadata", async () => {
    apiKeyCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "c8631a6f-e850-42a2-9767-88d9357f2a8f",
      name: data.name,
      prefix: data.prefix,
      keyHash: data.keyHash,
      scopes: data.scopes,
      active: true,
      lastUsedAt: null,
      createdAt: new Date("2026-09-08T20:30:00.000Z"),
      revokedAt: null,
    }));
    auditCreate.mockResolvedValue({});

    const result = await service.create(
      principal,
      { ipAddress: "127.0.0.1", userAgent: "test" },
      { name: "reporting", scopes: [ApiScope.MESSAGES_READ] },
    );

    expect(result.apiKey).toMatch(/^wapi_[a-f0-9]{12}_[A-Za-z0-9_-]+$/);
    expect(result.key).toEqual(expect.objectContaining({
      name: "reporting",
      scopes: [ApiScope.MESSAGES_READ],
      active: true,
    }));

    const persisted = apiKeyCreate.mock.calls[0]?.[0];
    expect(persisted.data.keyHash).not.toBe(result.apiKey);

    const auditPayload = JSON.stringify(auditCreate.mock.calls[0]?.[0]);
    expect(auditPayload).not.toContain(result.apiKey);
    expect(auditPayload).not.toContain(String(persisted.data.keyHash));
    expect(auditPayload).toContain("api_key.created");
  });

  it("revokes a tenant API key and writes the audit event in the same transaction", async () => {
    apiKeyFindFirst.mockResolvedValue({
      id: "c8631a6f-e850-42a2-9767-88d9357f2a8f",
      tenantId: principal.tenantId,
      name: "reporting",
      prefix: "0123456789ab",
      keyHash: "hash",
      scopes: [ApiScope.MESSAGES_READ],
      active: true,
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
    });
    apiKeyUpdate.mockImplementation(async ({ data }: { data: { revokedAt: Date } }) => ({
      id: "c8631a6f-e850-42a2-9767-88d9357f2a8f",
      name: "reporting",
      prefix: "0123456789ab",
      scopes: [ApiScope.MESSAGES_READ],
      active: false,
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: data.revokedAt,
    }));
    auditCreate.mockResolvedValue({});

    const result = await service.revoke(principal, {}, "c8631a6f-e850-42a2-9767-88d9357f2a8f");

    expect(result.active).toBe(false);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: principal.tenantId,
        actorApiKeyId: principal.apiKeyId,
        action: "api_key.revoked",
        entityType: "ApiKey",
      }),
    });
  });
});
