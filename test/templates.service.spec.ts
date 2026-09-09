import { jest } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import { TemplatesService } from "../src/templates/templates.service.js";

describe("TemplatesService", () => {
  const rootFindFirst = jest.fn();
  const transactionUpsert = jest.fn();
  const transactionUpdateMany = jest.fn();
  const runTransaction = jest.fn(
    async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        messageTemplate: {
          upsert: transactionUpsert,
          updateMany: transactionUpdateMany,
        },
      }),
  );
  const listTemplates = jest.fn();

  const service = new TemplatesService(
    {
      messageTemplate: { findFirst: rootFindFirst },
      $transaction: runTransaction,
    } as never,
    { listTemplates } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    transactionUpsert.mockResolvedValue({});
    transactionUpdateMany.mockResolvedValue({ count: 2 });
  });

  it("synchronizes provider templates and marks missing local templates deleted", async () => {
    listTemplates.mockResolvedValue({
      wabaId: "waba-1",
      senderId: "sender-1",
      templates: [
        {
          id: "provider-template-1",
          name: "order_confirmation",
          language: "en_US",
          status: "APPROVED",
          category: "UTILITY",
          components: [{ type: "BODY", text: "Order {{1}} confirmed" }],
          raw: { id: "provider-template-1", status: "APPROVED" },
        },
      ],
    });
    rootFindFirst.mockResolvedValue(null);

    const result = await service.sync("tenant-1", { senderId: "sender-1" });

    expect(transactionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_wabaId_name_language: {
            tenantId: "tenant-1",
            wabaId: "waba-1",
            name: "order_confirmation",
            language: "en_US",
          },
        },
      }),
    );
    expect(transactionUpdateMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        wabaId: "waba-1",
        status: { not: "DELETED" },
        providerTemplateId: { notIn: ["provider-template-1"] },
      },
      data: expect.objectContaining({ status: "DELETED" }),
    });
    expect(result).toEqual(
      expect.objectContaining({
        wabaId: "waba-1",
        senderId: "sender-1",
        synced: 1,
        markedDeleted: 2,
      }),
    );
  });

  it("rejects outbound use when the template is not locally approved", async () => {
    rootFindFirst.mockResolvedValue(null);

    await expect(
      service.assertApproved("tenant-1", "waba-1", {
        name: "promo",
        language: "en_US",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(rootFindFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        wabaId: "waba-1",
        name: "promo",
        language: "en_US",
        status: "APPROVED",
      },
    });
  });
});
