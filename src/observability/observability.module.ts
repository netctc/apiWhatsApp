import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { PrismaModule } from "../prisma/prisma.module.js";
import { HttpMetricsInterceptor } from "./http-metrics.interceptor.js";
import { MetricsController } from "./metrics.controller.js";
import { MetricsService } from "./metrics.service.js";
import { MetricsTokenGuard } from "./metrics-token.guard.js";
import { TraceContextService } from "./trace-context.service.js";
import { TraceHttpInterceptor } from "./trace-http.interceptor.js";

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [MetricsController],
  providers: [
    TraceContextService,
    MetricsService,
    MetricsTokenGuard,
    { provide: APP_INTERCEPTOR, useClass: TraceHttpInterceptor },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [TraceContextService, MetricsService],
})
export class ObservabilityModule {}
