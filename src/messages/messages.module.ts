import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MessagesController } from "./messages.controller.js";
import { MessagesService } from "./messages.service.js";

@Module({
  imports: [AuthModule],
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
