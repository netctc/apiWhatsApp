import { Module } from "@nestjs/common";
import { ContactsModule } from "../contacts/contacts.module.js";
import { PhoneNumbersModule } from "../phone-numbers/phone-numbers.module.js";
import { MessagesController } from "./messages.controller.js";
import { MessagesService } from "./messages.service.js";
import { OutboundPolicyService } from "./outbound-policy.service.js";

@Module({
  imports: [ContactsModule, PhoneNumbersModule],
  controllers: [MessagesController],
  providers: [MessagesService, OutboundPolicyService],
})
export class MessagesModule {}
