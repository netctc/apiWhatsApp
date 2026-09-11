import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsInt, IsUUID, Max, Min, ValidateIf } from "class-validator";

export class ListConversationNotesQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "Last returned note UUID; must belong to this tenant and conversation",
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID("4")
  cursor?: string;

  @ApiPropertyOptional({ type: Number, default: 50, minimum: 1, maximum: 100 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" && /^[1-9]\d{0,2}$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
