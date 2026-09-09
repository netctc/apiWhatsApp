import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator";

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

  @ApiPropertyOptional({ description: "Optional exact contact language filter applied at launch." })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  language?: string;

  @ApiPropertyOptional({
    type: [String],
    description: "Require at least one normalized contact tag from this set.",
    example: ["vip", "renewal:2026"],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/, { each: true })
  tagsAny?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: "Require every normalized contact tag in this set.",
    example: ["marketing", "vip"],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/, { each: true })
  tagsAll?: string[];
}
