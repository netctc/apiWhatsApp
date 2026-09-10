import { jest } from "@jest/globals";
import { MediaAssetRetentionService } from "../src/media/media-asset-retention.service.js";

const CLEANUP_ENV = "MEDIA_ASSET_CLEANUP_INTERVAL_MS";

describe("MediaAssetRetentionService", () => {
  const deleteMany = jest.fn();
  const service = new MediaAssetRetentionService({
    mediaAsset: { deleteMany },
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[CLEANUP_ENV];
    deleteMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    service.onModuleDestroy();
    delete process.env[CLEANUP_ENV];
  });

  it("purges every registry row whose local retention deadline has passed", async () => {
    const now = new Date("2026-09-10T15:00:00.000Z");
    deleteMany.mockResolvedValue({ count: 3 });

    await expect(service.purgeExpired(now)).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lte: now },
      },
    });
  });

  it("runs an initial purge and schedules bounded periodic cleanup", async () => {
    process.env[CLEANUP_ENV] = "60000";

    await service.onApplicationBootstrap();

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsafe cleanup interval during application bootstrap", async () => {
    process.env[CLEANUP_ENV] = "999";

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      "MEDIA_ASSET_CLEANUP_INTERVAL_MS must be an integer between 60000 and 86400000",
    );
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
