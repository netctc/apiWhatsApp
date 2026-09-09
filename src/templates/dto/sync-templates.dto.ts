import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsUUID } from "class-validator";

export class SyncTemplatesDto {
  @ApiPropertyOptional({
    description: "Tenant sender used to resolve the WABA and Meta credential. Uses the active default sender when omitted.",
  })
  @IsOptional()
  @IsUUID()
  senderId?: string;
}
