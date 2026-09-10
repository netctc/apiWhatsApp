import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module.js";
import { HealthController } from "./health.controller.js";
import { OperationalHealthService } from "./operational-health.service.js";

@Module({
  imports: [MediaModule],
  controllers: [HealthController],
  providers: [OperationalHealthService],
  exports: [OperationalHealthService],
})
export class HealthModule {}
