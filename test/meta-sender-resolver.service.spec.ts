import { jest } from "@jest/globals";
import { MetaSenderResolverService } from "../src/meta/meta-sender-resolver.service.js";
import { SecretReferenceError } from "../src/meta/secret-reference.service.js";

describe("MetaSenderResolverService", () => {
  const configGet = jest.fn();
  const findActiveById = jest.fn();
  const resolveForTenant = jest.fn();
  const resolveWabaForTenant = jest.fn();
  const secretResolve = jest.fn();
  const service = new MetaSenderResolverService(
    { get: configGet } as never,
    { findActiveById, resolveForTenant, resolveWabaForTenant } as never,
    { resolve: secretResolve } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves a tenant sender token through its env: secret reference", async () => {
    findActiveById.mockResolvedValue({
      id: "sender-1",
      providerPhoneNumberId: "27681414235104944",
      credentialRef: "env:META_ACME_WHATSAPP_TOKEN",
      rateLimitPerSecond: 80,
    });
    secretResolve.mockResolvedValue("tenant-token");

    await expect(service.resolve("sender-1")).resolves.toEqual({
      internalSenderId: "sender-1",
      phoneNumberId: "27681414235104944",
      accessToken: "tenant-token",
      rateLimitPerSecond: 80,
    });
    expect(secretResolve).toHaveBeenCalledWith("env:META_ACME_WHATSAPP_TOKEN");
    expect(configGet).not.toHaveBeenCalled();
  });

  it("resolves file: references through the same tenant sender contract", async () => {
    resolveForTenant.mockResolvedValue({
      id: "sender-file-1",
      providerPhoneNumberId: "27681414235104945",
      credentialRef: "file:/run/secrets/api-whatsapp/acme-token",
      rateLimitPerSecond: 90,
    });
    secretResolve.mockResolvedValue("mounted-token");

    await expect(service.resolveForTenant("tenant-1", "sender-file-1")).resolves.toEqual({
      internalSenderId: "sender-file-1",
      phoneNumberId: "27681414235104945",
      accessToken: "mounted-token",
      rateLimitPerSecond: 90,
    });
    expect(resolveForTenant).toHaveBeenCalledWith("tenant-1", "sender-file-1");
    expect(secretResolve).toHaveBeenCalledWith(
      "file:/run/secrets/api-whatsapp/acme-token",
    );
    expect(findActiveById).not.toHaveBeenCalled();
  });

  it("resolves WABA access through the same secret reference abstraction", async () => {
    resolveWabaForTenant.mockResolvedValue({
      sender: {
        id: "sender-waba-1",
        credentialRef: "file:/run/secrets/api-whatsapp/waba-token",
      },
      wabaId: "8856996819413533",
    });
    secretResolve.mockResolvedValue("waba-mounted-token");

    await expect(service.resolveWaba("tenant-1", "sender-waba-1")).resolves.toEqual({
      internalSenderId: "sender-waba-1",
      wabaId: "8856996819413533",
      accessToken: "waba-mounted-token",
    });
    expect(secretResolve).toHaveBeenCalledWith(
      "file:/run/secrets/api-whatsapp/waba-token",
    );
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
    expect(secretResolve).not.toHaveBeenCalled();
  });

  it("fails closed when the referenced tenant secret is unavailable", async () => {
    findActiveById.mockResolvedValue({
      id: "sender-1",
      providerPhoneNumberId: "27681414235104944",
      credentialRef: "env:META_ACME_WHATSAPP_TOKEN",
      rateLimitPerSecond: null,
    });
    secretResolve.mockRejectedValue(
      new SecretReferenceError("NOT_CONFIGURED", "Referenced environment secret is unavailable"),
    );

    await expect(service.resolve("sender-1")).rejects.toMatchObject({
      name: "SecretReferenceError",
      reason: "NOT_CONFIGURED",
      message: "Referenced environment secret is unavailable",
    });
  });
});
