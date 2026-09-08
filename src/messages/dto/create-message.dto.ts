import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export enum OutboundMessageType {
  TEXT = "TEXT",
  TEMPLATE = "TEMPLATE",
}

export class CreateMessageDto {
  @ApiProperty({ example: "+96170123456" })
  @IsString()
  to!: string;

  @ApiProperty({ enum: OutboundMessageType })
  @IsEnum(OutboundMessageType)
  type!: OutboundMessageType;

  @ApiPropertyOptional({
    description: "Internal tenant-scoped WhatsApp sender ID. When omitted, the active default sender is used.",
  })
  @IsOptional()
  @IsUUID()
  senderId?: string;

  @ApiProperty({ description: "Provider-neutral message payload" })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: "Deprecated body fallback. Prefer the Idempotency-Key HTTP header.",
    deprecated: true,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey?: string;
}
