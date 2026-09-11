import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ConversationNotePageDto } from "./dto/conversation-note-page.dto.js";
import type { ListConversationNotesQueryDto } from "./dto/list-conversation-notes-query.dto.js";

const noteSelect = {
  id: true,
  conversationId: true,
  body: true,
  createdAt: true,
  createdByApiKey: { select: { id: true, name: true } },
} satisfies Prisma.ConversationNoteSelect;

@Injectable()
export class ConversationNotesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenantId: string,
    conversationId: string,
    query: ListConversationNotesQueryDto,
  ): Promise<ConversationNotePageDto> {
    // Bound internal callers as well as HTTP requests; never allow an unbounded read.
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new BadRequestException("Note limit must be an integer between 1 and 100");
    }

    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true },
    });
    if (!conversation) {
      throw new NotFoundException("Conversation not found");
    }

    if (query.cursor !== undefined) {
      const cursor = await this.prisma.conversationNote.findFirst({
        where: { id: query.cursor, tenantId, conversationId },
        select: { id: true },
      });
      if (!cursor) {
        throw new BadRequestException("Note cursor is invalid for this conversation");
      }
    }

    const rows = await this.prisma.conversationNote.findMany({
      where: { tenantId, conversationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      // Let the database resolve the immutable anchor; do not round its timestamp in JS.
      ...(query.cursor !== undefined ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: noteSelect,
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }
}
