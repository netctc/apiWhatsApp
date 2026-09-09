import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { SegmentDefinitionDto } from "./segment-definition.dto.js";

export class UpdateSegmentDto {
  @ApiPropertyOptional({ example: "VIP renewals" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: "Updated segment description." })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ type: SegmentDefinitionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SegmentDefinitionDto)
  definition?: SegmentDefinitionDto;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
