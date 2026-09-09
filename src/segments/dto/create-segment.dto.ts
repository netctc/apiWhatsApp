import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDefined,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { SegmentDefinitionDto } from "./segment-definition.dto.js";

export class CreateSegmentDto {
  @ApiProperty({ example: "VIP renewals" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: "Opted-in VIP contacts targeted for renewal campaigns." })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ type: SegmentDefinitionDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => SegmentDefinitionDto)
  definition!: SegmentDefinitionDto;
}
