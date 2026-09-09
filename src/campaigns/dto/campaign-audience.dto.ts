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
    description: "Snapshot every currently opted-in tenant contact. Cannot be combined with contactIds or segmentId.",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allOptedIn?: boolean;

  @ApiPropertyOptional({
    description: "Explicit tenant contact UUIDs. Cannot be combined with allOptedIn or segmentId.",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50000)
  @IsUUID("4", { each: true })
  contactIds?: string[];

  @ApiPropertyOptional({
    description: "Active saved contact segment UUID. Its definition is copied into the campaign draft.",
  })
  @IsOptional()
  @IsUUID("4")
  segmentId?: string;

  @ApiPropertyOptional({
    description: "Optional exact contact language filter. Not accepted when segmentId is used.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  language?: string;

  @ApiPropertyOptional({
    type: [String],
    description: "Require at least one normalized contact tag. Not accepted when segmentId is used.",
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
    description: "Require every normalized contact tag. Not accepted when segmentId is used.",
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
