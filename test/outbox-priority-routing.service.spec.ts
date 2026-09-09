import { jest } from "@jest/globals";
import { MessageTrafficClass } from "../src/generated/prisma/client.js";
import { OutboxPublisherService } from "../src/outbox/outbox-publisher.service.js";

describe("OutboxPublisherService traffic routing", () => {
  const messageFindUnique = jest.fn();
  const outboxUpdate = jest.fn();
  const publishOutboundMessage = jest.fn();

  const service = new OutboxPublisherService(
    {
      message: { findUnique: messageFindUnique },
      outboxEvent: { update: outboxUpdate },
    } as never,
    { publishOutboundMessage } as never,
  );

  const privateService = service as unknown as {
    publish(
      eventId: string,
      eventType: string,
      aggregateId: string,
      payload: unknown,
      attempts: number,
    ): Promise<void>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    outboxUpdate.mockResolvedValue({});
    publishOutboundMessage.mockResolvedValue(undefined);
  });

  it("routes legacy outbox payloads using the persisted message class", async () => {
    messageFindUnique.mockResolvedValue({ trafficClass: MessageTrafficClass.OTP });

    await privateService.publish(
      "event-1",
      "message.outbound.requested",
      "message-1",
      { messageId: "message-1" },
      1,
    );

    expect(publishOutboundMessage).toHaveBeenCalledWith("message-1", MessageTrafficClass.OTP);
    expect(outboxUpdate).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: expect.objectContaining({
        processingLeaseUntil: null,
        lastError: null,
      }),
    });
  });

  it("does not publish when outbox JSON disagrees with the persisted class", async () => {
    messageFindUnique.mockResolvedValue({ trafficClass: MessageTrafficClass.MARKETING });

    await privateService.publish(
      "event-2",
      "message.outbound.requested",
      "message-2",
      { messageId: "message-2", trafficClass: MessageTrafficClass.OTP },
      1,
    );

    expect(publishOutboundMessage).not.toHaveBeenCalled();
    expect(outboxUpdate).toHaveBeenCalledWith({
      where: { id: "event-2" },
      data: expect.objectContaining({
        lastError: expect.stringContaining("does not match persisted message class MARKETING"),
        processingLeaseUntil: null,
      }),
    });
  });
});
