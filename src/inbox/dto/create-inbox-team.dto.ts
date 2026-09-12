import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class CreateInboxTeamDto {
  @ApiProperty({ example: "Customer Support" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: "Optional provider-neutral description for operators" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

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
