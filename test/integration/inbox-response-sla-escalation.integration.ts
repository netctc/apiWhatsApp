import { randomUUID } from "node:crypto";
import { type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConversationStatus, MessageType } from "../../src/generated/prisma/client.js";
import { ConversationActivityService } from "../../src/inbox/conversation-activity.service.js";
import { InboxResponseSlaEscalationService } from "../../src/inbox/inbox-response-sla-escalation.service.js";
import { OperationsService } from "../../src/operations/operations.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

describe("inbox response SLA escalation integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let activity: ConversationActivityService;
  let escalation: InboxResponseSlaEscalationService;
  let operations: OperationsService;
  let tenantId: string;
  let senderId: string;
  const originalEnv = new Map<string, string | undefined>();

  async function createContact() {
    return prisma.contact.create({
      data: {
        tenantId,
        phone: `96171${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`,
        name: "SLA escalation contact",
      },
    });
  }

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required for integration tests`);
    }

    const env = {
      NODE_ENV: "test",
      API_KEY_HASH_SECRET: "inbox-sla-escalation-secret-0123456789abcdef",
      OUTBOUND_QUEUE_NAME: `whatsapp.inbox-sla-escalation.${randomUUID()}`,
      OUTBOX_POLL_INTERVAL_MS: "60000",
      WEBHOOK_PROCESSOR_INTERVAL_MS: "60000",
      CAMPAIGN_PROCESSOR_INTERVAL_MS: "60000",
      INBOX_SLA_ESCALATION_INTERVAL_MS: "3600000",
    };
    for (const [name, value] of Object.entries(env)) {
      originalEnv.set(name, process.env[name]);
      process.env[name] = value;
    }

    const { AppModule } = await import("../../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    await app.listen(0, "127.0.0.1");

    prisma = app.get(PrismaService);
    activity = app.get(ConversationActivityService);
    escalation = app.get(InboxResponseSlaEscalationService);
    operations = app.get(OperationsService);

    const tenant = await prisma.tenant.create({
      data: { name: "Inbox SLA escalation tenant", slug: `inbox-sla-escalation-${randomUUID()}` },
    });
    tenantId = tenant.id;

    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId: `sla-escalation-phone-${randomUUID()}`,
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        active: true,
        isDefault: true,
      },
    });
    senderId = sender.id;
  });

  afterAll(async () => {
    if (prisma && tenantId) {
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    }
    if (app) await app.close();
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("claims an overdue cycle once across concurrent scanners and preserves the breach through a late response", async () => {
    const team = await prisma.inboxTeam.create({
      data: { tenantId, name: `Escalation team ${randomUUID()}`, responseSlaMinutes: 5 },
    });
    const contact = await createContact();
    const inboundAt = new Date(Date.now() - 20 * 60 * 1000);
    const conversationId = await prisma.$transaction((transaction) => activity.recordInbound(transaction, {
      tenantId,
      senderId,
      contactId: contact.id,
      occurredAt: inboundAt,
    }));
    await prisma.conversationTeamAssignment.create({
      data: { tenantId, conversationId, teamId: team.id },
    });

    const now = new Date();
    const startedAt = new Date(now.getTime() - 10 * 60 * 1000);
    const dueAt = new Date(now.getTime() - 5 * 60 * 1000);
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        responseSlaStartedAt: startedAt,
        responseSlaDueAt: dueAt,
        responseSlaRespondedAt: null,
        responseSlaEscalatedAt: null,
      },
    });

    await expect(prisma.conversation.update({
      where: { id: conversationId },
      data: { responseSlaEscalatedAt: new Date(dueAt.getTime() - 1) },
    })).rejects.toBeDefined();

    const concurrentClaims = await Promise.all([
      escalation.escalateOverdue(now),
      escalation.escalateOverdue(now),
    ]);
    expect(concurrentClaims.reduce((sum, value) => sum + value, 0)).toBe(1);
    await expect(escalation.escalateOverdue(now)).resolves.toBe(0);

    let conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaEscalatedAt?.getTime()).toBe(now.getTime());
    expect(conversation.responseSlaRespondedAt).toBeNull();

    const snapshot = await operations.snapshot(tenantId);
    expect(snapshot.inboxResponseSla.waitingForResponse).toBeGreaterThanOrEqual(1);
    expect(snapshot.inboxResponseSla.overdueUnescalated).toBe(0);
    expect(snapshot.inboxResponseSla.escalatedUnresolved).toBeGreaterThanOrEqual(1);
    expect(snapshot.inboxResponseSla.oldestOverdueAgeSeconds).not.toBeNull();

    const lateResponseAt = new Date(now.getTime() + 1000);
    await prisma.$transaction((transaction) => activity.recordOutbound(transaction, {
      tenantId,
      senderId,
      phone: contact.phone,
      messageType: MessageType.TEXT,
      occurredAt: lateResponseAt,
    }));

    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaRespondedAt?.getTime()).toBe(lateResponseAt.getTime());
    expect(conversation.responseSlaEscalatedAt?.getTime()).toBe(now.getTime());

    const nextInboundAt = new Date(now.getTime() + 2000);
    await prisma.$transaction((transaction) => activity.recordInbound(transaction, {
      tenantId,
      senderId,
      contactId: contact.id,
      occurredAt: nextInboundAt,
    }));

    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaStartedAt?.getTime()).toBe(nextInboundAt.getTime());
    expect(conversation.responseSlaDueAt?.getTime()).toBe(nextInboundAt.getTime() + 5 * 60 * 1000);
    expect(conversation.responseSlaRespondedAt).toBeNull();
    expect(conversation.responseSlaEscalatedAt).toBeNull();
  });

  it("does not escalate resolved conversations even when their unanswered cycle is overdue", async () => {
    const team = await prisma.inboxTeam.create({
      data: { tenantId, name: `Resolved escalation team ${randomUUID()}`, responseSlaMinutes: 5 },
    });
    const contact = await createContact();
    const inboundAt = new Date(Date.now() - 20 * 60 * 1000);
    const conversationId = await prisma.$transaction((transaction) => activity.recordInbound(transaction, {
      tenantId,
      senderId,
      contactId: contact.id,
      occurredAt: inboundAt,
    }));
    await prisma.conversationTeamAssignment.create({
      data: { tenantId, conversationId, teamId: team.id },
    });

    const now = new Date();
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: ConversationStatus.RESOLVED,
        resolvedAt: now,
        responseSlaStartedAt: new Date(now.getTime() - 10 * 60 * 1000),
        responseSlaDueAt: new Date(now.getTime() - 5 * 60 * 1000),
        responseSlaRespondedAt: null,
        responseSlaEscalatedAt: null,
      },
    });

    await expect(escalation.escalateOverdue(now)).resolves.toBe(0);
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaEscalatedAt).toBeNull();
  });
});
