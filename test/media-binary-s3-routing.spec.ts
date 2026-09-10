import { jest } from "@jest/globals";
import { MediaBinaryStorageService } from "../src/media/media-binary-storage.service.js";
import { MediaS3StorageError } from "../src/media/media-s3-storage.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const ASSET_ID = "123e4567-e89b-42d3-a456-426614174001";
const KEY = `${TENANT_ID}/${ASSET_ID}`;

describe("MediaBinaryStorageService S3 routing", () => {
  const originalMode = process.env.MEDIA_BINARY_STORAGE_MODE;
  const assertConfigured = jest.fn();
  const putObject = jest.fn();
  const deleteObject = jest.fn();
  const diagnostics = jest.fn();
  const service = new MediaBinaryStorageService({
    assertConfigured,
    putObject,
    deleteObject,
    diagnostics,
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MEDIA_BINARY_STORAGE_MODE = "s3";
    assertConfigured.mockReturnValue(undefined);
    putObject.mockResolvedValue(new Date("2026-09-10T12:00:00.000Z"));
    deleteObject.mockResolvedValue(undefined);
    diagnostics.mockResolvedValue({ status: "up", mode: "s3" });
  });

  afterAll(() => {
    if (originalMode === undefined) {
      delete process.env.MEDIA_BINARY_STORAGE_MODE;
    } else {
      process.env.MEDIA_BINARY_STORAGE_MODE = originalMode;
    }
  });

  it("plans, stages, checks and deletes through S3 while preserving the Meta source file", async () => {
    const target = service.targetFor(TENANT_ID, ASSET_ID);
    expect(target).toEqual({ mode: "S3", key: KEY });
    expect(assertConfigured).toHaveBeenCalledTimes(1);

    const staged = await service.stage("/tmp/upload", target);
    expect(putObject).toHaveBeenCalledWith(KEY, "/tmp/upload");
    expect(staged).toEqual({
      mode: "S3",
      key: KEY,
      filePath: "/tmp/upload",
      storedAt: new Date("2026-09-10T12:00:00.000Z"),
    });

    await expect(service.diagnostics()).resolves.toEqual({ status: "up", mode: "s3" });
    await service.discard("S3", KEY);
    expect(deleteObject).toHaveBeenCalledWith(KEY);
  });

  it("fails planning closed when S3 configuration is invalid", () => {
    assertConfigured.mockImplementation(() => {
      throw new MediaS3StorageError("invalid test configuration");
    });

    expect(() => service.targetFor(TENANT_ID, ASSET_ID)).toThrow(
      "S3 media storage is not configured correctly",
    );
  });

  it("maps S3 transport failures to the existing storage error boundary", async () => {
    const target = service.targetFor(TENANT_ID, ASSET_ID);
    putObject.mockRejectedValue(new MediaS3StorageError("provider detail"));

    await expect(service.stage("/tmp/upload", target)).rejects.toThrow(
      "Unable to stage media binary in S3 storage",
    );
  });
});
