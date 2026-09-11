import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ApiKeysModule } from "./api-keys/api-keys.module.js";
import { AuditModule } from "./audit/audit.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { CampaignsModule } from "./campaigns/campaigns.module.js";
import { CannedResponsesModule } from "./canned-responses/canned-responses.module.js";
import { ContactsModule } from "./contacts/contacts.module.js";
import { HealthModule } from "./health/health.module.js";
import { InboxModule } from "./inbox/inbox.module.js";
import { MediaModule } from "./media/media.module.js";
import { MessagesModule } from "./messages/messages.module.js";
import { ObservabilityModule } from "./observability/observability.module.js";
import { OperationsModule } from "./operations/operations.module.js";
import { OutboxModule } from "./outbox/outbox.module.js";
import { PhoneNumbersModule } from "./phone-numbers/phone-numbers.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { QueueModule } from "./queue/queue.module.js";
import { SegmentsModule } from "./segments/segments.module.js";
import { TemplatesModule } from "./templates/templates.module.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    ObservabilityModule,
    AuthModule,
    ApiKeysModule,
    AuditModule,
    ContactsModule,
    SegmentsModule,
    PhoneNumbersModule,
    TemplatesModule,
    CampaignsModule,
    CannedResponsesModule,
    QueueModule,
    OutboxModule,
    HealthModule,
    OperationsModule,
    InboxModule,
    MediaModule,
    MessagesModule,
    WebhooksModule,
  ],
})
export class AppModule {}
