import { jest } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";
import { CannedResponsesService } from "../src/canned-responses/canned-responses.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const anchor = { id: "33333333-3333-4333-8333-333333333333", createdAt: new Date("2026-01-01T12:00:00.123Z") };
const row = {
  id: "22222222-2222-4222-8222-222222222222", shortcut: "hello", title: "Greeting", body: "Private text",
  active: true, revision: 1, createdAt: anchor.createdAt, updatedAt: anchor.createdAt,
};
const boundary = { OR: [
  { createdAt: { lt: anchor.createdAt } },
  { createdAt: anchor.createdAt, id: { lt: anchor.id } },
] };
const projection = { id: true, shortcut: true, title: true, body: true, active: true, revision: true, createdAt: true, updatedAt: true };

function setup() {
  const findFirst = jest.fn<(arg: unknown) => Promise<unknown>>().mockResolvedValue(anchor);
  const findMany = jest.fn<(arg: unknown) => Promise<unknown>>().mockResolvedValue([row]);
  const service = new CannedResponsesService({ inboxCannedResponse: { findFirst, findMany } } as never);
  return { service, findFirst, findMany };
}

describe("canned response exclusive pagination boundary", () => {
  for (const status of ["active", "inactive", "all"] as const) {
    for (const shortcut of [undefined, " HELLO "]) {
      it(`combines the boundary with ${status} and ${shortcut === undefined ? "no" : "exact"} shortcut filter`, async () => {
        const { service, findFirst, findMany } = setup();
        await service.list(tenantId, { status, limit: 2, cursor: anchor.id, shortcut });
        expect(findFirst).toHaveBeenCalledTimes(1);
        expect(findFirst).toHaveBeenCalledWith({ where: { id: anchor.id, tenantId }, select: { id: true, createdAt: true } });
        expect(findMany).toHaveBeenCalledWith({
          where: { tenantId, ...(status === "all" ? {} : { active: status === "active" }), ...(shortcut === undefined ? {} : { shortcut: "hello" }), ...boundary },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 3, select: projection,
        });
      });
    }
  }

  it("does not resolve an anchor or include an offset on the first page", async () => {
    const { service, findFirst, findMany } = setup();
    await service.list(tenantId, { status: "active", limit: 50 });
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId, active: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 51, select: projection,
    });
  });

  it("rejects a missing or unowned anchor before loading content", async () => {
    const { service, findFirst, findMany } = setup();
    findFirst.mockResolvedValue(null);
    await expect(service.list(tenantId, { status: "all", limit: 1, cursor: anchor.id })).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("propagates anchor database errors without attempting an unbounded fallback", async () => {
    const { service, findFirst, findMany } = setup();
    const error = new Error("database unavailable");
    findFirst.mockRejectedValue(error);
    await expect(service.list(tenantId, { status: "all", limit: 1, cursor: anchor.id })).rejects.toBe(error);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("propagates page database errors rather than returning a false empty page", async () => {
    const { service, findMany } = setup();
    const error = new Error("page unavailable");
    findMany.mockRejectedValue(error);
    await expect(service.list(tenantId, { status: "active", limit: 2, cursor: anchor.id })).rejects.toBe(error);
  });

  it("uses the last returned older row, not the lookahead or old anchor, as next cursor", async () => {
    const { service, findMany } = setup();
    findMany.mockResolvedValue([row, { ...row, id: "11111111-1111-4111-8111-111111111111" }]);
    expect(await service.list(tenantId, { status: "active", limit: 1, cursor: anchor.id })).toEqual({ items: [row], nextCursor: row.id });
  });

  it("terminates an exactly full final page", async () => {
    const { service } = setup();
    expect(await service.list(tenantId, { status: "active", limit: 1, cursor: anchor.id })).toEqual({ items: [row], nextCursor: null });
  });

  it("terminates an empty older page", async () => {
    const { service, findMany } = setup();
    findMany.mockResolvedValue([]);
    expect(await service.list(tenantId, { status: "all", limit: 1, cursor: anchor.id })).toEqual({ items: [], nextCursor: null });
  });

  it("bounds the largest accepted page to 101 selected rows", async () => {
    const { service, findMany } = setup();
    await service.list(tenantId, { status: "all", limit: 100, cursor: anchor.id });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101, select: projection }));
  });
});
