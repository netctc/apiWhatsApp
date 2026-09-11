import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { CreateCannedResponseDto, ListCannedResponsesQueryDto, UpdateCannedResponseDto } from "../src/canned-responses/dto/canned-response-input.dto.js";

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const query = (input: unknown) => pipe.transform(input, { type: "query", metatype: ListCannedResponsesQueryDto });

describe("canned response HTTP validation", () => {
  it("defaults to active responses and 50 rows", async () => expect(await query({})).toMatchObject({ status: "active", limit: 50 }));
  it("accepts normalized exact shortcuts and the upper page bound", async () => expect(await query({ shortcut: " HELLO ", status: "all", limit: "100" })).toMatchObject({ shortcut: "hello", status: "all", limit: 100 }));
  for (const value of ["0", "101", "-1", "1.5", "1e2", "0x10", "01", " 2", "", ["2", "3"], null]) {
    it(`rejects malformed limit ${JSON.stringify(value)}`, async () => expect(query({ limit: value })).rejects.toBeInstanceOf(BadRequestException));
  }
  for (const input of [{ tenantId: "foreign" }, { cursor: "invalid" }, { cursor: null }, { status: "unknown" }, { status: null }, { shortcut: ["a", "b"] }]) {
    it(`rejects invalid query ${JSON.stringify(input)}`, async () => expect(query(input)).rejects.toBeInstanceOf(BadRequestException));
  }
  it("normalizes a valid create DTO", async () => {
    expect(await pipe.transform({ shortcut: " HELLO ", title: " Title ", body: " Body " }, { type: "body", metatype: CreateCannedResponseDto })).toMatchObject({ shortcut: "hello", title: "Title", body: "Body" });
  });
  for (const input of [{ expectedRevision: 1, title: null }, { expectedRevision: "1", active: false }, { expectedRevision: 1, active: "false" }, { expectedRevision: 1, body: " " }, { expectedRevision: 1, revision: 2 }, { title: "Missing revision" }]) {
    it(`rejects invalid patch ${JSON.stringify(input)}`, async () => expect(pipe.transform(input, { type: "body", metatype: UpdateCannedResponseDto })).rejects.toBeInstanceOf(BadRequestException));
  }
});
