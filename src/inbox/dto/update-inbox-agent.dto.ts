import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsEmail, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

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

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 10000,
    description: "Maximum OPEN/PENDING conversations accepted by this agent; null means unlimited",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  maxConcurrentConversations?: number | null;

  @ApiPropertyOptional({ description: "Provider-neutral operational metadata" })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
