import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";

const SECRET_REFERENCE_PATTERN = /^(?:env:[A-Z_][A-Z0-9_]*|file:\/[^\0\r\n]{1,500})$/;

export class UpdatePhoneNumberDto {
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

  @ApiPropertyOptional({
    example: "file:/run/secrets/api-whatsapp/meta-token",
    description: "Meta access-token secret reference using env:VARIABLE_NAME or file:/absolute/path.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(SECRET_REFERENCE_PATTERN)
  credentialRef?: string;

  @ApiPropertyOptional({ example: 75, minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  rateLimitPerSecond?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
