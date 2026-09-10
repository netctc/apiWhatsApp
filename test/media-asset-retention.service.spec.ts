import { jest } from "@jest/globals";
import { MediaAssetRetentionService } from "../src/media/media-asset-retention.service.js";

const CLEANUP_ENV = "MEDIA_ASSET_CLEANUP_INTERVAL_MS";

describe("MediaAssetRetentionService", () => {
  const findMany = jest.fn();
  const deleteMany = jest.fn();
  const discard = jest.fn();
  const service = new MediaAssetRetentionService(
    {
      mediaAsset: { findMany, deleteMany },
    } as never,
    { discard } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[CLEANUP_ENV];
    findMany.mockResolvedValue([]);
    deleteMany.mockResolvedValue({ count: 1 });
    discard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    delete process.env[CLEANUP_ENV];
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

  it("runs an initial purge and schedules bounded periodic cleanup", async () => {
    process.env[CLEANUP_ENV] = "60000";

    await service.onApplicationBootstrap();

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsafe cleanup interval during application bootstrap", async () => {
    process.env[CLEANUP_ENV] = "999";

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      "MEDIA_ASSET_CLEANUP_INTERVAL_MS must be an integer between 60000 and 86400000",
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
