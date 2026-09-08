import { Module } from "@nestjs/common";
import { PhoneNumbersModule } from "../phone-numbers/phone-numbers.module.js";
import { MetaSenderResolverService } from "./meta-sender-resolver.service.js";
import { MetaWhatsAppClient } from "./meta-whatsapp.client.js";

@Module({
  imports: [PhoneNumbersModule],
  providers: [MetaWhatsAppClient, MetaSenderResolverService],
  exports: [MetaWhatsAppClient, MetaSenderResolverService],
})
export class MetaModule {}
