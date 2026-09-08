import { ForbiddenException, Injectable } from "@nestjs/common";
import { ContactsService } from "../contacts/contacts.service.js";
import { ConsentStatus } from "../generated/prisma/client.js";
import { OutboundMessageType } from "./dto/create-message.dto.js";

@Injectable()
export class OutboundPolicyService {
  constructor(private readonly contactsService: ContactsService) {}

  async assertAllowed(tenantId: string, to: string, type: OutboundMessageType): Promise<void> {
    const contact = await this.contactsService.findByPhone(tenantId, to);

    if (type === OutboundMessageType.TEMPLATE) {
      if (contact?.consentStatus !== ConsentStatus.OPTED_IN) {
        throw new ForbiddenException("Template messages require explicit contact opt-in");
      }
      return;
    }

    if (!contact?.serviceWindowExpiresAt || contact.serviceWindowExpiresAt.getTime() <= Date.now()) {
      throw new ForbiddenException("Free-form messages require an open 24-hour customer service window");
    }
  }
}
