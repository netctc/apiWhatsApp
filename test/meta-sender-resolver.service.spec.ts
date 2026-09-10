import { jest } from "@jest/globals";
import { MetaSenderResolverService } from "../src/meta/meta-sender-resolver.service.js";

describe("MetaSenderResolverService", () => {
  const configGet = jest.fn();
  const findActiveById = jest.fn();
  const resolveForTenant = jest.fn();
  const service = new MetaSenderResolverService(
    { get: configGet } as never,
    { findActiveById, resolveForTenant } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves a tenant sender token from its environment secret reference", async () => {
    findActiveById.mockResolvedValue({
      id: "sender-1",
      providerPhoneNumberId: "27681414235104944",
      credentialRef: "env:META_ACME_WHATSAPP_TOKEN",
      rateLimitPerSecond: 80,
    });
    configGet.mockImplementation((name: string) =>
      name === "META_ACME_WHATSAPP_TOKEN" ? "tenant-token" : undefined,
    );

    await expect(service.resolve("sender-1")).resolves.toEqual({
      internalSenderId: "sender-1",
      phoneNumberId: "27681414235104944",
      accessToken: "tenant-token",
      rateLimitPerSecond: 80,
    });
  });

  it("resolves interactive provider access only through tenant ownership", async () => {
    resolveForTenant.mockResolvedValue({
      id: "sender-tenant-1",
      providerPhoneNumberId: "27681414235104944",
      credentialRef: "env:META_ACME_WHATSAPP_TOKEN",
      rateLimitPerSecond: 75,
    });
    configGet.mockImplementation((name: string) =>
      name === "META_ACME_WHATSAPP_TOKEN" ? "tenant-token" : undefined,
    );

    await expect(service.resolveForTenant("tenant-1", "sender-tenant-1")).resolves.toEqual({
      internalSenderId: "sender-tenant-1",
      phoneNumberId: "27681414235104944",
      accessToken: "tenant-token",
      rateLimitPerSecond: 75,
    });
    expect(resolveForTenant).toHaveBeenCalledWith("tenant-1", "sender-tenant-1");
    expect(findActiveById).not.toHaveBeenCalled();
  });

  it("keeps the global Meta credentials as a legacy fallback for messages without senderId", async () => {
    configGet.mockImplementation((name: string) => ({
      META_WHATSAPP_PHONE_NUMBER_ID: "legacy-phone-id",
      META_WHATSAPP_ACCESS_TOKEN: "legacy-token",
    })[name]);

    await expect(service.resolve(null)).resolves.toEqual({
      phoneNumberId: "legacy-phone-id",
      accessToken: "legacy-token",
    });
    expect(findActiveById).not.toHaveBeenCalled();
  });

  it("fails closed when the referenced tenant secret is missing", async () => {
    findActiveById.mockResolvedValue({
      id: "sender-1",
      providerPhoneNumberId: "27681414235104944",
      credentialRef: "env:META_ACME_WHATSAPP_TOKEN",
      rateLimitPerSecond: null,
    });
    configGet.mockReturnValue(undefined);

    await expect(service.resolve("sender-1")).rejects.toThrow(
      "Meta credential env:META_ACME_WHATSAPP_TOKEN is not available",
    );
  });
});
