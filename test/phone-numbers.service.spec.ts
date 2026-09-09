import { jest } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import { PhoneNumbersService } from "../src/phone-numbers/phone-numbers.service.js";

const TENANT_ID = "123e4567-e89b-12d3-a456-426614174000";
const SENDER_ID = "a5f4b844-1d12-437f-b7e5-702dd592da9d";
const FALLBACK_ID = "7db64b92-0761-4bc8-a7ca-3f24cf6ca55a";

describe("PhoneNumbersService", () => {
  const providerFindUnique = jest.fn();
  const rootFindMany = jest.fn();
  const transactionFindFirst = jest.fn();
  const transactionUpdateMany = jest.fn();
  const transactionCreate = jest.fn();
  const transactionUpdate = jest.fn();
  const transactionFindUniqueOrThrow = jest.fn();

  const transactionClient = {
    whatsAppPhoneNumber: {
      findFirst: transactionFindFirst,
      updateMany: transactionUpdateMany,
      create: transactionCreate,
      update: transactionUpdate,
      findUniqueOrThrow: transactionFindUniqueOrThrow,
    },
  };

  const runTransaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
  );

  const service = new PhoneNumbersService({
    whatsAppPhoneNumber: {
      findUnique: providerFindUnique,
      findMany: rootFindMany,
    },
    $transaction: runTransaction,
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    providerFindUnique.mockResolvedValue(null);
    transactionUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("forces the first active sender to become the tenant default", async () => {
    transactionFindFirst.mockResolvedValueOnce(null);
    transactionCreate.mockResolvedValue({
      id: SENDER_ID,
      tenantId: TENANT_ID,
      providerPhoneNumberId: "27681414235104944",
      isDefault: true,
      active: true,
    });

    await service.create(TENANT_ID, {
      providerPhoneNumberId: "27681414235104944",
      credentialRef: "env:META_ACME_WHATSAPP_TOKEN",
      isDefault: false,
    });

    expect(transactionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        providerPhoneNumberId: "27681414235104944",
        isDefault: true,
      }),
    });
  });

  it("promotes another active sender when the current default is disabled", async () => {
    transactionFindFirst
      .mockResolvedValueOnce({
        id: SENDER_ID,
        tenantId: TENANT_ID,
        active: true,
        isDefault: true,
        createdAt: new Date("2026-09-08T10:00:00.000Z"),
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: FALLBACK_ID });

    transactionUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      tenantId: TENANT_ID,
      active: data.active ?? true,
      isDefault: data.isDefault ?? true,
    }));
    transactionFindUniqueOrThrow.mockResolvedValue({
      id: SENDER_ID,
      tenantId: TENANT_ID,
      active: false,
      isDefault: false,
    });

    await service.update(TENANT_ID, SENDER_ID, { active: false });

    expect(transactionUpdate).toHaveBeenCalledWith({
      where: { id: FALLBACK_ID },
      data: { isDefault: true },
    });
  });

  it("fails closed when one WABA is associated with more than one tenant", async () => {
    rootFindMany.mockResolvedValue([
      { tenantId: "tenant-a" },
      { tenantId: "tenant-a" },
      { tenantId: "tenant-b" },
    ]);

    await expect(service.findTenantIdByWabaId("waba-shared")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
