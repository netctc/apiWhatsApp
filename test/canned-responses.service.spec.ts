import { jest } from "@jest/globals";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "../src/generated/prisma/client.js";
import { CannedResponsesService } from "../src/canned-responses/canned-responses.service.js";

const principal = { tenantId: "11111111-1111-4111-8111-111111111111", apiKeyId: "22222222-2222-4222-8222-222222222222", scopes: ["inbox:read", "inbox:write"] };
const row = { id: "33333333-3333-4333-8333-333333333333", shortcut: "hello", title: "Greeting", body: "Sensitive text", active: true, revision: 1, createdAt: new Date(0), updatedAt: new Date(0) };
function setup() {
  const model = {
    create: jest.fn<(arg: unknown) => Promise<unknown>>().mockResolvedValue(row),
    updateMany: jest.fn<(arg: unknown) => Promise<unknown>>().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn<(arg: unknown) => Promise<unknown>>().mockResolvedValue(row),
    findFirstOrThrow: jest.fn<(arg: unknown) => Promise<unknown>>().mockResolvedValue({ ...row, revision: 2 }),
    findMany: jest.fn<(arg: unknown) => Promise<unknown>>().mockResolvedValue([row]),
  };
  const audit = jest.fn<(arg: unknown) => Promise<unknown>>().mockResolvedValue({});
  const tx = { inboxCannedResponse: model, auditLog: { create: audit } };
  const transaction = jest.fn<(callback: (client: unknown) => Promise<unknown>) => Promise<unknown>>().mockImplementation((callback) => callback(tx));
  return { model, audit, transaction, service: new CannedResponsesService({ ...tx, $transaction: transaction } as never) };
}

describe("CannedResponsesService", () => {
  it("creates under the principal and audits without copying content", async () => {
    const { service, model, audit } = setup();
    await service.create(principal, { shortcut: " HELLO ", title: row.title, body: row.body });
    expect(model.create).toHaveBeenCalledWith(expect.objectContaining({ data: { tenantId: principal.tenantId, shortcut: "hello", title: row.title, body: row.body } }));
    expect(audit).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: principal.tenantId, actorApiKeyId: principal.apiKeyId, action: "inbox.canned_response.created", metadata: { revision: 1, active: true } }) });
    expect(JSON.stringify(audit.mock.calls)).not.toContain(row.body);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(row.title);
  });
  it("rejects invalid create before opening a transaction", async () => {
    const { service, transaction } = setup();
    await expect(service.create(principal, { shortcut: "bad shortcut", title: "T", body: "B" })).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });
  it("compares tenant and revision atomically and audits structural changes", async () => {
    const { service, model, audit } = setup();
    await service.update(principal, row.id, { expectedRevision: 1, title: "Updated" });
    expect(model.updateMany).toHaveBeenCalledWith({ where: { id: row.id, tenantId: principal.tenantId, revision: 1 }, data: { title: "Updated", revision: { increment: 1 } } });
    expect(audit).toHaveBeenCalledWith({ data: expect.objectContaining({ metadata: { changedFields: ["title"], revision: 2, active: true } }) });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("Updated");
  });
  it("returns 409 for a stale owned revision without an audit write", async () => {
    const { service, model, audit } = setup(); model.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.update(principal, row.id, { expectedRevision: 1, active: false })).rejects.toBeInstanceOf(ConflictException);
    expect(model.findFirst).toHaveBeenCalledWith({ where: { id: row.id, tenantId: principal.tenantId }, select: { id: true } });
    expect(audit).not.toHaveBeenCalled();
  });
  it("returns the same 404 for missing or unowned update targets", async () => {
    const { service, model, audit } = setup(); model.updateMany.mockResolvedValue({ count: 0 }); model.findFirst.mockResolvedValue(null);
    await expect(service.update(principal, row.id, { expectedRevision: 1, active: false })).rejects.toBeInstanceOf(NotFoundException);
    expect(audit).not.toHaveBeenCalled();
  });
  it("maps duplicate shortcuts to a safe conflict", async () => {
    const { service, model } = setup();
    model.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("private db detail", { code: "P2002", clientVersion: "test" }));
    await expect(service.create(principal, { shortcut: row.shortcut, title: row.title, body: row.body })).rejects.toThrow("Canned response shortcut already exists in this tenant");
  });
  it("propagates audit failure out of the transaction", async () => {
    const { service, audit } = setup(); const failure = new Error("audit unavailable"); audit.mockRejectedValue(failure);
    await expect(service.update(principal, row.id, { expectedRevision: 1, active: false })).rejects.toBe(failure);
  });
  it("bounds and scopes list queries with a minimal projection", async () => {
    const { service, model } = setup();
    expect(await service.list(principal.tenantId, { status: "active", limit: 50 })).toEqual({ items: [row], nextCursor: null });
    expect(model.findMany).toHaveBeenCalledWith({ where: { tenantId: principal.tenantId, active: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 51, select: { id: true, shortcut: true, title: true, body: true, active: true, revision: true, createdAt: true, updatedAt: true } });
  });
  it("uses the last returned item rather than the lookahead as cursor", async () => {
    const { service, model } = setup();
    const older = { ...row, id: "22222222-2222-4222-8222-222222222222", shortcut: "older" };
    model.findMany.mockResolvedValue([older, { ...row, id: "11111111-1111-4111-8111-111111111111", shortcut: "oldest" }]);
    expect(await service.list(principal.tenantId, { status: "all", limit: 1, cursor: row.id })).toEqual({ items: [older], nextCursor: older.id });
    expect(model.findFirst).toHaveBeenCalledWith({ where: { id: row.id, tenantId: principal.tenantId }, select: { id: true, createdAt: true } });
    expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: principal.tenantId, OR: [
        { createdAt: { lt: row.createdAt } },
        { createdAt: row.createdAt, id: { lt: row.id } },
      ] }, take: 2,
    }));
  });
  it("rejects a foreign cursor before loading page content", async () => {
    const { service, model } = setup(); model.findFirst.mockResolvedValue(null);
    await expect(service.list(principal.tenantId, { status: "all", limit: 1, cursor: row.id })).rejects.toBeInstanceOf(BadRequestException);
    expect(model.findMany).not.toHaveBeenCalled();
  });
  it("rejects unbounded internal list calls", async () => {
    const { service, model } = setup();
    await expect(service.list(principal.tenantId, { status: "all", limit: 101 })).rejects.toBeInstanceOf(BadRequestException);
    expect(model.findMany).not.toHaveBeenCalled();
  });
  it("does not query an unscoped record for detail reads", async () => {
    const { service, model } = setup(); model.findFirst.mockResolvedValue(null);
    await expect(service.find(principal.tenantId, row.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(model.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: row.id, tenantId: principal.tenantId } }));
  });
});
