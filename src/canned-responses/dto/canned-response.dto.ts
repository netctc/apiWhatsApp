import { ApiProperty } from "@nestjs/swagger";

export class CannedResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty()
  shortcut!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ description: "Render as text, not trusted HTML" })
  body!: string;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ minimum: 1 })
  revision!: number;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: Date;

  @ApiProperty({ type: String, format: "date-time" })
  updatedAt!: Date;
}

export class CannedResponsePageDto {
  @ApiProperty({ type: [CannedResponseDto] })
  items!: CannedResponseDto[];

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  nextCursor!: string | null;
}
