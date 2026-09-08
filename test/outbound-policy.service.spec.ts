import { jest } from "@jest/globals";
import { ForbiddenException } from "@nestjs/common";
import { ConsentStatus } from "../src/generated/prisma/client.js";
import { OutboundMessageType } from "../src/messages/dto/create-message.dto.js";
import { OutboundPolicyService } from "../src/messages/outbound-policy.service.js";

describe("OutboundPolicyService", () => {
  const findByPhone = jest.fn();
  const service = new OutboundPolicyService({ findByPhone } as never);

  beforeEach(() => {
    findByPhone.mockReset();
  });

  it("blocks free-form traffic when no customer service window exists", async () => {
    findByPhone.mockResolvedValue(null);

    await expect(
      service.assertAllowed("tenant-1", "+96170123456", OutboundMessageType.TEXT),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("blocks free-form traffic after the 24-hour customer service window expires", async () => {
    findByPhone.mockResolvedValue({
      consentStatus: ConsentStatus.OPTED_IN,
      serviceWindowExpiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      service.assertAllowed("tenant-1", "+96170123456", OutboundMessageType.TEXT),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows a service reply inside an open customer service window", async () => {
    findByPhone.mockResolvedValue({
      consentStatus: ConsentStatus.OPTED_OUT,
      serviceWindowExpiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.assertAllowed("tenant-1", "+96170123456", OutboundMessageType.TEXT),
    ).resolves.toBeUndefined();
  });

  it("requires explicit opt-in for template messages", async () => {
    findByPhone.mockResolvedValue({ consentStatus: ConsentStatus.UNKNOWN });

    await expect(
      service.assertAllowed("tenant-1", "+96170123456", OutboundMessageType.TEMPLATE),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows template messages for opted-in contacts", async () => {
    findByPhone.mockResolvedValue({ consentStatus: ConsentStatus.OPTED_IN });

    await expect(
      service.assertAllowed("tenant-1", "+96170123456", OutboundMessageType.TEMPLATE),
    ).resolves.toBeUndefined();
  });
});
