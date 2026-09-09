import { jest } from "@jest/globals";
import { MessageTrafficClass, MessageType } from "../src/generated/prisma/client.js";
import { OutboundMessageType } from "../src/messages/dto/create-message.dto.js";
import { MessagesService } from "../src/messages/messages.service.js";
import { TraceContextService } from "../src/observability/trace-context.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const MESSAGE_ID = "c1fb9904-1d5b-4b47-ab93-803c9c45c1f7";
const SENDER_ID = "a5f4b844-1d12-437f-b7e5-702dd592da9d";

describe("MessagesService trace propagation", () => {
  const messageFindFirst = jest.fn();
  const messageCreate = jest.fn();
  const outboxCreate = jest.fn();
  const assertAllowed = jest.fn();
  const resolveForTenant = jest.fn();
  const assertApproved = jest.fn();
  const trace = new TraceContextService();

  const transactionClient = {
    message: { create: messageCreate },
    outboxEvent: { create: outboxCreate },
  };
  const transaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
  );
  const service = new MessagesService(
    {
      message: { findFirst: messageFindFirst },
      $transaction: transaction,
    } as never,
    { assertAllowed } as never,
    { resolveForTenant } as never,
    { assertApproved } as never,
    trace,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    messageFindFirst.mockResolvedValue(null);
    messageCreate.mockResolvedValue({ id: MESSAGE_ID });
    outboxCreate.mockResolvedValue({ id: "outbox-1" });
    assertAllowed.mockResolvedValue(undefined);
    resolveForTenant.mockResolvedValue({ id: SENDER_ID, wabaId: "waba-1" });
  });

  it("stores the current request trace in the transactional outbox payload", async () => {
    const context = trace.createIncoming(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "req-123",
    );

    await trace.run(context, () =>
      service.create(TENANT_ID, {
        to: "+96170123456",
        type: OutboundMessageType.TEXT,
        payload: { text: "hello" },
      }),
    );

    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        senderId: SENDER_ID,
        type: MessageType.TEXT,
        trafficClass: MessageTrafficClass.TRANSACTIONAL,
      }),
    });
    expect(outboxCreate).toHaveBeenCalledWith({
      data: {
        aggregateType: "Message",
        aggregateId: MESSAGE_ID,
        eventType: "message.outbound.requested",
        payload: {
          messageId: MESSAGE_ID,
          trafficClass: MessageTrafficClass.TRANSACTIONAL,
          trace: {
            traceId: context.traceId,
            parentSpanId: context.spanId,
            traceFlags: context.traceFlags,
            requestId: context.requestId,
          },
        },
      },
    });
    expect(assertApproved).not.toHaveBeenCalled();
  });
});
