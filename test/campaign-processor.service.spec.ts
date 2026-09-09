import { jest } from "@jest/globals";
import { ForbiddenException } from "@nestjs/common";
import {
  CampaignRecipientStatus,
  CampaignStatus,
  ConsentStatus,
} from "../src/generated/prisma/client.js";
import { CampaignProcessorService } from "../src/campaigns/campaign-processor.service.js";
import { OutboundMessageType } from "../src/messages/dto/create-message.dto.js";

const CAMPAIGN_ID = "0f4ee5b2-f6ec-4cb2-b245-5799d1b40dce";
const RECIPIENT_ID = "fb49c090-f6c6-4ef0-831c-64db1034c7c8";
const CONTACT_ID = "76502a14-7dd9-4bf2-894e-ff7d477f40f0";
const SENDER_ID = "1b7d45aa-b4df-47d9-b130-8c454faaf74b";
const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const MESSAGE_ID = "57a83b6d-62c7-4674-a99c-bbc65a4cb9c1";

function claim() {
  return {
    id: RECIPIENT_ID,
    campaignId: CAMPAIGN_ID,
    contactId: CONTACT_ID,
    messageId: null,
    status: CampaignRecipientStatus.PROCESSING,
    attemptCount: 1,
    nextAttemptAt: new Date(),
    processingLeaseUntil: new Date("2026-09-09T16:30:30.000Z"),
    lastError: null,
    queuedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function loadedRecipient(
  consentStatus: ConsentStatus,
  templateStatus = "APPROVED",
  campaignStatus = CampaignStatus.RUNNING,
) {
  return {
    ...claim(),
    contact: {
      id: CONTACT_ID,
      phone: "+96170123456",
      name: "Jane Doe",
      language: "en_US",
      timezone: "Asia/Beirut",
      tags: ["vip"],
      metadata: { plan: "gold", points: 42 },
      consentStatus,
    },
    campaign: {
      id: CAMPAIGN_ID,
      tenantId: TENANT_ID,
      senderId: SENDER_ID,
      status: campaignStatus,
      failureReason: null,
      audience: { allOptedIn: true },
      components: [],
      sender: {
        id: SENDER_ID,
        active: true,
        wabaId: "waba-1",
      },
      template: {
        name: "promo_offer",
        language: "en_US",
        status: templateStatus,
        category: "MARKETING",
        wabaId: "waba-1",
      },
    },
  };
}

describe("CampaignProcessorService", () => {
  const queryRaw = jest.fn();
  const recipientFindUnique = jest.fn();
  const recipientUpdateMany = jest.fn();
  const campaignFindUnique = jest.fn();
  const campaignUpdateMany = jest.fn();
  const existingMessageFindFirst = jest.fn();
  const messageCreate = jest.fn();
  const failCampaign = jest.fn();
  const refreshStats = jest.fn();

  const service = new CampaignProcessorService(
    {
      $queryRaw: queryRaw,
      campaignRecipient: {
        findUnique: recipientFindUnique,
        updateMany: recipientUpdateMany,
      },
      campaign: {
        findUnique: campaignFindUnique,
        updateMany: campaignUpdateMany,
      },
      message: {
        findFirst: existingMessageFindFirst,
      },
    } as never,
    { create: messageCreate } as never,
    { failCampaign, refreshStats } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    queryRaw.mockResolvedValue([]);
    recipientUpdateMany.mockResolvedValue({ count: 1 });
    campaignUpdateMany.mockResolvedValue({ count: 0 });
    existingMessageFindFirst.mockResolvedValue(null);
    failCampaign.mockResolvedValue(true);
    refreshStats.mockResolvedValue(undefined);
  });

  it("reclaims expired PROCESSING recipients even after the campaign left RUNNING", async () => {
    const internal = service as unknown as {
      claimRecipients(batchSize: number): Promise<unknown[]>;
    };

    await internal.claimRecipients(25);

    const sql = queryRaw.mock.calls[0]?.[0] as { strings?: readonly string[] };
    const text = sql.strings?.join("") ?? "";
    expect(text).toContain("r.\"status\" = 'PENDING'");
    expect(text).toContain("c.\"status\" = 'RUNNING'");
    expect(text).toContain("r.\"status\" = 'PROCESSING'");
    expect(text).toContain("r.\"processingLeaseUntil\" <= NOW()");
    expect(text).toContain("FOR UPDATE OF r SKIP LOCKED");
  });

  it("maps a current consent-policy rejection to SKIPPED when no message exists", async () => {
    recipientFindUnique.mockResolvedValue(loadedRecipient(ConsentStatus.OPTED_OUT));
    messageCreate.mockRejectedValue(
      new ForbiddenException("Template messages require explicit contact opt-in"),
    );
    const internal = service as unknown as {
      processRecipient(recipient: ReturnType<typeof claim>): Promise<void>;
    };

    await internal.processRecipient(claim());

    expect(existingMessageFindFirst).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        idempotencyKey: `campaign:${CAMPAIGN_ID}:contact:${CONTACT_ID}`,
      },
      select: { id: true },
    });
    expect(messageCreate).toHaveBeenCalledTimes(1);
    expect(recipientUpdateMany).toHaveBeenCalledWith({
      where: {
        id: RECIPIENT_ID,
        status: CampaignRecipientStatus.PROCESSING,
        processingLeaseUntil: claim().processingLeaseUntil,
      },
      data: {
        status: CampaignRecipientStatus.SKIPPED,
        lastError: "Template messages require explicit contact opt-in",
        processingLeaseUntil: null,
      },
    });
  });

  it("links an already-created message before checking terminal campaign state or current consent", async () => {
    recipientFindUnique.mockResolvedValue(
      loadedRecipient(ConsentStatus.OPTED_OUT, "REJECTED", CampaignStatus.CANCELLED),
    );
    existingMessageFindFirst.mockResolvedValue({ id: MESSAGE_ID });
    const internal = service as unknown as {
      processRecipient(recipient: ReturnType<typeof claim>): Promise<void>;
    };

    await internal.processRecipient(claim());

    expect(messageCreate).not.toHaveBeenCalled();
    expect(failCampaign).not.toHaveBeenCalled();
    expect(recipientUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CampaignRecipientStatus.QUEUED,
          messageId: MESSAGE_ID,
        }),
      }),
    );
  });

  it("renders contact and metadata tokens before creating the message when explicitly enabled", async () => {
    const recipient = loadedRecipient(ConsentStatus.OPTED_IN);
    recipient.campaign.audience = { allOptedIn: true, personalizationEnabled: true };
    recipient.campaign.components = [
      {
        type: "body",
        parameters: [
          { type: "text", text: "{{contact.name}}" },
          { type: "text", text: "{{contact.metadata.plan}}" },
          { type: "text", text: "{{contact.metadata.points}}" },
        ],
      },
    ];
    recipientFindUnique.mockResolvedValue(recipient);
    messageCreate.mockResolvedValue({ id: MESSAGE_ID });
    const internal = service as unknown as {
      processRecipient(recipient: ReturnType<typeof claim>): Promise<void>;
    };

    await internal.processRecipient(claim());

    expect(messageCreate).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        payload: {
          name: "promo_offer",
          language: "en_US",
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: "Jane Doe" },
                { type: "text", text: "gold" },
                { type: "text", text: "42" },
              ],
            },
          ],
        },
      }),
    );
  });

  it("preserves token-like component strings when personalization is not enabled", async () => {
    const recipient = loadedRecipient(ConsentStatus.OPTED_IN);
    recipient.campaign.components = [
      {
        type: "body",
        parameters: [{ type: "text", text: "{{contact.name}}" }],
      },
    ];
    recipientFindUnique.mockResolvedValue(recipient);
    messageCreate.mockResolvedValue({ id: MESSAGE_ID });
    const internal = service as unknown as {
      processRecipient(recipient: ReturnType<typeof claim>): Promise<void>;
    };

    await internal.processRecipient(claim());

    expect(messageCreate).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        payload: expect.objectContaining({
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: "{{contact.name}}" }],
            },
          ],
        }),
      }),
    );
  });

  it("skips only the recipient when an enabled personalization value is missing", async () => {
    const recipient = loadedRecipient(ConsentStatus.OPTED_IN);
    recipient.campaign.audience = { allOptedIn: true, personalizationEnabled: true };
    recipient.contact.metadata = {};
    recipient.campaign.components = [
      {
        type: "body",
        parameters: [{ type: "text", text: "{{contact.metadata.plan}}" }],
      },
    ];
    recipientFindUnique.mockResolvedValue(recipient);
    const internal = service as unknown as {
      processRecipient(recipient: ReturnType<typeof claim>): Promise<void>;
    };

    await internal.processRecipient(claim());

    expect(messageCreate).not.toHaveBeenCalled();
    expect(failCampaign).not.toHaveBeenCalled();
    expect(recipientUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CampaignRecipientStatus.SKIPPED,
          lastError: "Missing personalization value for {{contact.metadata.plan}}",
        }),
      }),
    );
  });

  it("fails the campaign when the synchronized marketing template is no longer approved", async () => {
    recipientFindUnique.mockResolvedValue(
      loadedRecipient(ConsentStatus.OPTED_IN, "REJECTED"),
    );
    const internal = service as unknown as {
      processRecipient(recipient: ReturnType<typeof claim>): Promise<void>;
    };

    await internal.processRecipient(claim());

    expect(failCampaign).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      "Campaign template is no longer APPROVED (REJECTED)",
    );
    expect(messageCreate).not.toHaveBeenCalled();
    expect(recipientUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: CampaignRecipientStatus.FAILED }),
      }),
    );
  });

  it("uses one deterministic message idempotency key per campaign contact", async () => {
    recipientFindUnique.mockResolvedValue(loadedRecipient(ConsentStatus.OPTED_IN));
    messageCreate.mockResolvedValue({ id: MESSAGE_ID });
    const internal = service as unknown as {
      processRecipient(recipient: ReturnType<typeof claim>): Promise<void>;
    };

    await internal.processRecipient(claim());

    expect(messageCreate).toHaveBeenCalledWith(TENANT_ID, {
      to: "+96170123456",
      senderId: SENDER_ID,
      type: OutboundMessageType.TEMPLATE,
      idempotencyKey: `campaign:${CAMPAIGN_ID}:contact:${CONTACT_ID}`,
      payload: {
        name: "promo_offer",
        language: "en_US",
        components: [],
      },
    });
    expect(recipientUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          processingLeaseUntil: claim().processingLeaseUntil,
        }),
        data: expect.objectContaining({
          status: CampaignRecipientStatus.QUEUED,
          messageId: MESSAGE_ID,
        }),
      }),
    );
  });
});
