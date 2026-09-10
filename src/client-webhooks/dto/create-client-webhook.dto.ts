import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { ClientWebhookEventType } from "../client-webhook.types.js";

export class CreateClientWebhookDto {
  @ApiProperty({ example: "CRM production" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: "https://crm.example.com/webhooks/whatsapp" })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  url!: string;

  @ApiProperty({ enum: ClientWebhookEventType, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsEnum(ClientWebhookEventType, { each: true })
  events!: ClientWebhookEventType[];
}
