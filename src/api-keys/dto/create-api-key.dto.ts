import { ApiProperty } from "@nestjs/swagger";
import { ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsString, MaxLength, MinLength } from "class-validator";
import { ApiScope } from "../../auth/auth.constants.js";

export class CreateApiKeyDto {
  @ApiProperty({ example: "crm-production" })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ enum: ApiScope, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(ApiScope, { each: true })
  scopes!: ApiScope[];
}
