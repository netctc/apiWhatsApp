import { ApiProperty } from "@nestjs/swagger";

export class ConversationNoteAuthorDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ description: "API-key display name, not a human-agent identity" })
  name!: string;
}

export class ConversationNoteDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, format: "uuid" })
  conversationId!: string;

  @ApiProperty({ description: "Internal note text; render as text, never as trusted HTML" })
  body!: string;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: Date;

  @ApiProperty({ type: () => ConversationNoteAuthorDto, nullable: true })
  createdByApiKey!: ConversationNoteAuthorDto | null;
}

export class ConversationNotePageDto {
  @ApiProperty({ type: () => ConversationNoteDto, isArray: true })
  items!: ConversationNoteDto[];

  @ApiProperty({
    type: String,
    format: "uuid",
    nullable: true,
    description: "Last returned note UUID when more notes exist; otherwise null",
  })
  nextCursor!: string | null;
}
