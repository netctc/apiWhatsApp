import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jest } from "@jest/globals";
import { ServiceUnavailableException } from "@nestjs/common";
import { MediaBinaryStorageError } from "../src/media/media-binary-storage.service.js";
import { MediaService } from "../src/media/media.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const SENDER_ID = "123e4567-e89b-42d3-a456-426614174001";

describe("MediaService storage admission wiring", () => {
  it("runs projected-capacity admission after target validation and before every downstream boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-media-admission-wiring-"));
    const filePath = join(directory, "upload");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x42, 0xff, 0xd9]);
    await writeFile(filePath, jpeg);

    const resolveForTenant = jest.fn();
    const uploadMedia = jest.fn();
    const scan = jest.fn();
    const targetFor = jest.fn(() => ({
      mode: "FILESYSTEM" as const,
      key: `${TENANT_ID}/asset`,
    }));
    const assertCapacityFor = jest.fn(async () => {
      throw new MediaBinaryStorageError("Insufficient filesystem media storage capacity");
    });
    const stage = jest.fn();
    const mediaAssetCreate = jest.fn();

    const service = new MediaService(
      { resolveForTenant } as never,
      { uploadMedia } as never,
      { scan } as never,
      { targetFor, assertCapacityFor, stage } as never,
      { mediaAsset: { create: mediaAssetCreate } } as never,
    );

    try {
      await expect(
        service.upload(
          TENANT_ID,
          { senderId: SENDER_ID },
          { path: filePath, mimetype: "image/jpeg", size: jpeg.length },
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(targetFor).toHaveBeenCalledWith(TENANT_ID, expect.any(String));
      expect(assertCapacityFor).toHaveBeenCalledWith(jpeg.length);
      expect(targetFor.mock.invocationCallOrder[0]).toBeLessThan(
        assertCapacityFor.mock.invocationCallOrder[0],
      );
      expect(scan).not.toHaveBeenCalled();
      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(mediaAssetCreate).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
      await expect(access(filePath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
