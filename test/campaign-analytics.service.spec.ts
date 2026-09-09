import { jest } from "@jest/globals";
import { NotFoundException } from "@nestjs/common";
import {
  CampaignRecipientStatus,
  CampaignStatus,
  MessageStatus,
} from "../src/generated/prisma/client.js";
import { CampaignAnalyticsService } from "../src/campaigns/campaign-analytics.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CAMPAIGN_ID = "0f4ee5b2-f6ec-4cb2-b245-5799d1b40dce";

describe("CampaignAnalyticsService", () => {
  const campaignFindFirst = jest.fn();
  const recipientGroupBy = jest.fn();
  const queryRaw = jest.fn();

  const service = new CampaignAnalyticsService({
    campaign: { findFirst: campaignFindFirst },
    campaignRecipient: { groupBy: recipientGroupBy },
    $queryRaw: queryRaw,
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    campaignFindFirst.mockResolvedValue({
      id: CAMPAIGN_ID,
      name: "VIP offer",
      status: CampaignStatus.COMPLETED,
      totalRecipients: 10,
      snapshotAt: new Date("2026-09-09T12:00:00.000Z"),
      startedAt: new Date("2026-09-09T12:00:01.000Z"),
      completedAt: new Date("2026-09-09T12:01:00.000Z"),
      cancelledAt: null,
      createdAt: new Date("2026-09-09T11:00:00.000Z"),
      updatedAt: new Date("2026-09-09T12:01:00.000Z"),
    });
    recipientGroupBy.mockResolvedValue([
      { status: CampaignRecipientStatus.QUEUED, _count: { _all: 8 } },
      { status: CampaignRecipientStatus.SKIPPED, _count: { _all: 1 } },
      { status: CampaignRecipientStatus.FAILED, _count: { _all: 1 } },
    ]);
    queryRaw
      .mockResolvedValueOnce([
        {
          created: 8,
          submitted: 8,
          sent: 7,
          delivered: 6,
          read: 3,
          failed: 1,
        },
      ])
      .mockResolvedValueOnce([
        { status: MessageStatus.READ, count: 3 },
        { status: MessageStatus.DELIVERED, count: 3 },
        { status: MessageStatus.SENT, count: 1 },
        { status: MessageStatus.FAILED, count: 1 },
      ]);
  });

  it("rejects access to a campaign outside the authenticated tenant", async () => {
    campaignFindFirst.mockResolvedValue(null);

    await expect(service.get(TENANT_ID, CAMPAIGN_ID)).rejects.toBeInstanceOf(NotFoundException);

    expect(recipientGroupBy).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("returns orchestration, cumulative delivery milestones, current status, and rates", async () => {
    const result = await service.get(TENANT_ID, CAMPAIGN_ID);

    expect(campaignFindFirst).toHaveBeenCalledWith({
      where: { id: CAMPAIGN_ID, tenantId: TENANT_ID },
      select: expect.objectContaining({ id: true, totalRecipients: true }),
    });
    expect(recipientGroupBy).toHaveBeenCalledWith({
      by: ["status"],
      where: { campaignId: CAMPAIGN_ID },
      _count: { _all: true },
    });

    expect(result.orchestration.snapshotRecipients).toBe(10);
    expect(result.orchestration.terminalRecipients).toBe(10);
    expect(result.orchestration.byStatus.PENDING).toBe(0);
    expect(result.orchestration.byStatus.QUEUED).toBe(8);
    expect(result.messages.milestones).toEqual({
      created: 8,
      submitted: 8,
      sent: 7,
      delivered: 6,
      read: 3,
      failed: 1,
    });
    expect(result.messages.currentStatus.READ).toBe(3);
    expect(result.messages.currentStatus.DELIVERED).toBe(3);
    expect(result.messages.currentStatus.QUEUED).toBe(0);
    expect(result.rates).toEqual({
      messageCreationRate: 80,
      submissionRate: 100,
      deliveryRate: 75,
      readRate: 50,
      failureRate: 12.5,
    });
    expect(result.consistency.snapshotMatchesStoredTotal).toBe(true);
    expect(result.generatedAt).toBeInstanceOf(Date);
  });

  it("returns null rates when a denominator does not exist", async () => {
    campaignFindFirst.mockResolvedValue({
      id: CAMPAIGN_ID,
      name: "Empty campaign",
      status: CampaignStatus.COMPLETED,
      totalRecipients: 0,
      snapshotAt: new Date(),
      startedAt: null,
      completedAt: new Date(),
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    recipientGroupBy.mockResolvedValue([]);
    queryRaw
      .mockReset()
      .mockResolvedValueOnce([
        { created: 0, submitted: 0, sent: 0, delivered: 0, read: 0, failed: 0 },
      ])
      .mockResolvedValueOnce([]);

    const result = await service.get(TENANT_ID, CAMPAIGN_ID);

    expect(result.rates).toEqual({
      messageCreationRate: null,
      submissionRate: null,
      deliveryRate: null,
      readRate: null,
      failureRate: null,
    });
  });
});
