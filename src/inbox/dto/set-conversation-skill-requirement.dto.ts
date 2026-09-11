import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Max, Min } from "class-validator";

export class SetConversationSkillRequirementDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 3 })
  @IsInt()
  @Min(1)
  @Max(5)
  minLevel!: number;
}
