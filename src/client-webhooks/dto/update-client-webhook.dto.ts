import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { ClientWebhookEventType } from "../client-webhook.types.js";

export class UpdateClientWebhookDto {
  @ApiPropertyOptional({ example: "CRM production" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: "https://crm.example.com/webhooks/whatsapp" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  url?: string;

  @ApiPropertyOptional({ enum: ClientWebhookEventType, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsEnum(ClientWebhookEventType, { each: true })
  events?: ClientWebhookEventType[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
