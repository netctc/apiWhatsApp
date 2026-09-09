import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
import { Public } from "../auth/public.decorator.js";
import { MetricsService } from "./metrics.service.js";
import { MetricsTokenGuard } from "./metrics-token.guard.js";

@Public()
@ApiExcludeController()
@Controller("metrics")
@UseGuards(MetricsTokenGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async getMetrics(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    return this.metrics.render();
  }
}
