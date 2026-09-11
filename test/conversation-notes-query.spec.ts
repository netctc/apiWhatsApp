import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { ListConversationNotesQueryDto } from "../src/inbox/dto/list-conversation-notes-query.dto.js";

const cursor = "33333333-3333-4333-8333-333333333333";
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validate = (value: unknown): Promise<ListConversationNotesQueryDto> =>
  pipe.transform(value, { type: "query", metatype: ListConversationNotesQueryDto });

describe("ListConversationNotesQueryDto", () => {
  it("defaults to 50 notes and an absent cursor", async () => {
    const query = await validate({});
    expect(query.limit).toBe(50);
    expect(query.cursor).toBeUndefined();
  });

  for (const limit of ["1", "50", "100"]) {
    it(`accepts decimal limit ${limit} and a UUIDv4 cursor`, async () => {
      const query = await validate({ limit, cursor });
      expect(query.limit).toBe(Number(limit));
      expect(query.cursor).toBe(cursor);
    });
  }

  for (const [label, limit] of Object.entries({
    zero: "0", negative: "-1", excessive: "101", fraction: "1.5", exponential: "1e2",
    hex: "0x10", empty: "", whitespace: " 10 ", leadingZero: "01", array: ["1"],
    boolean: true, null: null, object: {}, notANumber: "NaN", infinity: "Infinity",
  })) {
    it(`rejects ${label} limits instead of coercing them`, async () => {
      await expect(validate({ limit })).rejects.toBeInstanceOf(BadRequestException);
    });
  }

  for (const [label, value] of Object.entries({
    malformed: "not-a-uuid", empty: "", null: null, array: [cursor], object: {},
    padded: ` ${cursor}`, wrongVersion: "33333333-3333-1333-8333-333333333333",
  })) {
    it(`rejects ${label} cursors`, async () => {
      await expect(validate({ cursor: value })).rejects.toBeInstanceOf(BadRequestException);
    });
  }

  for (const field of ["tenantId", "conversationId", "sort", "body"]) {
    it(`rejects unrecognized query field ${field}`, async () => {
      await expect(validate({ [field]: "untrusted" })).rejects.toBeInstanceOf(BadRequestException);
    });
  }
});
