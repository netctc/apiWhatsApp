import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

export class CreateContactDto {
  @ApiProperty({ example: "+96170123456" })
  @IsString()
  phone!: string;

  @ApiPropertyOptional({ example: "Jane Doe" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: "en" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string;

  @ApiPropertyOptional({ example: "Asia/Beirut" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ["vip", "renewal:2026"],
    description: "Case-insensitive contact segmentation tags. Stored normalized to lowercase.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: "Provider-neutral custom contact metadata" })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
