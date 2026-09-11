import { jest } from "@jest/globals";
import { MediaAssetRetentionService } from "../src/media/media-asset-retention.service.js";

const CLEANUP_ENV = "MEDIA_ASSET_CLEANUP_INTERVAL_MS";
const STALE_UPLOAD_ENV = "MEDIA_ASSET_STALE_UPLOAD_MS";

describe("MediaAssetRetentionService", () => {
  const findMany = jest.fn();
  const deleteMany = jest.fn();
  const updateMany = jest.fn();
  const discard = jest.fn();
  const service = new MediaAssetRetentionService(
    {
      mediaAsset: { findMany, deleteMany, updateMany },
    } as never,
    { discard } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[CLEANUP_ENV];
    delete process.env[STALE_UPLOAD_ENV];
    findMany.mockResolvedValue([]);
    deleteMany.mockResolvedValue({ count: 1 });
    updateMany.mockResolvedValue({ count: 1 });
    discard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    delete process.env[CLEANUP_ENV];
    delete process.env[STALE_UPLOAD_ENV];
  });

  it("marks stale unfinished uploads failed and cleans retained binaries", async () => {
    const now = new Date("2026-09-11T12:00:00.000Z");
    const staleBefore = new Date("2026-09-11T10:00:00.000Z");
    findMany.mockResolvedValue([
      {
        id: "asset-stale",
        storageMode: "FILESYSTEM",
        storageKey: "tenant/asset-stale",
        failureCode: null,
      },
      {
        id: "asset-retry",
        storageMode: "S3",
        storageKey: "tenant/asset-retry",
        failureCode: "UPLOAD_ABANDONED",
      },
      {
        id: "asset-disabled",
        storageMode: "DISABLED",
        storageKey: null,
        failureCode: null,
      },
    ]);

    await expect(service.reconcileStaleUploads(now)).resolves.toEqual({
      markedFailed: 2,
      binariesCleaned: 2,
      cleanupDeferred: 0,
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        providerMediaId: null,
        OR: [
          {
            failedAt: null,
            updatedAt: { lte: staleBefore },
          },
          {
            failureCode: "UPLOAD_ABANDONED",
            storageKey: { not: null },
          },
        ],
      },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
      take: 200,
      select: {
        id: true,
        storageMode: true,
        storageKey: true,
        failureCode: true,
      },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "asset-stale",
        providerMediaId: null,
        failedAt: null,
        updatedAt: { lte: staleBefore },
      },
      data: {
        failedAt: now,
        failureCode: "UPLOAD_ABANDONED",
      },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "asset-disabled",
        providerMediaId: null,
        failedAt: null,
        updatedAt: { lte: staleBefore },
      },
      data: {
        failedAt: now,
        failureCode: "UPLOAD_ABANDONED",
      },
    });
    expect(discard).toHaveBeenCalledWith("FILESYSTEM", "tenant/asset-stale");
    expect(discard).toHaveBeenCalledWith("S3", "tenant/asset-retry");
    expect(discard).not.toHaveBeenCalledWith("DISABLED", null);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "asset-stale",
        providerMediaId: null,
        failureCode: "UPLOAD_ABANDONED",
        storageKey: "tenant/asset-stale",
      },
      data: {
        storageKey: null,
        storedAt: null,
      },
    });
  });

  it("does not clean a stale candidate when another replica wins the failure claim", async () => {
    const now = new Date("2026-09-11T12:00:00.000Z");
    findMany.mockResolvedValue([
      {
        id: "asset-raced",
        storageMode: "FILESYSTEM",
        storageKey: "tenant/asset-raced",
        failureCode: null,
      },
    ]);
    updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.reconcileStaleUploads(now)).resolves.toEqual({
      markedFailed: 0,
      binariesCleaned: 0,
      cleanupDeferred: 0,
    });
    expect(discard).not.toHaveBeenCalled();
  });

  it("keeps an abandoned storage reference when cleanup fails so a later cycle can retry", async () => {
    const now = new Date("2026-09-11T12:00:00.000Z");
    findMany.mockResolvedValue([
      {
        id: "asset-retry",
        storageMode: "FILESYSTEM",
        storageKey: "tenant/asset-retry",
        failureCode: "UPLOAD_ABANDONED",
      },
    ]);
    discard.mockRejectedValue(new Error("volume unavailable"));

    await expect(service.reconcileStaleUploads(now)).resolves.toEqual({
      markedFailed: 0,
      binariesCleaned: 0,
      cleanupDeferred: 1,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("deletes retained binaries before their expired registry rows", async () => {
    const now = new Date("2026-09-10T15:00:00.000Z");
    findMany.mockResolvedValue([
      { id: "asset-disabled", storageMode: "DISABLED", storageKey: null },
      { id: "asset-filesystem", storageMode: "FILESYSTEM", storageKey: "tenant/asset-filesystem" },
    ]);

    await expect(service.purgeExpired(now)).resolves.toBe(2);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: now },
      },
      orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
      take: 200,
      select: {
        id: true,
        storageMode: true,
        storageKey: true,
      },
    });
    expect(discard).toHaveBeenNthCalledWith(1, "DISABLED", null);
    expect(discard).toHaveBeenNthCalledWith(2, "FILESYSTEM", "tenant/asset-filesystem");
    expect(deleteMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "asset-disabled",
        expiresAt: { lte: now },
      },
    });
    expect(deleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "asset-filesystem",
        expiresAt: { lte: now },
      },
    });
  });

  it("keeps registry metadata when retained binary deletion fails so cleanup can retry", async () => {
    const now = new Date("2026-09-10T15:00:00.000Z");
    findMany.mockResolvedValue([
      { id: "asset-filesystem", storageMode: "FILESYSTEM", storageKey: "tenant/asset-filesystem" },
    ]);
    discard.mockRejectedValue(new Error("volume unavailable"));

    await expect(service.purgeExpired(now)).resolves.toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("runs initial reconciliation and retention cleanup before scheduling periodic maintenance", async () => {
    process.env[CLEANUP_ENV] = "60000";

    await service.onApplicationBootstrap();

    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsafe cleanup interval during application bootstrap", async () => {
    process.env[CLEANUP_ENV] = "999";

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      "MEDIA_ASSET_CLEANUP_INTERVAL_MS must be an integer between 60000 and 86400000",
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects an unsafe stale-upload threshold during application bootstrap", async () => {
    process.env[STALE_UPLOAD_ENV] = "60000";

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      "MEDIA_ASSET_STALE_UPLOAD_MS must be an integer between 1800000 and 86400000",
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
