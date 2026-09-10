import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { auditLogData, changedFields, mutationActor } from "../audit/audit-write.util.js";
import type { AuditRequestContext } from "../audit/audit.types.js";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ClientWebhookSecretService } from "./client-webhook-secret.service.js";
import { webhookUrlAuditMetadata, normalizeClientWebhookUrl, ClientWebhookUrlError } from "./client-webhook-url.util.js";
import type { CreateClientWebhookDto } from "./dto/create-client-webhook.dto.js";
import type { UpdateClientWebhookDto } from "./dto/update-client-webhook.dto.js";

@Injectable()
export class ClientWebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: ClientWebhookSecretService,
  ) {}

  async create(principal: ApiPrincipal, dto: CreateClientWebhookDto, context?: AuditRequestContext) {
    const name = this.normalizeName(dto.name);
    const url = this.normalizeUrl(dto.url);
    const events = [...dto.events].sort();
    const signingSecret = this.secrets.generateSigningSecret();
    const encrypted = this.secrets.encrypt(signingSecret);
    const actor = mutationActor(principal);

    try {
      const endpoint = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.clientWebhookEndpoint.create({
          data: {
            tenantId: actor.tenantId,
            name,
            url,
            events,
            ...encrypted,
          },
        });

        const audit = auditLogData(
          actor,
          context,
          "client_webhook.created",
          "ClientWebhookEndpoint",
          created.id,
          {
            name: created.name,
            active: created.active,
            eventCount: created.events.length,
            ...webhookUrlAuditMetadata(created.url),
          },
        );
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
        return created;
      });

      return { ...this.safeEndpoint(endpoint), signingSecret };
    } catch (error) {
      this.rethrowUniqueConflict(error);
      throw error;
    }
  }

  list(tenantId: string) {
    return this.prisma.clientWebhookEndpoint.findMany({
      where: { tenantId },
      orderBy: [{ active: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
      select: this.safeSelect(),
    });
  }

  async findById(tenantId: string, id: string) {
    const endpoint = await this.prisma.clientWebhookEndpoint.findFirst({
      where: { id, tenantId },
      select: this.safeSelect(),
    });
    if (!endpoint) {
      throw new NotFoundException("Client webhook endpoint not found");
    }
    return endpoint;
  }

  async update(
    principal: ApiPrincipal,
    id: string,
    dto: UpdateClientWebhookDto,
    context?: AuditRequestContext,
  ) {
    if (Object.values(dto).every((value) => value === undefined)) {
      throw new BadRequestException("At least one client webhook field must be provided");
    }

    const actor = mutationActor(principal);
    const name = dto.name === undefined ? undefined : this.normalizeName(dto.name);
    const url = dto.url === undefined ? undefined : this.normalizeUrl(dto.url);
    const events = dto.events === undefined ? undefined : [...dto.events].sort();

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.clientWebhookEndpoint.findFirst({
          where: { id, tenantId: actor.tenantId },
        });
        if (!existing) {
          throw new NotFoundException("Client webhook endpoint not found");
        }

        const updated = await transaction.clientWebhookEndpoint.update({
          where: { id },
          data: {
            name,
            url,
            events,
            active: dto.active,
          },
        });

        const audit = auditLogData(
          actor,
          context,
          "client_webhook.updated",
          "ClientWebhookEndpoint",
          id,
          {
            changedFields: changedFields(dto as Record<string, unknown>),
            active: updated.active,
            eventCount: updated.events.length,
            ...(url ? webhookUrlAuditMetadata(url) : {}),
          },
        );
        if (audit) {
          await transaction.auditLog.create({ data: audit });
        }
        return this.safeEndpoint(updated);
      });
    } catch (error) {
      this.rethrowUniqueConflict(error);
      throw error;
    }
  }

  async rotateSecret(principal: ApiPrincipal, id: string, context?: AuditRequestContext) {
    const actor = mutationActor(principal);
    const signingSecret = this.secrets.generateSigningSecret();
    const encrypted = this.secrets.encrypt(signingSecret);

    const endpoint = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.clientWebhookEndpoint.findFirst({
        where: { id, tenantId: actor.tenantId },
      });
      if (!existing) {
        throw new NotFoundException("Client webhook endpoint not found");
      }

      const updated = await transaction.clientWebhookEndpoint.update({
        where: { id },
        data: encrypted,
      });

      const audit = auditLogData(
        actor,
        context,
        "client_webhook.secret_rotated",
        "ClientWebhookEndpoint",
        id,
        {
          active: updated.active,
          eventCount: updated.events.length,
          ...webhookUrlAuditMetadata(updated.url),
        },
      );
      if (audit) {
        await transaction.auditLog.create({ data: audit });
      }
      return updated;
    });

    return { ...this.safeEndpoint(endpoint), signingSecret };
  }

  private safeSelect() {
    return {
      id: true,
      name: true,
      url: true,
      events: true,
      active: true,
      createdAt: true,
      updatedAt: true,
    } as const;
  }

  private safeEndpoint(endpoint: {
    id: string;
    name: string;
    url: string;
    events: string[];
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: endpoint.id,
      name: endpoint.name,
      url: endpoint.url,
      events: endpoint.events,
      active: endpoint.active,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
    };
  }

  private normalizeName(value: string): string {
    const name = value.trim();
    if (!name) {
      throw new BadRequestException("Client webhook name must contain non-whitespace characters");
    }
    return name;
  }

  private normalizeUrl(value: string): string {
    try {
      return normalizeClientWebhookUrl(value.trim());
    } catch (error) {
      if (error instanceof ClientWebhookUrlError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private rethrowUniqueConflict(error: unknown): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictException("A client webhook endpoint with this name already exists for the tenant");
    }
  }
}
