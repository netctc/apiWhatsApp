import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateInboxSkillDto {
  @ApiProperty({ example: "Billing" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: "Optional provider-neutral description for operators" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
