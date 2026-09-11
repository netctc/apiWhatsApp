import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsUUID } from "class-validator";
import { ConversationPriority, ConversationStatus } from "../../generated/prisma/client.js";

export class UpdateConversationDto {
  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional({ enum: ConversationPriority })
  @IsOptional()
  @IsEnum(ConversationPriority)
  priority?: ConversationPriority;

  @ApiPropertyOptional({
    nullable: true,
    description: "Tenant inbox-agent UUID. Send null to unassign the conversation.",
  })
  @IsOptional()
  @IsUUID()
  assignedAgentId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "Tenant inbox-team UUID. Send null to remove the explicit team assignment.",
  })
  @IsOptional()
  @IsUUID()
  assignedTeamId?: string | null;
}
