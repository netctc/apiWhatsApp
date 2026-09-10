import { createHash } from "node:crypto";
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ClientWebhookDelivery, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { APP_USER_AGENT } from "../version.js";
import { ClientWebhookHttpError, ClientWebhookHttpService } from "./client-webhook-http.service.js";
import { ClientWebhookSecretService } from "./client-webhook-secret.service.js";
import { signClientWebhook } from "./client-webhook-signature.util.js";

@Injectable()
export class ClientWebhookDeliveryProcessorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ClientWebhookDeliveryProcessorService.name);
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: ClientWebhookSecretService,
    private readonly http: ClientWebhookHttpService,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = this.numberEnv("CLIENT_WEBHOOK_PROCESSOR_INTERVAL_MS", 500, 250, 60_000);
    this.timer = setInterval(() => void this.processPending(), intervalMs);
    this.timer.unref();
    void this.processPending();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async processPending(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      const batchSize = this.numberEnv("CLIENT_WEBHOOK_PROCESSOR_BATCH_SIZE", 50, 1, 500);
      const deliveries = await this.claimDeliveries(batchSize);
      for (const delivery of deliveries) {
        await this.processDelivery(delivery);
      }
    } catch (error) {
      this.logger.error(
        "Client webhook delivery poll failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.processing = false;
    }
  }

  private async processDelivery(delivery: ClientWebhookDelivery): Promise<void> {
    const maxAttempts = this.numberEnv("CLIENT_WEBHOOK_MAX_ATTEMPTS", 8, 1, 50);
    let responseStatus: number | undefined;

    try {
      const endpoint = await this.prisma.clientWebhookEndpoint.findUnique({
        where: { id: delivery.endpointId },
      });
      if (!endpoint || endpoint.tenantId !== delivery.tenantId || !endpoint.active) {
        await this.failTerminal(delivery, "Client webhook endpoint is missing or inactive");
        return;
      }

      const body = JSON.stringify(delivery.payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const secret = this.secrets.decrypt({
        secretCiphertext: endpoint.secretCiphertext,
        secretIv: endpoint.secretIv,
        secretTag: endpoint.secretTag,
      });
      const signature = signClientWebhook(secret, timestamp, body);

      responseStatus = await this.http.post(endpoint.url, body, {
        "Content-Type": "application/json",
        "User-Agent": APP_USER_AGENT,
        "X-Webhook-Id": delivery.id,
        "X-Webhook-Event": delivery.eventType,
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Signature": signature,
      });

      if (responseStatus >= 200 && responseStatus < 300) {
        await this.prisma.clientWebhookDelivery.update({
          where: { id: delivery.id },
          data: {
            deliveredAt: new Date(),
            processingLeaseUntil: null,
            responseStatus,
            lastError: null,
          },
        });
        return;
      }

      const retryable = responseStatus === 408 || responseStatus === 425 || responseStatus === 429 || responseStatus >= 500;
      const message = `Client webhook returned HTTP ${responseStatus}`;
      if (!retryable || delivery.attemptCount >= maxAttempts) {
        await this.failTerminal(delivery, message, responseStatus);
        return;
      }
      await this.scheduleRetry(delivery, message, responseStatus);
    } catch (error) {
      const retryable = !(error instanceof ClientWebhookHttpError) || error.retryable;
      const message = error instanceof Error ? error.message : String(error);
      if (!retryable || delivery.attemptCount >= maxAttempts) {
        await this.failTerminal(delivery, message, responseStatus);
        return;
      }
      await this.scheduleRetry(delivery, message, responseStatus);
    }
  }

  private async scheduleRetry(
    delivery: ClientWebhookDelivery,
    message: string,
    responseStatus?: number,
  ): Promise<void> {
    const delayMs = this.retryDelayMs(delivery.id, delivery.attemptCount);
    await this.prisma.clientWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        nextAttemptAt: new Date(Date.now() + delayMs),
        processingLeaseUntil: null,
        responseStatus,
        lastError: message.slice(0, 2000),
      },
    });
    this.logger.warn(
      `Client webhook delivery ${delivery.id} attempt=${delivery.attemptCount} scheduled retry in ${delayMs}ms`,
    );
  }

  private async failTerminal(
    delivery: ClientWebhookDelivery,
    message: string,
    responseStatus?: number,
  ): Promise<void> {
    await this.prisma.clientWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        failedAt: new Date(),
        processingLeaseUntil: null,
        responseStatus,
        lastError: message.slice(0, 2000),
      },
    });
    this.logger.warn(
      `Client webhook delivery ${delivery.id} failed terminally after attempt=${delivery.attemptCount}`,
    );
  }

  private retryDelayMs(deliveryId: string, attemptCount: number): number {
    const exponential = Math.min(60 * 60 * 1000, 5000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 10));
    const digest = createHash("sha256").update(`${deliveryId}:${attemptCount}`).digest();
    const jitter = digest.readUInt16BE(0) % 1001;
    return exponential + jitter;
  }

  private async claimDeliveries(batchSize: number): Promise<ClientWebhookDelivery[]> {
    const leaseMs = this.numberEnv("CLIENT_WEBHOOK_PROCESSOR_LEASE_MS", 30_000, 5000, 10 * 60_000);
    const leaseUntil = new Date(Date.now() + leaseMs);

    return this.prisma.$queryRaw<ClientWebhookDelivery[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "ClientWebhookDelivery"
        WHERE "deliveredAt" IS NULL
          AND "failedAt" IS NULL
          AND "nextAttemptAt" <= NOW()
          AND ("processingLeaseUntil" IS NULL OR "processingLeaseUntil" <= NOW())
        ORDER BY "createdAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "ClientWebhookDelivery" AS d
      SET "processingLeaseUntil" = ${leaseUntil},
          "attemptCount" = d."attemptCount" + 1,
          "updatedAt" = NOW()
      FROM candidates
      WHERE d."id" = candidates."id"
      RETURNING d.*
    `);
  }

  private numberEnv(name: string, fallback: number, min: number, max: number): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${name} must be between ${min} and ${max}`);
    }
    return Math.floor(value);
  }
}
