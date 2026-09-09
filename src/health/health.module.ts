import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { OperationalHealthService } from "./operational-health.service.js";

@Module({
  controllers: [HealthController],
  providers: [OperationalHealthService],
  exports: [OperationalHealthService],
})
export class HealthModule {}
