import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateInboxAgentDto {
  @ApiProperty({ example: "Support Agent" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: "Optional tenant-defined identity from an external workforce system" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  externalId?: string;

  @ApiPropertyOptional({ example: "agent@example.com" })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ description: "Provider-neutral operational metadata" })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
