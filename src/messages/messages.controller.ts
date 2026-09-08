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
  Query,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { CreateMessageDto } from "./dto/create-message.dto.js";
import { ListMessagesQueryDto } from "./dto/list-messages-query.dto.js";
import { MessagesService } from "./messages.service.js";

@ApiTags("messages")
@ApiSecurity("apiKey")
@Controller("v1/messages")
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post()
  @RequireScopes(ApiScope.MESSAGES_WRITE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Accept an outbound WhatsApp message for asynchronous delivery" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description: "Stable client key for one logical outbound message. Maximum 255 characters.",
  })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: "Message accepted and queued" })
  async create(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Body() dto: CreateMessageDto,
    @Headers("idempotency-key") idempotencyHeader?: string,
  ) {
    const idempotencyKey = this.resolveIdempotencyKey(idempotencyHeader, dto.idempotencyKey);
    const message = await this.messagesService.create(principal.tenantId, {
      ...dto,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    return {
      messageId: message.id,
      status: message.status,
      createdAt: message.createdAt,
    };
  }

  @Get()
  @RequireScopes(ApiScope.MESSAGES_READ)
  @ApiOperation({ summary: "List tenant messages with cursor pagination and filters" })
  list(@CurrentPrincipal() principal: ApiPrincipal, @Query() query: ListMessagesQueryDto) {
    return this.messagesService.list(principal.tenantId, query);
  }

  @Get(":id")
  @RequireScopes(ApiScope.MESSAGES_READ)
  @ApiOperation({ summary: "Get a message and its status history" })
  async findById(@CurrentPrincipal() principal: ApiPrincipal, @Param("id") id: string) {
    const message = await this.messagesService.findById(principal.tenantId, id);
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
