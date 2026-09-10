import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";

const SECRET_REFERENCE_PATTERN = /^(?:env:[A-Z_][A-Z0-9_]*|file:\/[^\0\r\n]{1,500})$/;

export class CreatePhoneNumberDto {
  @ApiProperty({ example: "27681414235104944" })
  @IsString()
  @Matches(/^\d+$/)
  providerPhoneNumberId!: string;

  @ApiPropertyOptional({ example: "8856996819413533" })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  wabaId?: string;

  @ApiPropertyOptional({ example: "16505553333" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  displayPhoneNumber?: string;

  @ApiPropertyOptional({ example: "Acme Support" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  verifiedName?: string;

  @ApiProperty({
    example: "env:META_ACME_WHATSAPP_TOKEN",
    description:
      "Reference to the secret containing the Meta access token. Supports env:VARIABLE_NAME or file:/absolute/path. Raw tokens must not be stored in the database.",
  })
  @IsString()
  @MaxLength(512)
  @Matches(SECRET_REFERENCE_PATTERN)
  credentialRef!: string;

  @ApiPropertyOptional({ example: 75, minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  rateLimitPerSecond?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
