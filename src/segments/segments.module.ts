import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { SegmentsController } from "./segments.controller.js";
import { SegmentsService } from "./segments.service.js";

@Module({
  imports: [PrismaModule],
  controllers: [SegmentsController],
  providers: [SegmentsService],
  exports: [SegmentsService],
})
export class SegmentsModule {}
