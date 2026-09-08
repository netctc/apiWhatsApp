import { jest } from "@jest/globals";
import { TenantStatus } from "../src/generated/prisma/client.js";
import { generateApiKey } from "../src/auth/api-key.util.js";
import { ApiKeysService } from "../src/auth/api-keys.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

describe("ApiKeysService", () => {
  const apiKeyFindUnique = jest.fn<() => Promise<unknown>>();
  const apiKeyUpdateMany = jest.fn<() => Promise<unknown>>();

  const prisma = {
    apiKey: {
      findUnique: apiKeyFindUnique,
      updateMany: apiKeyUpdateMany,
    },
  } as unknown as PrismaService;

  const service = new ApiKeysService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    apiKeyUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("authenticates an active tenant API key", async () => {
    const generated = generateApiKey();
    apiKeyFindUnique.mockResolvedValue({
      id: "81c8c5e6-98ad-4f1e-9025-024579f65c64",
      tenantId: "029bf3cb-46e7-4ca4-90f6-5acb9d22bb86",
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      scopes: ["messages:read", "messages:write"],
      lastUsedAt: new Date(),
      expiresAt: null,
      revokedAt: null,
      tenant: {
        status: TenantStatus.ACTIVE,
      },
    });

    await expect(service.authenticate(generated.rawKey)).resolves.toEqual({
      tenantId: "029bf3cb-46e7-4ca4-90f6-5acb9d22bb86",
      apiKeyId: "81c8c5e6-98ad-4f1e-9025-024579f65c64",
      scopes: ["messages:read", "messages:write"],
    });
    expect(apiKeyUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects a credential whose secret does not match the stored hash", async () => {
    const generated = generateApiKey();
    const another = generateApiKey();

    apiKeyFindUnique.mockResolvedValue({
      id: "4dc6399b-5800-4822-ac38-bdfb67d75c22",
      tenantId: "795f46aa-c74c-473e-a98f-f0e3519fb91f",
      keyPrefix: generated.keyPrefix,
      keyHash: another.keyHash,
      scopes: ["messages:read"],
      lastUsedAt: new Date(),
      expiresAt: null,
      revokedAt: null,
      tenant: { status: TenantStatus.ACTIVE },
    });

    await expect(service.authenticate(generated.rawKey)).resolves.toBeUndefined();
  });

  it.each([
    ["revoked", { revokedAt: new Date(), expiresAt: null, tenantStatus: TenantStatus.ACTIVE }],
    ["expired", { revokedAt: null, expiresAt: new Date(Date.now() - 1000), tenantStatus: TenantStatus.ACTIVE }],
    ["suspended tenant", { revokedAt: null, expiresAt: null, tenantStatus: TenantStatus.SUSPENDED }],
  ])("rejects a %s API key", async (_label, state) => {
    const generated = generateApiKey();
    apiKeyFindUnique.mockResolvedValue({
      id: "06605f50-91c4-4d65-918c-e43202bdc28f",
      tenantId: "b39c08f8-ac54-4513-9f7f-f1113f3af30e",
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      scopes: ["messages:read"],
      lastUsedAt: new Date(),
      expiresAt: state.expiresAt,
      revokedAt: state.revokedAt,
      tenant: { status: state.tenantStatus },
    });

    await expect(service.authenticate(generated.rawKey)).resolves.toBeUndefined();
  });

  it("rejects malformed API keys without querying the database", async () => {
    await expect(service.authenticate("invalid-key")).resolves.toBeUndefined();
    expect(apiKeyFindUnique).not.toHaveBeenCalled();
  });
});
