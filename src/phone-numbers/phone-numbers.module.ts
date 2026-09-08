import { Module } from "@nestjs/common";
import { PhoneNumbersController } from "./phone-numbers.controller.js";
import { PhoneNumbersService } from "./phone-numbers.service.js";

@Module({
  controllers: [PhoneNumbersController],
  providers: [PhoneNumbersService],
  exports: [PhoneNumbersService],
})
export class PhoneNumbersModule {}
