import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsEmail, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class UpdateInboxAgentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  externalId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ description: "Provider-neutral operational metadata" })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
