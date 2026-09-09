import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";
import { CampaignRecipientStatus } from "../../generated/prisma/client.js";

export class ListCampaignRecipientsQueryDto {
  @ApiPropertyOptional({ enum: CampaignRecipientStatus })
  @IsOptional()
  @IsEnum(CampaignRecipientStatus)
  status?: CampaignRecipientStatus;

  @ApiPropertyOptional({ description: "Campaign recipient UUID cursor" })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
