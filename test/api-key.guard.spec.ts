import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { TenantStatus } from "../src/generated/prisma/client.js";
import { ApiKeyGuard } from "../src/auth/api-key.guard.js";
import { hashApiKey } from "../src/auth/api-key.util.js";

interface TestRequest {
  headers: Record<string, string | undefined>;
  principal?: {
    tenantId: string;
    apiKeyId: string;
    scopes: string[];
  };
}

function createContext(request: TestRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => undefined,
      getNext: () => undefined,
    }),
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

describe("ApiKeyGuard", () => {
  const reflector = { getAllAndOverride: jest.fn() };
  const findUnique = jest.fn();
  const update = jest.fn();
  const prisma = { apiKey: { findUnique, update } };
  const guard = new ApiKeyGuard(reflector as never, prisma as never);

  beforeEach(() => {
    reflector.getAllAndOverride.mockReset();
    findUnique.mockReset();
    update.mockReset();
    process.env.API_KEY_HASH_SECRET = "test-server-secret-with-sufficient-length";
  });

  afterAll(() => {
    delete process.env.API_KEY_HASH_SECRET;
  });

  it("allows routes explicitly marked public without an API key", async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const request: TestRequest = { headers: {} };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects protected routes without an API key", async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const request: TestRequest = { headers: {} };

    await expect(guard.canActivate(createContext(request))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("attaches the server-side tenant and scopes for a valid active API key", async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const rawKey = "wapi_0123456789ab_example-secret";
    const request: TestRequest = { headers: { "x-api-key": rawKey } };
    const keyHash = hashApiKey(rawKey, process.env.API_KEY_HASH_SECRET!);

    findUnique.mockResolvedValue({
      id: "api-key-1",
      tenantId: "tenant-1",
      keyHash,
      active: true,
      revokedAt: null,
      lastUsedAt: new Date(),
      scopes: ["messages:read"],
      tenant: { status: TenantStatus.ACTIVE },
    });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { keyHash },
      include: { tenant: true },
    });
    expect(request.principal).toEqual({
      tenantId: "tenant-1",
      apiKeyId: "api-key-1",
      scopes: ["messages:read"],
    });
  });
});
