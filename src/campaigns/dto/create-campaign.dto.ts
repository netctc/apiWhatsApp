import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDefined,
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
  @IsDefined()
  @ValidateNested()
  @Type(() => CampaignAudienceDto)
  audience!: CampaignAudienceDto;

  @ApiPropertyOptional({
    description:
      "Enable safe per-recipient replacement of allowlisted full-value contact tokens inside components. Defaults to false for backward compatibility.",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  personalizationEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      "Meta template components. Static by default; when personalizationEnabled=true, allowlisted full-value contact tokens are rendered per recipient.",
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
