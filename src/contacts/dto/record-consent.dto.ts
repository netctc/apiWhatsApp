import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsDateString, IsEnum, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { ConsentStatus } from "../../generated/prisma/client.js";

export class RecordConsentDto {
  @ApiProperty({ enum: ConsentStatus, example: ConsentStatus.OPTED_IN })
  @IsEnum(ConsentStatus)
  status!: ConsentStatus;

  @ApiProperty({ example: "checkout_checkbox" })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  source!: string;

  @ApiPropertyOptional({ description: "Evidence supporting the consent event" })
  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;

  @ApiPropertyOptional({ example: "2026-09" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  policyVersion?: string;

  @ApiPropertyOptional({
    description: "When the consent event actually occurred. Defaults to the API receipt time.",
    example: "2026-09-08T18:00:00.000Z",
  })
  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}
