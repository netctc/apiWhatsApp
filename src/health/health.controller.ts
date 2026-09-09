import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../auth/public.decorator.js";
import { OperationalHealthService, type ReadinessReport } from "./operational-health.service.js";

@Public()
@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly health: OperationalHealthService) {}

  @Get()
  @ApiOperation({ summary: "Get process liveness for backward compatibility" })
  getHealth() {
    return this.health.live();
  }

  @Get("live")
  @ApiOperation({ summary: "Get process liveness without checking external dependencies" })
  live() {
    return this.health.live();
  }

  @Get("ready")
  @ApiOperation({ summary: "Check PostgreSQL, Redis, and RabbitMQ readiness" })
  async ready(): Promise<ReadinessReport> {
    const report = await this.health.ready();
    if (report.status !== "ready") {
      throw new HttpException(report, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }
}
