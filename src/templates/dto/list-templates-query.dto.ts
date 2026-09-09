import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";

export class ListTemplatesQueryDto {
  @ApiPropertyOptional({ description: "Filter by Meta WhatsApp Business Account ID" })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  wabaId?: string;

  @ApiPropertyOptional({ example: "APPROVED" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  status?: string;

  @ApiPropertyOptional({ example: "UTILITY" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;

  @ApiPropertyOptional({ example: "en_US" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  language?: string;

  @ApiPropertyOptional({ description: "Case-insensitive template name search" })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  name?: string;

  @ApiPropertyOptional({ description: "Template UUID cursor" })
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
