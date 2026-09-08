import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CreateMessageDto } from "./dto/create-message.dto.js";
import { MessagesService } from "./messages.service.js";

@ApiTags("messages")
@Controller("v1/messages")
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Accept an outbound WhatsApp message for asynchronous delivery" })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: "Message accepted and queued" })
  async create(@Body() dto: CreateMessageDto) {
    const message = await this.messagesService.create(dto);
    return {
      messageId: message.id,
      status: message.status,
      createdAt: message.createdAt,
    };
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a message and its status history" })
  async findById(@Param("id") id: string) {
    const message = await this.messagesService.findById(id);
    if (!message) {
      throw new NotFoundException("Message not found");
    }
    return message;
  }
}
