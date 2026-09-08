import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";

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

  @ApiProperty({ description: "Provider-neutral message payload" })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: "Internal WhatsApp channel UUID. If omitted, the tenant default channel is used.",
  })
  @IsOptional()
  @IsUUID()
  channelId?: string;

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
