import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { ClientWebhookEventType, type ClientWebhookEnvelope } from "./client-webhook.types.js";

@Injectable()
export class ClientWebhookFanoutService {
  async enqueue(
    transaction: Prisma.TransactionClient,
    input: {
      tenantId: string;
      eventType: ClientWebhookEventType;
      sourceEventKey: string;
      data: Record<string, unknown>;
      occurredAt?: Date;
    },
  ): Promise<number> {
    const endpoints = await transaction.clientWebhookEndpoint.findMany({
      where: {
        tenantId: input.tenantId,
        active: true,
        events: { has: input.eventType },
      },
      select: { id: true },
    });
    if (endpoints.length === 0) {
      return 0;
    }

    const envelope: ClientWebhookEnvelope = {
      id: input.sourceEventKey,
      type: input.eventType,
      createdAt: (input.occurredAt ?? new Date()).toISOString(),
      data: input.data,
    };

    const result = await transaction.clientWebhookDelivery.createMany({
      data: endpoints.map((endpoint) => ({
        tenantId: input.tenantId,
        endpointId: endpoint.id,
        eventType: input.eventType,
        sourceEventKey: input.sourceEventKey,
        payload: this.toJson(envelope),
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
