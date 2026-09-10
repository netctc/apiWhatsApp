import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

export class CreateConversationNoteDto {
  @ApiProperty({ example: "Customer requested a call back after 16:00." })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}
