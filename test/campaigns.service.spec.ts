import { jest } from "@jest/globals";
import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  CampaignRecipientStatus,
  CampaignStatus,
} from "../src/generated/prisma/client.js";
import { CampaignsService } from "../src/campaigns/campaigns.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CAMPAIGN_ID = "0f4ee5b2-f6ec-4cb2-b245-5799d1b40dce";
const TEMPLATE_ID = "31ee3b2f-5fbd-44bb-a4aa-b252a3a66c12";
const SENDER_ID = "1b7d45aa-b4df-47d9-b130-8c454faaf74b";

describe("CampaignsService", () => {
  const campaignCreate = jest.fn();
  const campaignFindFirst = jest.fn();
  const campaignUpdateMany = jest.fn();
  const recipientGroupBy = jest.fn();
  const recipientUpdateMany = jest.fn();
  const resolveForTenant = jest.fn();
  const templateFindById = jest.fn();

  const transactionClient = {
    campaign: {
      updateMany: jest.fn(),
    },
    campaignRecipient: {
      updateMany: jest.fn(),
    },
  };
  const transaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
  );

  const service = new CampaignsService(
    {
      campaign: {
        create: campaignCreate,
        findFirst: campaignFindFirst,
        updateMany: campaignUpdateMany,
      },
      campaignRecipient: {
        groupBy: recipientGroupBy,
        updateMany: recipientUpdateMany,
      },
      $transaction: transaction,
    } as never,
    { resolveForTenant } as never,
    { findById: templateFindById } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    resolveForTenant.mockResolvedValue({ id: SENDER_ID, wabaId: "waba-1", active: true });
    templateFindById.mockResolvedValue({
      id: TEMPLATE_ID,
      wabaId: "waba-1",
      status: "APPROVED",
      category: "MARKETING",
    });
    campaignCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: CAMPAIGN_ID,
      ...data,
    }));
  });

  it("requires an explicit audience mode and never defaults to all contacts", async () => {
    await expect(
      service.create(TENANT_ID, {
        name: "Promo",
        templateId: TEMPLATE_ID,
        audience: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.create(TENANT_ID, {
        name: "Promo",
        templateId: TEMPLATE_ID,
        audience: {
          allOptedIn: true,
          contactIds: ["76502a14-7dd9-4bf2-894e-ff7d477f40f0"],
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(resolveForTenant).not.toHaveBeenCalled();
    expect(campaignCreate).not.toHaveBeenCalled();
  });

  it("rejects a campaign name that becomes empty after trimming", async () => {
    await expect(
      service.create(TENANT_ID, {
        name: "   ",
        templateId: TEMPLATE_ID,
        audience: { allOptedIn: true },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(resolveForTenant).not.toHaveBeenCalled();
  });

  it("normalizes the campaign name and tag segmentation rules", async () => {
    await service.create(TENANT_ID, {
      name: "  September offer  ",
      templateId: TEMPLATE_ID,
      audience: {
        allOptedIn: true,
        language: " en_US ",
        tagsAny: ["VIP", "renewal:2026", "vip"],
        tagsAll: ["Marketing"],
      },
    });

    expect(campaignCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        senderId: SENDER_ID,
        templateId: TEMPLATE_ID,
        name: "September offer",
        audience: {
          allOptedIn: true,
          language: "en_US",
          tagsAny: ["renewal:2026", "vip"],
          tagsAll: ["marketing"],
        },
      }),
      include: expect.any(Object),
    });
  });

  it("rejects unsupported personalization before resolving the sender when personalization is enabled", async () => {
    await expect(
      service.create(TENANT_ID, {
        name: "Promo",
        templateId: TEMPLATE_ID,
        audience: { allOptedIn: true },
        personalizationEnabled: true,
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: "Hello {{contact.name}}" }],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(resolveForTenant).not.toHaveBeenCalled();
    expect(campaignCreate).not.toHaveBeenCalled();
  });

  it("keeps component strings static when personalization is not enabled", async () => {
    const components = [
      {
        type: "body",
        parameters: [{ type: "text", text: "Hello {{contact.name}}" }],
      },
    ];

    await service.create(TENANT_ID, {
      name: "Static braces",
      templateId: TEMPLATE_ID,
      audience: { allOptedIn: true },
      components,
    });

    expect(campaignCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        audience: { allOptedIn: true },
        components,
      }),
      include: expect.any(Object),
    });
  });

  it("persists personalization opt-in only when explicitly enabled", async () => {
    await service.create(TENANT_ID, {
      name: "Personalized promo",
      templateId: TEMPLATE_ID,
      audience: { allOptedIn: true },
      personalizationEnabled: true,
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "{{contact.name}}" }],
        },
      ],
    });

    expect(campaignCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        audience: {
          allOptedIn: true,
          personalizationEnabled: true,
        },
      }),
      include: expect.any(Object),
    });
  });

  it("terminalizes pending recipients only when the campaign actually transitions to FAILED", async () => {
    transactionClient.campaign.updateMany.mockResolvedValue({ count: 1 });
    transactionClient.campaignRecipient.updateMany.mockResolvedValue({ count: 3 });

    const transitioned = await service.failCampaign(CAMPAIGN_ID, "Template disabled");

    expect(transitioned).toBe(true);
    expect(transactionClient.campaignRecipient.updateMany).toHaveBeenCalledWith({
      where: {
        campaignId: CAMPAIGN_ID,
        status: CampaignRecipientStatus.PENDING,
      },
      data: {
        status: CampaignRecipientStatus.FAILED,
        processingLeaseUntil: null,
        lastError: "Template disabled",
      },
    });
  });

  it("does not fail pending recipients when another lifecycle transition wins the race", async () => {
    transactionClient.campaign.updateMany.mockResolvedValue({ count: 0 });

    const transitioned = await service.failCampaign(CAMPAIGN_ID, "Template disabled");

    expect(transitioned).toBe(false);
    expect(transactionClient.campaignRecipient.updateMany).not.toHaveBeenCalled();
  });

  it("completes only a campaign that is still RUNNING", async () => {
    recipientGroupBy.mockResolvedValue([
      { status: CampaignRecipientStatus.QUEUED, _count: { _all: 2 } },
      { status: CampaignRecipientStatus.SKIPPED, _count: { _all: 1 } },
    ]);
    campaignUpdateMany.mockResolvedValue({ count: 1 });

    await service.refreshStats(CAMPAIGN_ID);

    expect(campaignUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: CAMPAIGN_ID, status: CampaignStatus.RUNNING },
      data: {
        status: CampaignStatus.COMPLETED,
        completedAt: expect.any(Date),
      },
    });
  });

  it("does not let pause overwrite a campaign that concurrently became CANCELLED", async () => {
    campaignUpdateMany.mockResolvedValue({ count: 0 });
    campaignFindFirst.mockResolvedValue({ id: CAMPAIGN_ID, status: CampaignStatus.CANCELLED });

    await expect(service.pause(TENANT_ID, CAMPAIGN_ID)).rejects.toBeInstanceOf(ConflictException);

    expect(campaignUpdateMany).toHaveBeenCalledWith({
      where: {
        id: CAMPAIGN_ID,
        tenantId: TENANT_ID,
        status: { in: [CampaignStatus.RUNNING, CampaignStatus.SCHEDULED] },
      },
      data: { status: CampaignStatus.PAUSED },
    });
  });
});
