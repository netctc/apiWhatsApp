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

  it("blocks all new outbound messages for opted-out contacts", async () => {
    findByPhone.mockResolvedValue({ consentStatus: ConsentStatus.OPTED_OUT });

    await expect(
      service.assertAllowed("tenant-1", "+96170123456", OutboundMessageType.TEXT),
    ).rejects.toBeInstanceOf(ForbiddenException);
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

  it("allows non-template traffic when the contact is not opted out", async () => {
    findByPhone.mockResolvedValue(null);

    await expect(
      service.assertAllowed("tenant-1", "+96170123456", OutboundMessageType.TEXT),
    ).resolves.toBeUndefined();
  });
});
