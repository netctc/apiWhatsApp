import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MetaModule } from "../meta/meta.module.js";
import { ObservabilityModule } from "../observability/observability.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { QueueModule } from "../queue/queue.module.js";
import { DistributedRateLimiterService } from "./distributed-rate-limiter.service.js";
import { MessageDispatcherService } from "./message-dispatcher.service.js";
import { OutboundWorkerService } from "./outbound-worker.service.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    ObservabilityModule,
    QueueModule,
    MetaModule,
  ],
  providers: [
    DistributedRateLimiterService,
    MessageDispatcherService,
    OutboundWorkerService,
  ],
})
export class WorkerModule {}
