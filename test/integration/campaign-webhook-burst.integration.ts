import { ValidationPipe, type INestApplication, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import request from "supertest";
import {
  CampaignRecipientStatus,
  CampaignStatus,
  ConsentStatus,
  MessageDirection,
  MessageStatus,
  MessageTrafficClass,
  Prisma,
} from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

const RECIPIENT_COUNT = 24;
const WEBHOOK_BURST = 48;
const APP_SECRET = "campaign-webhook-burst-meta-app-secret";

interface WebhookResult {
  status?: number;
  durationMs: number;
  error?: string;
}

interface CampaignProgressSnapshot {
  status: CampaignStatus;
  queuedRecipients: number;
}

function requireInfrastructure(): void {
  for (const name of ["DATABASE_URL", "REDIS_URL", "RABBITMQ_URL"] as const) {
    if (!process.env[name]) {
      throw new Error(`${name} is required for integration tests`);
    }
  }
}

function readRawBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine Meta mock port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function signatureFor(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function waitForCampaignInProgress(
  prisma: PrismaService,
  campaignId: string,
  timeoutMs = 5000,
): Promise<CampaignProgressSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true, queuedRecipients: true },
    });

    if (
      campaign?.status === CampaignStatus.RUNNING &&
      campaign.queuedRecipients > 0 &&
      campaign.queuedRecipients < RECIPIENT_COUNT
    ) {
      return campaign;
    }

    if (Date.now() >= deadline) {
      const queued = await prisma.campaignRecipient.count({
        where: { campaignId, status: CampaignRecipientStatus.QUEUED },
      });
      throw new Error(
        `Timed out waiting for active campaign progress: ${JSON.stringify({ campaign, queued })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForConvergence(
  prisma: PrismaService,
  campaignId: string,
  marker: string,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [campaign, recipients, submitted, inbound, webhookEvents] = await Promise.all([
      prisma.campaign.findUnique({
        where: { id: campaignId },
        select: {
          status: true,
          totalRecipients: true,
          queuedRecipients: true,
          skippedRecipients: true,
          failedRecipients: true,
          cancelledRecipients: true,
        },
      }),
      prisma.campaignRecipient.groupBy({
        by: ["status"],
        where: { campaignId },
        _count: { _all: true },
      }),
      prisma.message.count({
        where: {
          idempotencyKey: { startsWith: `campaign:${campaignId}:contact:` },
          status: MessageStatus.SUBMITTED,
        },
      }),
      prisma.message.count({
        where: {
          direction: MessageDirection.INBOUND,
          providerMessageId: { startsWith: `wamid.${marker}.` },
        },
      }),
      prisma.webhookEvent.count({
        where: {
          payload: {
            path: ["test_marker"],
            equals: marker,
          },
          processed: true,
        },
      }),
    ]);

    const recipientCounts = new Map(recipients.map((row) => [row.status, row._count._all]));
    const queued = recipientCounts.get(CampaignRecipientStatus.QUEUED) ?? 0;
    const processing = recipientCounts.get(CampaignRecipientStatus.PROCESSING) ?? 0;
    const pending = recipientCounts.get(CampaignRecipientStatus.PENDING) ?? 0;

    if (
      campaign?.status === CampaignStatus.COMPLETED &&
      campaign.totalRecipients === RECIPIENT_COUNT &&
      campaign.queuedRecipients === RECIPIENT_COUNT &&
      queued === RECIPIENT_COUNT &&
      pending === 0 &&
      processing === 0 &&
      submitted === RECIPIENT_COUNT &&
      inbound === WEBHOOK_BURST &&
      webhookEvents === WEBHOOK_BURST
    ) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for campaign/webhook convergence: ${JSON.stringify({
          campaign,
          recipients,
          submitted,
          inbound,
          webhookEvents,
        })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function webhookPayload(
  marker: string,
  senderProviderId: string,
  wabaId: string,
  phone: string,
  contactIndex: number,
  messageIndex: number,
  timestamp: number,
) {
  return {
    object: "whatsapp_business_account",
    test_marker: marker,
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+961 71 000 000",
                phone_number_id: senderProviderId,
              },
              contacts: [
                {
                  profile: { name: `Campaign Burst Contact ${contactIndex}` },
                  wa_id: phone,
                },
              ],
              messages: [
                {
                  from: phone,
                  id: `wamid.${marker}.${messageIndex}`,
                  timestamp: String(timestamp),
                  type: "text",
                  text: { body: `Concurrent inbound ${messageIndex}` },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("campaign and webhook burst integration", () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let metaServer: Server;
  let tenantId: string;
  let campaignId: string;
  let marker: string;
  let senderProviderId: string;
  let wabaId: string;
  let providerCalls = 0;
  const phones: string[] = [];

  beforeAll(async () => {
    requireInfrastructure();

    metaServer = createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || !req.url?.endsWith("/messages")) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }

        await readRawBody(req);
        providerCalls += 1;
        const providerCall = providerCalls;
        await new Promise((resolve) => setTimeout(resolve, 10));
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ messages: [{ id: `wamid.campaign-burst.out.${providerCall}` }] }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "mock_failure" }));
      }
    });
    const metaPort = await listen(metaServer);

    marker = `campaign-burst-${process.pid}-${Date.now()}`;
    process.env.NODE_ENV = "test";
    process.env.META_GRAPH_API_VERSION = "v99.0";
    process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${metaPort}`;
    process.env.META_HTTP_TIMEOUT_MS = "3000";
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_WEBHOOK_VERIFY_TOKEN = "campaign-burst-verify-token";
    process.env.TEST_META_ACCESS_TOKEN = "campaign-burst-meta-access-token";
    process.env.OUTBOUND_QUEUE_NAME = `whatsapp.campaign-burst.${process.pid}.${Date.now()}`;
    process.env.OUTBOX_POLL_INTERVAL_MS = "50";
    process.env.OUTBOX_BATCH_SIZE = "100";
    process.env.OUTBOUND_RETRY_DELAYS_MS = "250,500";
    process.env.OUTBOUND_WORKER_PREFETCH = "50";
    process.env.OUTBOUND_WORKER_PREFETCH_MARKETING = "50";
    process.env.OUTBOUND_MESSAGE_LEASE_MS = "5000";
    process.env.DEFAULT_OUTBOUND_RATE_LIMIT_PER_SECOND = "500";
    process.env.CAMPAIGN_PROCESSOR_INTERVAL_MS = "250";
    process.env.CAMPAIGN_PROCESSOR_BATCH_SIZE = "1";
    process.env.CAMPAIGN_PROCESSOR_LEASE_MS = "5000";
    process.env.WEBHOOK_PROCESSOR_INTERVAL_MS = "250";
    process.env.WEBHOOK_PROCESSOR_BATCH_SIZE = "8";
    process.env.WEBHOOK_PROCESSOR_LEASE_MS = "5000";

    const [{ AppModule }, { WorkerModule }] = await Promise.all([
      import("../../src/app.module.js"),
      import("../../src/worker/worker.module.js"),
    ]);

    app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, "127.0.0.1");
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    prisma = app.get(PrismaService);

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `Campaign Webhook Burst Tenant ${suffix}`,
        slug: `campaign-webhook-burst-${suffix}`,
      },
    });
    tenantId = tenant.id;

    senderProviderId = String(Date.now());
    wabaId = `waba-${suffix}`;
    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId: senderProviderId,
        wabaId,
        displayPhoneNumber: "+961 71 000 000",
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        rateLimitPerSecond: 500,
        active: true,
        isDefault: true,
      },
    });

    const template = await prisma.messageTemplate.create({
      data: {
        tenantId,
        wabaId,
        providerTemplateId: `provider-template-${suffix}`,
        name: `campaign_burst_${process.pid}`,
        language: "en_US",
        category: "MARKETING",
        status: "APPROVED",
      },
    });

    const contacts = [];
    for (let index = 0; index < RECIPIENT_COUNT; index += 1) {
      const phone = `96171${String(index).padStart(6, "0")}`;
      phones.push(phone);
      contacts.push({
        tenantId,
        phone,
        name: `Campaign Burst Contact ${index}`,
        consentStatus: ConsentStatus.OPTED_IN,
        consentSource: "integration-test",
        consentAt: new Date(),
      });
    }
    await prisma.contact.createMany({ data: contacts });
    const persistedContacts = await prisma.contact.findMany({
      where: { tenantId },
      select: { id: true, phone: true },
      orderBy: { phone: "asc" },
    });

    const campaign = await prisma.campaign.create({
      data: {
        tenantId,
        senderId: sender.id,
        templateId: template.id,
        name: "Concurrent webhook burst campaign",
        status: CampaignStatus.RUNNING,
        audience: { allOptedIn: true },
        snapshotAt: new Date(),
        startedAt: new Date(),
        totalRecipients: persistedContacts.length,
      },
    });
    campaignId = campaign.id;

    await prisma.campaignRecipient.createMany({
      data: persistedContacts.map((contact) => ({
        campaignId,
        contactId: contact.id,
      })),
    });
  });

  afterAll(async () => {
    await worker?.close();
    await app?.close();

    const cleanup = new PrismaService();
    try {
      await cleanup.$connect();
      if (marker) {
        await cleanup.$executeRaw(Prisma.sql`
          DELETE FROM "WebhookEvent"
          WHERE "payload" ->> 'test_marker' = ${marker}
        `);
      }

      if (tenantId) {
        const messages = await cleanup.message.findMany({ where: { tenantId }, select: { id: true } });
        const messageIds = messages.map((message) => message.id);
        if (messageIds.length > 0) {
          await cleanup.outboxEvent.deleteMany({ where: { aggregateId: { in: messageIds } } });
          await cleanup.message.deleteMany({ where: { id: { in: messageIds } } });
        }
        await cleanup.campaign.deleteMany({ where: { tenantId } });
        await cleanup.conversationNote.deleteMany({ where: { tenantId } });
        await cleanup.conversation.deleteMany({ where: { tenantId } });
        await cleanup.contact.deleteMany({ where: { tenantId } });
        await cleanup.messageTemplate.deleteMany({ where: { tenantId } });
        await cleanup.whatsAppPhoneNumber.deleteMany({ where: { tenantId } });
        await cleanup.apiKey.deleteMany({ where: { tenantId } });
        await cleanup.tenant.deleteMany({ where: { id: tenantId } });
      }
    } finally {
      await cleanup.$disconnect();
    }

    if (metaServer) {
      await closeServer(metaServer);
    }
  });

  it("keeps campaign and inbound webhook pipelines progressing under concurrent burst load", async () => {
    const beforeBurst = await waitForCampaignInProgress(prisma, campaignId);
    expect(beforeBurst.status).toBe(CampaignStatus.RUNNING);
    expect(beforeBurst.queuedRecipients).toBeGreaterThan(0);
    expect(beforeBurst.queuedRecipients).toBeLessThan(RECIPIENT_COUNT);

    const baseTimestamp = Math.floor(Date.now() / 1000);
    const results = await Promise.all(
      Array.from({ length: WEBHOOK_BURST }, async (_, messageIndex): Promise<WebhookResult> => {
        const contactIndex = messageIndex % RECIPIENT_COUNT;
        const payload = webhookPayload(
          marker,
          senderProviderId,
          wabaId,
          phones[contactIndex],
          contactIndex,
          messageIndex,
          baseTimestamp + messageIndex,
        );
        const body = JSON.stringify(payload);
        const startedAt = performance.now();
        try {
          const response = await request(app.getHttpServer())
            .post("/api/v1/webhooks/meta/whatsapp")
            .set("content-type", "application/json")
            .set("x-hub-signature-256", signatureFor(body))
            .send(body);
          return {
            status: response.status,
            durationMs: performance.now() - startedAt,
          };
        } catch (error) {
          return {
            durationMs: performance.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const failures = results.filter((result) => result.error || result.status !== 200);
    expect(failures).toEqual([]);
    const webhookP95 = p95(results.map((result) => result.durationMs));
    const p95Limit = Math.max(1000, Number(process.env.INTEGRATION_WEBHOOK_BURST_P95_MS ?? 3000));
    expect(webhookP95).toBeLessThan(p95Limit);

    const duringBurst = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { status: true },
    });
    expect(duringBurst.status).toBe(CampaignStatus.RUNNING);

    await waitForConvergence(prisma, campaignId, marker);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const recipients = await prisma.campaignRecipient.findMany({
      where: { campaignId },
      include: { message: true },
    });
    const webhookEvents = await prisma.webhookEvent.findMany({
      where: {
        payload: {
          path: ["test_marker"],
          equals: marker,
        },
      },
    });
    const inboundMessages = await prisma.message.findMany({
      where: {
        tenantId,
        direction: MessageDirection.INBOUND,
        providerMessageId: { startsWith: `wamid.${marker}.` },
      },
    });
    const conversations = await prisma.conversation.findMany({ where: { tenantId } });

    expect(campaign.status).toBe(CampaignStatus.COMPLETED);
    expect(campaign.totalRecipients).toBe(RECIPIENT_COUNT);
    expect(campaign.queuedRecipients).toBe(RECIPIENT_COUNT);
    expect(campaign.skippedRecipients).toBe(0);
    expect(campaign.failedRecipients).toBe(0);
    expect(campaign.cancelledRecipients).toBe(0);

    expect(recipients).toHaveLength(RECIPIENT_COUNT);
    expect(recipients.every((recipient) => recipient.status === CampaignRecipientStatus.QUEUED)).toBe(true);
    expect(recipients.every((recipient) => recipient.attemptCount === 1)).toBe(true);
    expect(recipients.every((recipient) => recipient.processingLeaseUntil === null)).toBe(true);
    expect(recipients.every((recipient) => recipient.message?.status === MessageStatus.SUBMITTED)).toBe(true);
    expect(
      recipients.every((recipient) => recipient.message?.trafficClass === MessageTrafficClass.MARKETING),
    ).toBe(true);

    expect(webhookEvents).toHaveLength(WEBHOOK_BURST);
    expect(webhookEvents.every((event) => event.processed)).toBe(true);
    expect(webhookEvents.every((event) => event.attemptCount === 1)).toBe(true);
    expect(webhookEvents.every((event) => event.processingLeaseUntil === null)).toBe(true);
    expect(webhookEvents.every((event) => event.lastError === null)).toBe(true);

    expect(inboundMessages).toHaveLength(WEBHOOK_BURST);
    expect(inboundMessages.every((message) => message.status === MessageStatus.RECEIVED)).toBe(true);
    expect(conversations).toHaveLength(RECIPIENT_COUNT);
    expect(conversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0)).toBe(WEBHOOK_BURST);
    expect(providerCalls).toBe(RECIPIENT_COUNT);
  });
});