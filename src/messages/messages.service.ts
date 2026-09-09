import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  UnprocessableEntityException,
} from "@nestjs/common";
import { normalizePhoneNumber } from "../contacts/phone.util.js";
import { MessageDirection, MessageStatus, MessageType, Prisma } from "../generated/prisma/client.js";
import { TraceContextService } from "../observability/trace-context.service.js";
import { PhoneNumbersService } from "../phone-numbers/phone-numbers.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TemplatesService } from "../templates/templates.service.js";
import { CreateMessageDto, OutboundMessageType } from "./dto/create-message.dto.js";
import { ListMessagesQueryDto } from "./dto/list-messages-query.dto.js";
import { OutboundPolicyService } from "./outbound-policy.service.js";
import { deriveTrafficClass } from "./traffic-class.util.js";

const OUTBOUND_REQUESTED_EVENT = "message.outbound.requested";

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outboundPolicy: OutboundPolicyService,
    private readonly phoneNumbers: PhoneNumbersService,
    private readonly templates: TemplatesService,
    @Optional() private readonly trace?: TraceContextService,
  ) {}

  async create(tenantId: string, dto: CreateMessageDto) {
    if (dto.idempotencyKey) {
      const existing = await this.prisma.message.findFirst({
        where: { tenantId, idempotencyKey: dto.idempotencyKey },
      });

      if (existing) {
        return existing;
      }
    }

    await this.outboundPolicy.assertAllowed(tenantId, dto.to, dto.type);
    const normalizedTo = normalizePhoneNumber(dto.to);
    const sender = await this.phoneNumbers.resolveForTenant(tenantId, dto.senderId);
    const messageType = this.mapType(dto.type);
    let templateCategory: string | null | undefined;

    if (dto.type === OutboundMessageType.TEMPLATE) {
      if (!sender.wabaId) {
        throw new UnprocessableEntityException("The selected WhatsApp sender is missing its WABA ID");
      }
      const template = await this.templates.assertApproved(tenantId, sender.wabaId, dto.payload);
      templateCategory = template.category;
    }

    const trafficClass = deriveTrafficClass(messageType, templateCategory);
    const trace = this.trace?.carrier();

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const message = await transaction.message.create({
          data: {
            tenantId,
            senderId: sender.id,
            direction: MessageDirection.OUTBOUND,
            trafficClass,
            type: messageType,
            status: MessageStatus.QUEUED,
            to: normalizedTo,
            idempotencyKey: dto.idempotencyKey,
            payload: this.toJson(dto.payload),
            statusEvents: {
              create: { status: MessageStatus.QUEUED },
            },
          },
        });

        await transaction.outboxEvent.create({
          data: {
            aggregateType: "Message",
            aggregateId: message.id,
            eventType: OUTBOUND_REQUESTED_EVENT,
            payload: this.toJson({
              messageId: message.id,
              trafficClass,
              ...(trace ? { trace } : {}),
            }),
          },
        });

        return message;
      });
    } catch (error) {
      if (dto.idempotencyKey) {
        const existing = await this.prisma.message.findFirst({
          where: { tenantId, idempotencyKey: dto.idempotencyKey },
        });
        if (existing) {
          return existing;
        }
      }
      throw new ConflictException("Unable to create outbound message", { cause: error });
    }
  }

  async list(tenantId: string, query: ListMessagesQueryDto) {
    if (query.cursor) {
      const cursorMessage = await this.prisma.message.findFirst({
        where: { id: query.cursor, tenantId },
        select: { id: true },
      });
      if (!cursorMessage) {
        throw new BadRequestException("Message cursor is invalid for this tenant");
      }
    }

    const phone = query.phone ? normalizePhoneNumber(query.phone) : undefined;
    const where: Prisma.MessageWhereInput = {
      tenantId,
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.trafficClass ? { trafficClass: query.trafficClass } : {}),
      ...(query.senderId ? { senderId: query.senderId } : {}),
      ...(phone ? { OR: [{ to: phone }, { from: phone }] } : {}),
    };

    const rows = await this.prisma.message.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        sender: {
          select: {
            id: true,
            providerPhoneNumberId: true,
            displayPhoneNumber: true,
            verifiedName: true,
          },
        },
      },
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }

  async findById(tenantId: string, id: string) {
    return this.prisma.message.findFirst({
      where: { id, tenantId },
      include: {
        sender: {
          select: {
            id: true,
            providerPhoneNumberId: true,
            displayPhoneNumber: true,
            verifiedName: true,
          },
        },
        statusEvents: { orderBy: { createdAt: "asc" } },
      },
    });
  }

  private mapType(type: OutboundMessageType): MessageType {
    switch (type) {
      case OutboundMessageType.TEXT:
        return MessageType.TEXT;
      case OutboundMessageType.TEMPLATE:
        return MessageType.TEMPLATE;
    }
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
