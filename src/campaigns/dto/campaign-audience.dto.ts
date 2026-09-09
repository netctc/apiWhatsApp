import { ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class CampaignAudienceDto {
  @ApiPropertyOptional({
    description: "Snapshot every currently opted-in tenant contact. Cannot be combined with contactIds.",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allOptedIn?: boolean;

  @ApiPropertyOptional({
    description: "Explicit tenant contact UUIDs. Only contacts still opted in at launch are snapshotted.",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50000)
  @IsUUID("4", { each: true })
  contactIds?: string[];

  @ApiPropertyOptional({ description: "Optional contact language filter applied at launch." })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  language?: string;
}
