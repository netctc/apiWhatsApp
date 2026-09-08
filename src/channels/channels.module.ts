import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ChannelsController } from "./channels.controller.js";
import { ChannelsService } from "./channels.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
})
export class ChannelsModule {}
