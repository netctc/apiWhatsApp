import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ContactsController } from "./contacts.controller.js";
import { ContactsService } from "./contacts.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ContactsController],
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactsModule {}
