import { jest } from "@jest/globals";
import { TemplateStatusWebhookService } from "../src/webhooks/template-status-webhook.service.js";

describe("TemplateStatusWebhookService", () => {
  const findTenantIdByWabaId = jest.fn();
  const applyProviderStatusUpdate = jest.fn();
  const service = new TemplateStatusWebhookService(
    { findTenantIdByWabaId } as never,
    { applyProviderStatusUpdate } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    findTenantIdByWabaId.mockResolvedValue("tenant-1");
    applyProviderStatusUpdate.mockResolvedValue({});
  });

  it("routes message_template_status_update through the configured WABA tenant", async () => {
    await service.process({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "message_template_status_update",
              value: {
                event: "REJECTED",
                message_template_id: "123456789",
                message_template_name: "promo_offer",
                message_template_language: "en_US",
                reason: "Policy violation",
              },
            },
          ],
        },
      ],
    });

    expect(findTenantIdByWabaId).toHaveBeenCalledWith("waba-1");
    expect(applyProviderStatusUpdate).toHaveBeenCalledWith(
      "tenant-1",
      "waba-1",
      expect.objectContaining({
        providerTemplateId: "123456789",
        name: "promo_offer",
        language: "en_US",
        status: "REJECTED",
        rejectionReason: "Policy violation",
      }),
    );
  });

  it("ignores unrelated webhook fields", async () => {
    await service.process({
      entry: [{ id: "waba-1", changes: [{ field: "messages", value: {} }] }],
    });

    expect(findTenantIdByWabaId).not.toHaveBeenCalled();
    expect(applyProviderStatusUpdate).not.toHaveBeenCalled();
  });
});
