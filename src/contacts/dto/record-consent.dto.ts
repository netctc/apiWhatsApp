import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsISO8601, IsObject, IsOptional, IsString, MaxLength } from "class-validator";

export enum ConsentDecision {
  OPTED_IN = "OPTED_IN",
  OPTED_OUT = "OPTED_OUT",
}

export class RecordConsentDto {
  @ApiProperty({ enum: ConsentDecision })
  @IsEnum(ConsentDecision)
  status!: ConsentDecision;

  @ApiProperty({ example: "website_checkout" })
  @IsString()
  @MaxLength(100)
  source!: string;

  @ApiPropertyOptional({ description: "Audit evidence such as form version or source reference" })
  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;

  @ApiPropertyOptional({ example: "2026-09-08T18:00:00.000Z" })
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}
