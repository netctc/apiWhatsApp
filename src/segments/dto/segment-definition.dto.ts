import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;

export class SegmentDefinitionDto {
  @ApiPropertyOptional({ example: "en_US" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string;

  @ApiPropertyOptional({
    type: [String],
    description: "Match contacts having at least one of these normalized tags.",
    example: ["vip", "renewal:2026"],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(TAG_PATTERN, { each: true })
  tagsAny?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: "Match contacts having every one of these normalized tags.",
    example: ["marketing", "vip"],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(TAG_PATTERN, { each: true })
  tagsAll?: string[];
}
