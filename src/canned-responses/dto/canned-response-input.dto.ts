import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsString, IsUUID, Length, Matches, Max, Min, ValidateIf } from "class-validator";
import { MAX_REVISION, SHORTCUT_PATTERN } from "../canned-response.policy.js";

const trim = ({ value }: { value: unknown }): unknown => typeof value === "string" ? value.trim() : value;
const shortcut = ({ value }: { value: unknown }): unknown => typeof value === "string" ? value.trim().toLowerCase() : value;
const present = (_: unknown, value: unknown): boolean => value !== undefined;

export class CreateCannedResponseDto {
  @ApiProperty({ maxLength: 32, pattern: "^[a-z][a-z0-9_-]{0,31}$", example: "order_status" })
  @Transform(shortcut)
  @IsString()
  @Matches(SHORTCUT_PATTERN)
  shortcut!: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  title!: string;

  @ApiProperty({ minLength: 1, maxLength: 4096, description: "Plain text; no template or expression evaluation" })
  @Transform(trim)
  @IsString()
  @Length(1, 4096)
  body!: string;
}

export class UpdateCannedResponseDto {
  @ApiProperty({ minimum: 1, maximum: MAX_REVISION, description: "Revision returned by the last read; stale updates return 409" })
  @IsInt()
  @Min(1)
  @Max(MAX_REVISION)
  expectedRevision!: number;

  @ApiPropertyOptional({ maxLength: 32, pattern: "^[a-z][a-z0-9_-]{0,31}$" })
  @ValidateIf(present)
  @Transform(shortcut)
  @IsString()
  @Matches(SHORTCUT_PATTERN)
  shortcut?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  title?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 4096 })
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @Length(1, 4096)
  body?: string;

  @ApiPropertyOptional({ description: "Deactivate instead of deleting; the shortcut remains reserved" })
  @ValidateIf(present)
  @IsBoolean()
  active?: boolean;
}

export class ListCannedResponsesQueryDto {
  @ApiPropertyOptional({ enum: ["active", "inactive", "all"], default: "active" })
  @IsIn(["active", "inactive", "all"])
  status: "active" | "inactive" | "all" = "active";

  @ApiPropertyOptional({ description: "Exact normalized shortcut match", maxLength: 32 })
  @ValidateIf(present)
  @Transform(shortcut)
  @IsString()
  @Matches(SHORTCUT_PATTERN)
  shortcut?: string;

  @ApiPropertyOptional({ format: "uuid", description: "Exclusive UUIDv4 cursor owned by this tenant" })
  @ValidateIf(present)
  @IsUUID("4")
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @Transform(({ value }: { value: unknown }) => typeof value === "string" && /^[1-9][0-9]{0,2}$/.test(value) ? Number(value) : value)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
