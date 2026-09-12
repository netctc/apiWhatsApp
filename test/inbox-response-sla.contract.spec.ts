import { jest } from "@jest/globals";
import { validate } from "class-validator";
import { MessageType } from "../src/generated/prisma/client.js";
import { CreateInboxTeamDto } from "../src/inbox/dto/create-inbox-team.dto.js";
import { UpdateInboxTeamDto } from "../src/inbox/dto/update-inbox-team.dto.js";
import { ConversationActivityService } from "../src/inbox/conversation-activity.service.js";

function renderSql(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "?";
  const candidate = value as { strings?: readonly string[]; values?: readonly unknown[] };
  if (!candidate.strings || !candidate.values) return "?";
  let result = candidate.strings[0] ?? "";
  for (let index = 0; index < candidate.values.length; index += 1) {
    const nested = candidate.values[index];
    result += renderSql(nested);
    result += candidate.strings[index + 1] ?? "";
  }
  return result;
}

describe("inbox response SLA contract", () => {
  it("validates nullable team SLA targets within one week", async () => {
    const validCreate = Object.assign(new CreateInboxTeamDto(), {
      name: "Support",
      responseSlaMinutes: 30,
    });
    const disabledUpdate = Object.assign(new UpdateInboxTeamDto(), {
      responseSlaMinutes: null,
    });
    const tooSmall = Object.assign(new UpdateInboxTeamDto(), {
      responseSlaMinutes: 0,
    });
    const tooLarge = Object.assign(new UpdateInboxTeamDto(), {
      responseSlaMinutes: 10081,
    });

    expect(await validate(validCreate)).toHaveLength(0);
    expect(await validate(disabledUpdate)).toHaveLength(0);
    expect(await validate(tooSmall)).not.toHaveLength(0);
    expect(await validate(tooLarge)).not.toHaveLength(0);
  });

  it("embeds monotonic inbound SLA-cycle admission in the atomic conversation upsert", async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ id: "conversation-1" }]);
    const service = new ConversationActivityService();

    await service.recordInbound(
      { $queryRaw: queryRaw } as never,
      {
        tenantId: "11111111-1111-4111-8111-111111111111",
        senderId: "22222222-2222-4222-8222-222222222222",
        contactId: "33333333-3333-4333-8333-333333333333",
        occurredAt: new Date("2026-09-12T08:00:00.000Z"),
      },
    );

    const sql = renderSql(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('"responseSlaStartedAt"');
    expect(sql).toContain('"responseSlaDueAt"');
    expect(sql).toContain('"responseSlaRespondedAt"');
    expect(sql).toContain('"responseSlaEscalatedAt"');
    expect(sql).toContain('"ConversationTeamAssignment"');
    expect(sql).toContain('"responseSlaMinutes"');
    expect(sql).toContain("EXCLUDED.\"lastInboundAt\" > COALESCE");
  });

  it("closes one active SLA cycle only for qualifying free-form outbound traffic", async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ id: "conversation-1" }]);
    const service = new ConversationActivityService();

    await service.recordOutbound(
      {
        contact: {
          findUnique: jest.fn().mockResolvedValue({
            id: "33333333-3333-4333-8333-333333333333",
          }),
        },
        $queryRaw: queryRaw,
      } as never,
      {
        tenantId: "11111111-1111-4111-8111-111111111111",
        senderId: "22222222-2222-4222-8222-222222222222",
        phone: "96170123456",
        messageType: MessageType.TEXT,
        occurredAt: new Date("2026-09-12T08:05:00.000Z"),
      },
    );

    const sql = renderSql(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('"responseSlaRespondedAt"');
    expect(sql).toContain('"responseSlaEscalatedAt"');
    expect(sql).toContain("EXCLUDED.\"lastOutboundAt\" >= \"Conversation\".\"responseSlaStartedAt\"");
    expect(sql).toContain("WHEN \"Conversation\".\"status\" = 'RESOLVED'");
  });
});
