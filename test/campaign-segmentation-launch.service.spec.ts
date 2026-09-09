import { jest } from "@jest/globals";
import { CampaignStatus, ConsentStatus } from "../src/generated/prisma/client.js";
import { CampaignsService } from "../src/campaigns/campaigns.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CAMPAIGN_ID = "0f4ee5b2-f6ec-4cb2-b245-5799d1b40dce";
const SEGMENT_ID = "f6e7b52b-03a2-4b13-84f9-f616de5d34f2";

const queryRaw = jest.fn();
const campaignFindFirst = jest.fn();
const contactFindMany = jest.fn();
const recipientCreateMany = jest.fn();
const campaignUpdate = jest.fn();
const resolveActiveForCampaign = jest.fn();

const transactionClient = {
  $queryRaw: queryRaw,
  campaign: {
    findFirst: campaignFindFirst,
    update: campaignUpdate,
  },
  contact: {
    findMany: contactFindMany,
  },
  campaignRecipient: {
    createMany: recipientCreateMany,
  },
};

const runTransaction = jest.fn(
  async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
);

const service = new CampaignsService(
  { $transaction: runTransaction } as never,
  {} as never,
  {} as never,
  { resolveActiveForCampaign } as never,
);

describe("Campaign tag segmentation launch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryRaw.mockResolvedValue([{ id: CAMPAIGN_ID }]);
    campaignFindFirst.mockResolvedValue({
      id: CAMPAIGN_ID,
      tenantId: TENANT_ID,
      status: CampaignStatus.DRAFT,
      audience: {
        allOptedIn: true,
        language: "en_US",
        tagsAny: ["renewal:2026", "vip"],
        tagsAll: ["marketing"],
      },
      snapshotAt: null,
      scheduledAt: null,
      sender: {
        active: true,
        wabaId: "waba-1",
      },
      template: {
        status: "APPROVED",
        category: "MARKETING",
        wabaId: "waba-1",
      },
    });
    contactFindMany.mockResolvedValue([]);
    recipientCreateMany.mockResolvedValue({ count: 0 });
    campaignUpdate.mockResolvedValue({
      id: CAMPAIGN_ID,
      status: CampaignStatus.COMPLETED,
    });
  });

  it("applies tenant, consent, language, hasSome, and hasEvery filters to the snapshot query", async () => {
    await service.launch(TENANT_ID, CAMPAIGN_ID);

    expect(contactFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        consentStatus: ConsentStatus.OPTED_IN,
        language: "en_US",
        tags: {
          hasSome: ["renewal:2026", "vip"],
          hasEvery: ["marketing"],
        },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 50001,
    });
  });

  it("uses the copied saved-segment definition without resolving the live segment again", async () => {
    campaignFindFirst.mockResolvedValue({
      id: CAMPAIGN_ID,
      tenantId: TENANT_ID,
      status: CampaignStatus.DRAFT,
      audience: {
        allOptedIn: false,
        segmentId: SEGMENT_ID,
        segmentName: "VIP renewals",
        segmentUpdatedAt: "2026-09-09T18:30:00.000Z",
        language: "fr_FR",
        tagsAll: ["vip"],
      },
      snapshotAt: null,
      scheduledAt: null,
      sender: {
        active: true,
        wabaId: "waba-1",
      },
      template: {
        status: "APPROVED",
        category: "MARKETING",
        wabaId: "waba-1",
      },
    });

    await service.launch(TENANT_ID, CAMPAIGN_ID);

    expect(resolveActiveForCampaign).not.toHaveBeenCalled();
    expect(contactFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        consentStatus: ConsentStatus.OPTED_IN,
        language: "fr_FR",
        tags: { hasEvery: ["vip"] },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 50001,
    });
  });
});
