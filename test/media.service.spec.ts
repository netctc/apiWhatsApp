import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jest } from "@jest/globals";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { MediaService } from "../src/media/media.service.js";
import { MetaApiError } from "../src/meta/meta-api.error.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const SENDER_ID = "123e4567-e89b-42d3-a456-426614174001";

async function createTempFile(bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])) {
  const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-media-test-"));
  const filePath = join(directory, "upload");
  await writeFile(filePath, bytes);
  return { directory, filePath, size: bytes.length };
}

async function expectDeleted(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}

describe("MediaService", () => {
  const resolveForTenant = jest.fn();
  const uploadMedia = jest.fn();
  const service = new MediaService(
    { resolveForTenant } as never,
    { uploadMedia } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    resolveForTenant.mockResolvedValue({
      internalSenderId: SENDER_ID,
      phoneNumberId: "123456789",
      accessToken: "provider-token",
    });
    uploadMedia.mockResolvedValue({ mediaId: "media-123" });
  });

  it("uploads through the tenant-scoped sender and removes the temporary file", async () => {
    const temp = await createTempFile();
    try {
      const result = await service.upload(TENANT_ID, { senderId: SENDER_ID }, {
        path: temp.filePath,
        mimetype: "image/jpeg",
        size: temp.size,
      });

      expect(resolveForTenant).toHaveBeenCalledWith(TENANT_ID, SENDER_ID);
      expect(uploadMedia).toHaveBeenCalledWith(
        {
          filePath: temp.filePath,
          mimeType: "image/jpeg",
          providerFilename: "upload.jpg",
        },
        expect.objectContaining({ internalSenderId: SENDER_ID }),
      );
      expect(result).toEqual({
        mediaId: "media-123",
        senderId: SENDER_ID,
        category: "IMAGE",
        mimeType: "image/jpeg",
        size: temp.size,
      });
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("rejects a supported declared MIME when file content has a different signature", async () => {
    const temp = await createTempFile(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    try {
      await expect(
        service.upload(TENANT_ID, { senderId: SENDER_ID }, {
          path: temp.filePath,
          mimetype: "image/jpeg",
          size: temp.size,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          message: "Media file content does not match declared MIME type: image/jpeg",
        }),
      });

      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("removes the temporary file when Meta is temporarily unavailable", async () => {
    uploadMedia.mockRejectedValue(
      new MetaApiError("provider timeout", {
        retryable: true,
      }),
    );
    const temp = await createTempFile();

    try {
      await expect(
        service.upload(TENANT_ID, { senderId: SENDER_ID }, {
          path: temp.filePath,
          mimetype: "image/jpeg",
          size: temp.size,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("removes rejected files before any sender/provider call", async () => {
    const temp = await createTempFile(Buffer.from("zip"));
    try {
      await expect(
        service.upload(TENANT_ID, {}, {
          path: temp.filePath,
          mimetype: "application/zip",
          size: temp.size,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("removes the file when senderId is not UUID v4", async () => {
    const temp = await createTempFile();
    try {
      await expect(
        service.upload(TENANT_ID, { senderId: "not-a-uuid" }, {
          path: temp.filePath,
          mimetype: "image/jpeg",
          size: temp.size,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(resolveForTenant).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("fails closed on unexpected multipart fields and still cleans up", async () => {
    const temp = await createTempFile();
    try {
      await expect(
        service.upload(TENANT_ID, { senderId: SENDER_ID, tenantId: "attacker-tenant" }, {
          path: temp.filePath,
          mimetype: "image/jpeg",
          size: temp.size,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });
});
