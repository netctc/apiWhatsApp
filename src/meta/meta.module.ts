import { Module } from "@nestjs/common";
import { PhoneNumbersModule } from "../phone-numbers/phone-numbers.module.js";
import { MetaMediaClient } from "./meta-media.client.js";
import { MetaSenderResolverService } from "./meta-sender-resolver.service.js";
import { MetaTemplateClient } from "./meta-template.client.js";
import { MetaWhatsAppClient } from "./meta-whatsapp.client.js";
import { SecretReferenceService } from "./secret-reference.service.js";

@Module({
  imports: [PhoneNumbersModule],
  providers: [
    MetaWhatsAppClient,
    MetaSenderResolverService,
    MetaTemplateClient,
    MetaMediaClient,
    SecretReferenceService,
  ],
  exports: [MetaWhatsAppClient, MetaSenderResolverService, MetaTemplateClient, MetaMediaClient],
})
export class MetaModule {}
