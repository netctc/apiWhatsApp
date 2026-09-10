import { jest } from "@jest/globals";
import {
  CampaignRecipientStatus,
  CampaignStatus,
  MessageStatus,
  MessageTrafficClass,
} from "../src/generated/prisma/client.js";
import { OperationsService } from "../src/operations/operations.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("OperationsService", () => {
  const messageGroupBy = jest.fn();
  const campaignGroupBy = jest.fn();
  const recipientGroupBy = jest.fn();
  const queryRaw = jest.fn();

  const service = new OperationsService({
    message: { groupBy: messageGroupBy },
    campaign: { groupBy: campaignGroupBy },
    campaignRecipient: { groupBy: recipientGroupBy },
    $queryRaw: queryRaw,
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    messageGroupBy
      .mockResolvedValueOnce([
        { status: MessageStatus.QUEUED, _count: { _all: 4 } },
        { status: MessageStatus.DELIVERED, _count: { _all: 6 } },
      ])
      .mockResolvedValueOnce([
        { trafficClass: MessageTrafficClass.OTP, _count: { _all: 2 } },
        { trafficClass: MessageTrafficClass.MARKETING, _count: { _all: 5 } },
      ]);
    campaignGroupBy.mockResolvedValue([
      { status: CampaignStatus.RUNNING, _count: { _all: 1 } },
      { status: CampaignStatus.COMPLETED, _count: { _all: 3 } },
    ]);
    recipientGroupBy.mockResolvedValue([
      { status: CampaignRecipientStatus.PENDING, _count: { _all: 7 } },
      { status: CampaignRecipientStatus.QUEUED, _count: { _all: 12 } },
    ]);
    queryRaw
      .mockResolvedValueOnce([
        {
          pending: 3,
          due: 2,
          leased: 1,
          withErrors: 1,
          oldestPendingAgeSeconds: 45,
        },
      ])
      .mockResolvedValueOnce([
        {
          total: 8,
          providerUploaded: 6,
          failed: 2,
          expired: 1,
          retainedBinaries: 5,
          retainedBytes: 245760,
          expiringWithin24Hours: 3,
        },
      ]);
  });

  it("aggregates only the authenticated tenant operational state", async () => {
    const snapshot = await service.snapshot(TENANT_ID);

    expect(messageGroupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { tenantId: TENANT_ID } }),
    );
    expect(messageGroupBy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID }),
      }),
    );
    expect(campaignGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT_ID } }),
    );
    expect(recipientGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaign: { tenantId: TENANT_ID } } }),
    );
    expect(queryRaw).toHaveBeenCalledTimes(2);

    expect(snapshot.messages.total).toBe(10);
    expect(snapshot.messages.byStatus.QUEUED).toBe(4);
    expect(snapshot.messages.byStatus.DELIVERED).toBe(6);
    expect(snapshot.messages.byStatus.FAILED).toBe(0);
    expect(snapshot.messages.outboundByTrafficClass.OTP).toBe(2);
    expect(snapshot.messages.outboundByTrafficClass.MARKETING).toBe(5);
    expect(snapshot.campaigns.total).toBe(4);
    expect(snapshot.campaigns.byStatus.RUNNING).toBe(1);
    expect(snapshot.campaigns.recipientsByStatus.PENDING).toBe(7);
    expect(snapshot.outbox).toEqual({
      pending: 3,
      due: 2,
      leased: 1,
      withErrors: 1,
      oldestPendingAgeSeconds: 45,
    });
    expect(snapshot.mediaAssets).toEqual({
      total: 8,
      providerUploaded: 6,
      failed: 2,
      expired: 1,
      retainedBinaries: 5,
      retainedBytes: 245760,
      expiringWithin24Hours: 3,
    });
    expect(Number.isNaN(Date.parse(snapshot.generatedAt))).toBe(false);
  });
});
