import { randomUUID } from "node:crypto";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ApiScope } from "../../src/auth/auth.constants.js";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.util.js";
import { ConversationStatus, MessageType } from "../../src/generated/prisma/client.js";
import { ConversationActivityService } from "../../src/inbox/conversation-activity.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const HASH_SECRET = "inbox-response-sla-secret-0123456789abcdef";
const teamsRoute = "/api/v1/inbox/teams";
const teamRoute = (id: string) => `${teamsRoute}/${id}`;

describe("inbox response SLA integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let activity: ConversationActivityService;
  let tenantId: string;
  let senderId: string;
  let writerKey: string;
  const originalEnv = new Map<string, string | undefined>();

  async function createKey(scopes: string[]) {
    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        tenantId,
        name: "Inbox response SLA integration key",
        prefix: generated.prefix,
        keyHash: hashApiKey(generated.rawKey, HASH_SECRET),
        scopes,
      },
    });
    return generated.rawKey;
  }

  async function createContact() {
    return prisma.contact.create({
      data: {
        tenantId,
        phone: `96170${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`,
        name: "SLA contact",
      },
    });
  }

  beforeAll(async () => {
    for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"]) {
      if (!process.env[name]) throw new Error(`${name} is required for integration tests`);
    }
    const env = {
      NODE_ENV: "test",
      API_KEY_HASH_SECRET: HASH_SECRET,
      OUTBOUND_QUEUE_NAME: `whatsapp.inbox-response-sla.${randomUUID()}`,
      OUTBOX_POLL_INTERVAL_MS: "60000",
      WEBHOOK_PROCESSOR_INTERVAL_MS: "60000",
      CAMPAIGN_PROCESSOR_INTERVAL_MS: "60000",
    };
    for (const [name, value] of Object.entries(env)) {
      originalEnv.set(name, process.env[name]);
      process.env[name] = value;
    }

    const { AppModule } = await import("../../src/app.module.js");
    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");

    prisma = app.get(PrismaService);
    activity = app.get(ConversationActivityService);

    const tenant = await prisma.tenant.create({
      data: { name: "Inbox response SLA tenant", slug: `inbox-response-sla-${randomUUID()}` },
    });
    tenantId = tenant.id;

    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId: `sla-phone-${randomUUID()}`,
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        active: true,
        isDefault: true,
      },
    });
    senderId = sender.id;
    writerKey = await createKey([ApiScope.INBOX_WRITE]);
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

  it("validates and persists nullable team response SLA policy at API and database boundaries", async () => {
    const created = await request(app.getHttpServer())
      .post(teamsRoute)
      .set("X-API-Key", writerKey)
      .send({ name: `SLA Support ${randomUUID()}`, responseSlaMinutes: 30 })
      .expect(201);

    expect(created.body.responseSlaMinutes).toBe(30);

    const cleared = await request(app.getHttpServer())
      .patch(teamRoute(created.body.id))
      .set("X-API-Key", writerKey)
      .send({ responseSlaMinutes: null })
      .expect(200);
    expect(cleared.body.responseSlaMinutes).toBeNull();

    for (const invalid of [0, 10081, 1.5]) {
      await request(app.getHttpServer())
        .post(teamsRoute)
        .set("X-API-Key", writerKey)
        .send({ name: `Invalid SLA ${invalid}-${randomUUID()}`, responseSlaMinutes: invalid })
        .expect(400);
    }

    await expect(prisma.inboxTeam.create({
      data: {
        tenantId,
        name: `Invalid database SLA ${randomUUID()}`,
        responseSlaMinutes: 0,
      },
    })).rejects.toBeDefined();
  });

  it("keeps one monotonic SLA cycle per unanswered customer turn", async () => {
    const team = await prisma.inboxTeam.create({
      data: {
        tenantId,
        name: `Lifecycle SLA ${randomUUID()}`,
        responseSlaMinutes: 30,
      },
    });
    const contact = await createContact();
    const initialInbound = new Date(Date.now() - 60 * 60 * 1000);

    const conversationId = await prisma.$transaction((transaction) => activity.recordInbound(transaction, {
      tenantId,
      senderId,
      contactId: contact.id,
      occurredAt: initialInbound,
    }));

    let conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaStartedAt).toBeNull();
    expect(conversation.responseSlaDueAt).toBeNull();
    expect(conversation.responseSlaRespondedAt).toBeNull();

    await prisma.conversationTeamAssignment.create({
      data: { tenantId, conversationId, teamId: team.id },
    });

    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaStartedAt).not.toBeNull();
    expect(conversation.responseSlaDueAt).not.toBeNull();
    expect(conversation.responseSlaRespondedAt).toBeNull();
    expect(
      conversation.responseSlaDueAt!.getTime() - conversation.responseSlaStartedAt!.getTime(),
    ).toBe(30 * 60 * 1000);

    const firstStartedAt = conversation.responseSlaStartedAt!;
    const firstDueAt = conversation.responseSlaDueAt!;
    const additionalInbound = new Date(initialInbound.getTime() + 10 * 60 * 1000);
    await prisma.$transaction((transaction) => activity.recordInbound(transaction, {
      tenantId,
      senderId,
      contactId: contact.id,
      occurredAt: additionalInbound,
    }));

    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaStartedAt?.getTime()).toBe(firstStartedAt.getTime());
    expect(conversation.responseSlaDueAt?.getTime()).toBe(firstDueAt.getTime());

    await request(app.getHttpServer())
      .patch(teamRoute(team.id))
      .set("X-API-Key", writerKey)
      .send({ responseSlaMinutes: 10 })
      .expect(200);

    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaStartedAt?.getTime()).toBe(firstStartedAt.getTime());
    expect(conversation.responseSlaDueAt?.getTime()).toBe(firstDueAt.getTime());

    const firstResponse = new Date(Date.now() + 1000);
    await prisma.$transaction((transaction) => activity.recordOutbound(transaction, {
      tenantId,
      senderId,
      phone: contact.phone,
      messageType: MessageType.TEXT,
      occurredAt: firstResponse,
    }));

    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaRespondedAt?.getTime()).toBe(firstResponse.getTime());

    await prisma.$transaction((transaction) => activity.recordOutbound(transaction, {
      tenantId,
      senderId,
      phone: contact.phone,
      messageType: MessageType.TEXT,
      occurredAt: new Date(firstResponse.getTime() + 1000),
    }));
    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaRespondedAt?.getTime()).toBe(firstResponse.getTime());

    const nextInbound = new Date(firstResponse.getTime() + 2000);
    await prisma.$transaction((transaction) => activity.recordInbound(transaction, {
      tenantId,
      senderId,
      contactId: contact.id,
      occurredAt: nextInbound,
    }));
    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaStartedAt?.getTime()).toBe(nextInbound.getTime());
    expect(conversation.responseSlaDueAt?.getTime()).toBe(nextInbound.getTime() + 10 * 60 * 1000);
    expect(conversation.responseSlaRespondedAt).toBeNull();

    const activeDueAt = conversation.responseSlaDueAt!;
    await prisma.$transaction((transaction) => activity.recordInbound(transaction, {
      tenantId,
      senderId,
      contactId: contact.id,
      occurredAt: new Date(nextInbound.getTime() - 1000),
    }));
    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaDueAt?.getTime()).toBe(activeDueAt.getTime());

    const templateResult = await prisma.$transaction((transaction) => activity.recordOutbound(transaction, {
      tenantId,
      senderId,
      phone: contact.phone,
      messageType: MessageType.TEMPLATE,
      occurredAt: new Date(nextInbound.getTime() + 1000),
    }));
    expect(templateResult).toBeUndefined();
    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaRespondedAt).toBeNull();

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { status: ConversationStatus.RESOLVED, resolvedAt: new Date() },
    });
    const reopenedInbound = new Date(nextInbound.getTime() + 3000);
    await prisma.$transaction((transaction) => activity.recordInbound(transaction, {
      tenantId,
      senderId,
      contactId: contact.id,
      occurredAt: reopenedInbound,
    }));
    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.status).toBe(ConversationStatus.OPEN);
    expect(conversation.responseSlaStartedAt?.getTime()).toBe(reopenedInbound.getTime());
    expect(conversation.responseSlaDueAt?.getTime()).toBe(reopenedInbound.getTime() + 10 * 60 * 1000);

    const reopenedDueAt = conversation.responseSlaDueAt!;
    await request(app.getHttpServer())
      .patch(teamRoute(team.id))
      .set("X-API-Key", writerKey)
      .send({ responseSlaMinutes: null })
      .expect(200);
    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaDueAt?.getTime()).toBe(reopenedDueAt.getTime());

    const reopenedResponse = new Date(reopenedInbound.getTime() + 1000);
    await prisma.$transaction((transaction) => activity.recordOutbound(transaction, {
      tenantId,
      senderId,
      phone: contact.phone,
      messageType: MessageType.TEXT,
      occurredAt: reopenedResponse,
    }));
    const noPolicyInbound = new Date(reopenedResponse.getTime() + 1000);
    await prisma.$transaction((transaction) => activity.recordInbound(transaction, {
      tenantId,
      senderId,
      contactId: contact.id,
      occurredAt: noPolicyInbound,
    }));
    conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.responseSlaStartedAt).toBeNull();
    expect(conversation.responseSlaDueAt).toBeNull();
    expect(conversation.responseSlaRespondedAt).toBeNull();
  });

  it("supports the indexed unresolved-overdue scan used by a later escalation worker", async () => {
    const team = await prisma.inboxTeam.create({
      data: { tenantId, name: `Overdue SLA ${randomUUID()}`, responseSlaMinutes: 5 },
    });
    const contact = await createContact();
    const inboundAt = new Date(Date.now() - 10 * 60 * 1000);
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
        responseSlaStartedAt: new Date(now.getTime() - 2 * 60 * 1000),
        responseSlaDueAt: new Date(now.getTime() - 60 * 1000),
        responseSlaRespondedAt: null,
      },
    });

    const overdue = await prisma.conversation.findMany({
      where: {
        tenantId,
        status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
        responseSlaDueAt: { lt: now },
        responseSlaRespondedAt: null,
      },
      select: { id: true },
    });
    expect(overdue.some((row) => row.id === conversationId)).toBe(true);
  });
});
