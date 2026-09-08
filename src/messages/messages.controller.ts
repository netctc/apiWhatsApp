import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ApiKeyGuard } from "../auth/api-key.guard.js";
import { CurrentTenantId } from "../auth/current-tenant.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { ScopesGuard } from "../auth/scopes.guard.js";
import { CreateMessageDto } from "./dto/create-message.dto.js";
import { MessagesService } from "./messages.service.js";

@ApiTags("messages")
@ApiBearerAuth("api-key")
@UseGuards(ApiKeyGuard, ScopesGuard)
@Controller("v1/messages")
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post()
  @RequireScopes("messages:write")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Accept an outbound WhatsApp message for asynchronous delivery" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description: "Stable client key for one logical outbound message. Maximum 255 characters.",
  })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: "Message accepted and queued" })
  async create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreateMessageDto,
    @Headers("idempotency-key") idempotencyHeader?: string,
  ) {
    const idempotencyKey = this.resolveIdempotencyKey(idempotencyHeader, dto.idempotencyKey);
    const message = await this.messagesService.create(tenantId, {
      ...dto,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    return {
      messageId: message.id,
      status: message.status,
      createdAt: message.createdAt,
    };
  }

  @Get(":id")
  @RequireScopes("messages:read")
  @ApiOperation({ summary: "Get a tenant-owned message and its status history" })
  async findById(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    const message = await this.messagesService.findById(tenantId, id);
    if (!message) {
      throw new NotFoundException("Message not found");
    }
    return message;
  }

  private resolveIdempotencyKey(headerValue?: string, bodyValue?: string): string | undefined {
    const header = headerValue?.trim();
    const body = bodyValue?.trim();

    if (header && header.length > 255) {
      throw new BadRequestException("Idempotency-Key must not exceed 255 characters");
    }

    if (header && body && header !== body) {
      throw new BadRequestException("Idempotency-Key header and body idempotencyKey must match");
    }

    return header || body || undefined;
  }
}
