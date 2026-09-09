import { Module } from "@nestjs/common";
import { MetaModule } from "../meta/meta.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { TemplatesController } from "./templates.controller.js";
import { TemplatesService } from "./templates.service.js";

@Module({
  imports: [PrismaModule, MetaModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
