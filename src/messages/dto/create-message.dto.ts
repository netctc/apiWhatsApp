import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsObject, IsOptional, IsString } from "class-validator";

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

  @ApiPropertyOptional({ description: "Client-supplied idempotency key" })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
