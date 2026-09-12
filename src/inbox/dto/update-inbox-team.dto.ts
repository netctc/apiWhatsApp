import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class UpdateInboxTeamDto {
  @ApiPropertyOptional({ example: "Tier 2 Support" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: "Set an empty string to clear the description" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    description: "Response SLA target in minutes for future customer-turn cycles; null disables the policy",
    minimum: 1,
    maximum: 10080,
    nullable: true,
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  responseSlaMinutes?: number | null;
}
