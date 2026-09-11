import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

export class ConversationAgentActionDto {
  @ApiProperty({
    format: "uuid",
    description: "Tenant inbox-agent UUID performing the cooperative claim or release action.",
  })
  @IsUUID("4")
  agentId!: string;
}
