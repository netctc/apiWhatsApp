import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module.js";
import { ContactsModule } from "./contacts/contacts.module.js";
import { HealthModule } from "./health/health.module.js";
import { MessagesModule } from "./messages/messages.module.js";
import { OutboxModule } from "./outbox/outbox.module.js";
import { PhoneNumbersModule } from "./phone-numbers/phone-numbers.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { QueueModule } from "./queue/queue.module.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    ContactsModule,
    PhoneNumbersModule,
    QueueModule,
    OutboxModule,
    HealthModule,
    MessagesModule,
    WebhooksModule,
  ],
})
export class AppModule {}
