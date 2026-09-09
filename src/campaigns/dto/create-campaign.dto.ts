import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { CampaignAudienceDto } from "./campaign-audience.dto.js";

export class CreateCampaignDto {
  @ApiProperty({ example: "September renewal offer" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ description: "Tenant sender UUID. Uses the active default sender when omitted." })
  @IsOptional()
  @IsUUID()
  senderId?: string;

  @ApiProperty({ description: "Tenant message template UUID. Must be APPROVED and MARKETING." })
  @IsUUID()
  templateId!: string;

  @ApiProperty({ type: CampaignAudienceDto })
  @ValidateNested()
  @Type(() => CampaignAudienceDto)
  audience!: CampaignAudienceDto;

  @ApiPropertyOptional({
    description: "Static Meta template components shared by every recipient in this campaign.",
    type: "array",
    items: { type: "object" },
  })
  @IsOptional()
  @IsArray()
  components?: Record<string, unknown>[];

  @ApiPropertyOptional({ description: "Requested launch time. The campaign remains DRAFT until launch is called." })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;
}
