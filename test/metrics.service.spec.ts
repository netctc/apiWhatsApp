import { jest } from "@jest/globals";
import {
  CampaignRecipientStatus,
  CampaignStatus,
  MessageStatus,
} from "../src/generated/prisma/client.js";
import { MetricsService } from "../src/observability/metrics.service.js";

describe("MetricsService", () => {
  const messageGroupBy = jest.fn();
  const campaignGroupBy = jest.fn();
  const recipientGroupBy = jest.fn();
  const queryRaw = jest.fn();

  const service = new MetricsService({
    message: { groupBy: messageGroupBy },
    campaign: { groupBy: campaignGroupBy },
    campaignRecipient: { groupBy: recipientGroupBy },
    $queryRaw: queryRaw,
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    messageGroupBy.mockResolvedValue([
      { status: MessageStatus.QUEUED, _count: { _all: 4 } },
      { status: MessageStatus.DELIVERED, _count: { _all: 6 } },
    ]);
    campaignGroupBy.mockResolvedValue([
      { status: CampaignStatus.RUNNING, _count: { _all: 2 } },
    ]);
    recipientGroupBy.mockResolvedValue([
      { status: CampaignRecipientStatus.PENDING, _count: { _all: 8 } },
    ]);
    queryRaw
      .mockResolvedValueOnce([
        { pending: 3, due: 2, leased: 1, oldestPendingAgeSeconds: 120 },
      ])
      .mockResolvedValueOnce([
        { pending: 5, due: 4, leased: 1, oldestPendingAgeSeconds: 60 },
      ]);
  });

  it("exports bounded HTTP labels and durable global backlog gauges", async () => {
    service.recordHttp("get", "MessagesController", "findById", 200, 0.02);
    service.recordHttp("get", "MessagesController", "findById", 500, 0.3);

    const output = await service.render();

    expect(output).toContain(
      'api_whatsapp_http_requests_total{method="GET",controller="MessagesController",handler="findById",status_code="200"} 1',
    );
    expect(output).toContain(
      'api_whatsapp_http_request_duration_seconds_bucket{method="GET",controller="MessagesController",handler="findById",status_code="200",le="0.025"} 1',
    );
    expect(output).toContain('api_whatsapp_messages{status="QUEUED"} 4');
    expect(output).toContain('api_whatsapp_messages{status="FAILED"} 0');
    expect(output).toContain('api_whatsapp_campaigns{status="RUNNING"} 2');
    expect(output).toContain('api_whatsapp_campaign_recipients{status="PENDING"} 8');
    expect(output).toContain("api_whatsapp_outbox_pending 3");
    expect(output).toContain("api_whatsapp_outbox_due 2");
    expect(output).toContain("api_whatsapp_outbox_oldest_pending_age_seconds 120");
    expect(output).toContain("api_whatsapp_webhook_pending 5");
    expect(output).toContain("api_whatsapp_webhook_oldest_pending_age_seconds 60");

    expect(output).not.toContain("tenantId");
    expect(output).not.toContain("phone");
    expect(output).not.toContain("messageId");
    expect(output).not.toContain("/api/v1/messages/");
  });
});
