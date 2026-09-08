import { ForbiddenException, Injectable } from "@nestjs/common";
import { ContactsService } from "../contacts/contacts.service.js";
import { ConsentStatus } from "../generated/prisma/client.js";
import { OutboundMessageType } from "./dto/create-message.dto.js";

@Injectable()
export class OutboundPolicyService {
  constructor(private readonly contactsService: ContactsService) {}

  async assertAllowed(tenantId: string, to: string, type: OutboundMessageType): Promise<void> {
    const contact = await this.contactsService.findByPhone(tenantId, to);

    if (contact?.consentStatus === ConsentStatus.OPTED_OUT) {
      throw new ForbiddenException("Contact has opted out of WhatsApp messaging");
    }

    if (type === OutboundMessageType.TEMPLATE && contact?.consentStatus !== ConsentStatus.OPTED_IN) {
      throw new ForbiddenException("Template messages require explicit contact opt-in");
    }
  }
}
