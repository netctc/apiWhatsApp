import { jest } from "@jest/globals";
import { BadRequestException, ConflictException, UnprocessableEntityException } from "@nestjs/common";
import { ConsentStatus } from "../src/generated/prisma/client.js";
import { SegmentsService } from "../src/segments/segments.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const SEGMENT_ID = "f6e7b52b-03a2-4b13-84f9-f616de5d34f2";

describe("SegmentsService", () => {
  const segmentFindFirst = jest.fn();
  const segmentCreate = jest.fn();
  const segmentUpdate = jest.fn();
  const segmentFindMany = jest.fn();
  const contactCount = jest.fn();
  const auditCreate = jest.fn();

  const transactionClient = {
    contactSegment: {
      create: segmentCreate,
      update: segmentUpdate,
    },
    auditLog: {
      create: auditCreate,
    },
  };
  const runTransaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
  );

  const service = new SegmentsService({
    contactSegment: {
      findFirst: segmentFindFirst,
      findMany: segmentFindMany,
    },
    contact: {
      count: contactCount,
    },
    $transaction: runTransaction,
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    segmentFindFirst.mockResolvedValue(null);
    segmentCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: SEGMENT_ID,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));
    auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("rejects a saved segment without a bounded criterion", async () => {
    await expect(
      service.create(TENANT_ID, {
        name: "Everyone",
        definition: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(segmentCreate).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("normalizes name and reusable language/tag criteria before persistence", async () => {
    await service.create(TENANT_ID, {
      name: "  VIP renewals  ",
      description: "  Active renewal audience  ",
      definition: {
        language: " en_US ",
        tagsAny: ["VIP", "renewal:2026", "vip"],
        tagsAll: ["Marketing"],
      },
    });

    expect(segmentFindFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, name: "VIP renewals" },
      select: { id: true },
    });
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(segmentCreate).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT_ID,
        name: "VIP renewals",
        description: "Active renewal audience",
        definition: {
          language: "en_US",
          tagsAny: ["renewal:2026", "vip"],
          tagsAll: ["marketing"],
        },
      },
    });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("rejects a duplicate segment name inside the tenant", async () => {
    segmentFindFirst.mockResolvedValue({ id: SEGMENT_ID });

    await expect(
      service.create(TENANT_ID, {
        name: "VIP renewals",
        definition: { tagsAll: ["vip"] },
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(segmentCreate).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("counts only opted-in contacts owned by the authenticated tenant", async () => {
    segmentFindFirst.mockResolvedValue({
      id: SEGMENT_ID,
      tenantId: TENANT_ID,
      name: "VIP renewals",
      active: true,
      definition: {
        language: "en_US",
        tagsAny: ["renewal:2026", "vip"],
        tagsAll: ["marketing"],
      },
    });
    contactCount.mockResolvedValue(42);

    const result = await service.count(TENANT_ID, SEGMENT_ID);

    expect(segmentFindFirst).toHaveBeenCalledWith({
      where: { id: SEGMENT_ID, tenantId: TENANT_ID },
    });
    expect(contactCount).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        consentStatus: ConsentStatus.OPTED_IN,
        language: "en_US",
        tags: {
          hasSome: ["renewal:2026", "vip"],
          hasEvery: ["marketing"],
        },
      },
    });
    expect(result).toEqual({
      segmentId: SEGMENT_ID,
      active: true,
      count: 42,
      evaluatedAt: expect.any(Date),
    });
  });

  it("resolves only an active tenant segment for campaign snapshotting", async () => {
    const updatedAt = new Date("2026-09-09T18:30:00.000Z");
    segmentFindFirst.mockResolvedValue({
      id: SEGMENT_ID,
      tenantId: TENANT_ID,
      name: "VIP renewals",
      active: true,
      updatedAt,
      definition: { tagsAll: ["VIP"] },
    });

    const result = await service.resolveActiveForCampaign(TENANT_ID, SEGMENT_ID);

    expect(segmentFindFirst).toHaveBeenCalledWith({
      where: { id: SEGMENT_ID, tenantId: TENANT_ID, active: true },
    });
    expect(result).toEqual({
      id: SEGMENT_ID,
      name: "VIP renewals",
      updatedAt,
      definition: { tagsAll: ["vip"] },
    });
  });

  it("fails closed when a campaign references an inactive or foreign segment", async () => {
    segmentFindFirst.mockResolvedValue(null);

    await expect(
      service.resolveActiveForCampaign(TENANT_ID, SEGMENT_ID),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
