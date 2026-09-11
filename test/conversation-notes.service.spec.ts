import { jest } from "@jest/globals";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConversationNotesService } from "../src/inbox/conversation-notes.service.js";
import type { ConversationNoteDto } from "../src/inbox/dto/conversation-note-page.dto.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const noteId = "33333333-3333-4333-8333-333333333333";
const note = (id: string): ConversationNoteDto => ({
  id, conversationId, body: "Internal note", createdAt: new Date("2026-01-01T00:00:00Z"),
  createdByApiKey: null,
});

function fixture(rows: ConversationNoteDto[] = []) {
  const conversation = jest.fn<(args: unknown) => Promise<{ id: string } | null>>()
    .mockResolvedValue({ id: conversationId });
  const anchor = jest.fn<(args: unknown) => Promise<{ id: string } | null>>()
    .mockResolvedValue({ id: noteId });
  const page = jest.fn<(args: unknown) => Promise<ConversationNoteDto[]>>()
    .mockResolvedValue(rows);
  const service = new ConversationNotesService({
    conversation: { findFirst: conversation },
    conversationNote: { findFirst: anchor, findMany: page },
  } as never);
  return { service, conversation, anchor, page };
}

describe("ConversationNotesService", () => {
  it("returns an empty page for an owned conversation with no notes", async () => {
    const f = fixture();
    await expect(f.service.list(tenantId, conversationId, { limit: 50 }))
      .resolves.toEqual({ items: [], nextCursor: null });
    expect(f.conversation).toHaveBeenCalledWith({
      where: { id: conversationId, tenantId }, select: { id: true },
    });
    expect(f.anchor).not.toHaveBeenCalled();
  });

  it("selects only public note and author fields and reads at most limit + 1", async () => {
    const f = fixture([note(noteId)]);
    await f.service.list(tenantId, conversationId, { limit: 50 });
    expect(f.page).toHaveBeenCalledWith({
      where: { tenantId, conversationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      select: {
        id: true, conversationId: true, body: true, createdAt: true,
        createdByApiKey: { select: { id: true, name: true } },
      },
    });
  });

  it("uses the last returned note, not the lookahead note, as the next cursor", async () => {
    const f = fixture([note("a"), note("b"), note("c")]);
    await expect(f.service.list(tenantId, conversationId, { limit: 2 }))
      .resolves.toEqual({ items: [note("a"), note("b")], nextCursor: "b" });
  });

  it("returns null after a final page that exactly fills the requested limit", async () => {
    const f = fixture([note("a"), note("b")]);
    await expect(f.service.list(tenantId, conversationId, { limit: 2 }))
      .resolves.toEqual({ items: [note("a"), note("b")], nextCursor: null });
  });

  it("keeps the database cursor and deterministic order after scoping the anchor", async () => {
    const f = fixture([note("older")]);
    await f.service.list(tenantId, conversationId, { cursor: noteId, limit: 1 });
    expect(f.anchor).toHaveBeenCalledWith({
      where: { id: noteId, tenantId, conversationId }, select: { id: true },
    });
    expect(f.page).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId, conversationId }, cursor: { id: noteId }, skip: 1, take: 2,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
    expect(f.conversation.mock.invocationCallOrder[0]).toBeLessThan(f.anchor.mock.invocationCallOrder[0]);
    expect(f.anchor.mock.invocationCallOrder[0]).toBeLessThan(f.page.mock.invocationCallOrder[0]);
  });

  it("does not inspect notes or cursor when the conversation is unavailable", async () => {
    const f = fixture();
    f.conversation.mockResolvedValue(null);
    await expect(f.service.list(tenantId, conversationId, { cursor: noteId, limit: 50 }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(f.anchor).not.toHaveBeenCalled();
    expect(f.page).not.toHaveBeenCalled();
  });

  it("rejects an anchor outside the conversation without fetching note content", async () => {
    const f = fixture();
    f.anchor.mockResolvedValue(null);
    await expect(f.service.list(tenantId, conversationId, { cursor: noteId, limit: 50 }))
      .rejects.toThrow("Note cursor is invalid for this conversation");
    expect(f.page).not.toHaveBeenCalled();
  });

  for (const limit of [0, -1, 101, 1.5, NaN, Infinity, null, undefined, "10"]) {
    it(`rejects invalid internal limit ${String(limit)} before database access`, async () => {
      const f = fixture();
      await expect(f.service.list(tenantId, conversationId, { limit: limit as number }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(f.conversation).not.toHaveBeenCalled();
      expect(f.page).not.toHaveBeenCalled();
    });
  }

  it("does not turn a database failure into a successful empty page", async () => {
    const f = fixture();
    const failure = new Error("Database unavailable");
    f.page.mockRejectedValue(failure);
    await expect(f.service.list(tenantId, conversationId, { limit: 50 })).rejects.toBe(failure);
  });
});
