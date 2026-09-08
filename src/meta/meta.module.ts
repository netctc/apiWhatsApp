import { Module } from "@nestjs/common";
import { MetaWhatsAppClient } from "./meta-whatsapp.client.js";

@Module({
  providers: [MetaWhatsAppClient],
  exports: [MetaWhatsAppClient],
})
export class MetaModule {}
