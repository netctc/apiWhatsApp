import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jest } from "@jest/globals";
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { MediaBinaryStorageError } from "../src/media/media-binary-storage.service.js";
import { MediaMalwareScanError } from "../src/media/media-malware-scanner.service.js";
import { MediaService } from "../src/media/media.service.js";
import { MetaApiError } from "../src/meta/meta-api.error.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_TENANT_ID = "123e4567-e89b-42d3-a456-426614174099";
const SENDER_ID = "123e4567-e89b-42d3-a456-426614174001";
const ASSET_ID = "123e4567-e89b-42d3-a456-426614174002";
const DAY_MS = 24 * 60 * 60 * 1000;

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
  const scan = jest.fn();
  const targetFor = jest.fn();
  const stage = jest.fn();
  const discard = jest.fn();
  const mediaAssetCreate = jest.fn();
  const mediaAssetUpdate = jest.fn();
  const mediaAssetFindMany = jest.fn();
  const mediaAssetFindFirst = jest.fn();

  const pendingAsset = {
    id: ASSET_ID,
    tenantId: TENANT_ID,
    senderId: SENDER_ID,
    providerMediaId: null,
    category: "IMAGE",
    mimeType: "image/jpeg",
    size: 4,
    scanMode: "DISABLED",
    scanStatus: "NOT_SCANNED",
    storageMode: "DISABLED",
    storageKey: null,
    storedAt: null,
    providerUploadedAt: null,
    expiresAt: new Date("2026-10-10T12:00:00.000Z"),
    failedAt: null,
    failureCode: null,
    createdAt: new Date("2026-09-10T12:00:00.000Z"),
    updatedAt: new Date("2026-09-10T12:00:00.000Z"),
  };

  const service = new MediaService(
    { resolveForTenant } as never,
    { uploadMedia } as never,
    { scan } as never,
    { targetFor, stage, discard } as never,
    {
      mediaAsset: {
        create: mediaAssetCreate,
        update: mediaAssetUpdate,
        findMany: mediaAssetFindMany,
        findFirst: mediaAssetFindFirst,
      },
    } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MEDIA_ASSET_TTL_DAYS;
    delete process.env.MEDIA_MALWARE_SCAN_MODE;
    resolveForTenant.mockResolvedValue({
      internalSenderId: SENDER_ID,
      phoneNumberId: "123456789",
      accessToken: "provider-token",
    });
    uploadMedia.mockResolvedValue({ mediaId: "media-123" });
    scan.mockResolvedValue(undefined);
    targetFor.mockImplementation((_tenantId: string, _assetId: string) => ({
      mode: "DISABLED",
      key: null,
    }));
    stage.mockImplementation(async (filePath: string, target: { mode: string; key: string | null }) => ({
      ...target,
      filePath,
      storedAt: null,
    }));
    discard.mockResolvedValue(undefined);
    mediaAssetCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...pendingAsset,
      ...data,
    }));
    mediaAssetUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...pendingAsset,
      ...data,
      updatedAt: new Date("2026-09-10T12:01:00.000Z"),
    }));
    mediaAssetFindMany.mockResolvedValue([]);
    mediaAssetFindFirst.mockResolvedValue(null);
  });

  it("plans storage, scans, reserves registry metadata, then stages and uploads", async () => {
    const temp = await createTempFile();
    const startedAt = Date.now();
    try {
      const result = await service.upload(TENANT_ID, { senderId: SENDER_ID }, {
        path: temp.filePath,
        mimetype: "image/jpeg",
        size: temp.size,
      });

      expect(targetFor).toHaveBeenCalledWith(TENANT_ID, expect.any(String));
      expect(scan).toHaveBeenCalledWith(temp.filePath);
      expect(targetFor.mock.invocationCallOrder[0]).toBeLessThan(scan.mock.invocationCallOrder[0]);
      expect(scan.mock.invocationCallOrder[0]).toBeLessThan(resolveForTenant.mock.invocationCallOrder[0]);
      expect(resolveForTenant).toHaveBeenCalledWith(TENANT_ID, SENDER_ID);
      expect(mediaAssetCreate).toHaveBeenCalledWith({
        data: {
          id: expect.any(String),
          tenantId: TENANT_ID,
          senderId: SENDER_ID,
          category: "IMAGE",
          mimeType: "image/jpeg",
          size: temp.size,
          scanMode: "DISABLED",
          scanStatus: "NOT_SCANNED",
          storageMode: "DISABLED",
          storageKey: null,
          storedAt: null,
          expiresAt: expect.any(Date),
        },
      });
      expect(mediaAssetCreate.mock.invocationCallOrder[0]).toBeLessThan(stage.mock.invocationCallOrder[0]);
      expect(stage).toHaveBeenCalledWith(temp.filePath, { mode: "DISABLED", key: null });
      expect(stage.mock.invocationCallOrder[0]).toBeLessThan(uploadMedia.mock.invocationCallOrder[0]);
      expect(uploadMedia).toHaveBeenCalledWith(
        {
          filePath: temp.filePath,
          mimeType: "image/jpeg",
          providerFilename: "upload.jpg",
        },
        expect.objectContaining({ internalSenderId: SENDER_ID }),
      );
      expect(mediaAssetUpdate).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: expect.objectContaining({
          providerMediaId: "media-123",
          providerUploadedAt: expect.any(Date),
          failedAt: null,
          failureCode: null,
        }),
      });
      expect(result).toEqual({
        mediaId: "media-123",
        senderId: SENDER_ID,
        category: "IMAGE",
        mimeType: "image/jpeg",
        size: temp.size,
      });
      expect(discard).not.toHaveBeenCalled();

      const reservation = mediaAssetCreate.mock.calls[0]?.[0] as {
        data: { expiresAt: Date };
      };
      expect(reservation.data.expiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + 30 * DAY_MS);
      expect(reservation.data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("reserves the filesystem key before copying bytes and uploads the controlled copy", async () => {
    const temp = await createTempFile();
    const storedAt = new Date();
    targetFor.mockImplementation((tenantId: string, assetId: string) => ({
      mode: "FILESYSTEM",
      key: `${tenantId}/${assetId}`,
    }));
    stage.mockImplementation(async (_filePath: string, target: { mode: string; key: string | null }) => ({
      ...target,
      filePath: `/var/lib/api-whatsapp/media/${target.key}`,
      storedAt,
    }));

    try {
      await service.upload(TENANT_ID, {}, {
        path: temp.filePath,
        mimetype: "image/jpeg",
        size: temp.size,
      });

      const reservation = mediaAssetCreate.mock.calls[0]?.[0] as {
        data: { id: string; storageKey: string; storageMode: string };
      };
      expect(reservation.data.storageMode).toBe("FILESYSTEM");
      expect(reservation.data.storageKey).toBe(`${TENANT_ID}/${reservation.data.id}`);
      expect(mediaAssetCreate.mock.invocationCallOrder[0]).toBeLessThan(stage.mock.invocationCallOrder[0]);
      expect(scan).toHaveBeenCalledWith(temp.filePath);
      expect(stage).toHaveBeenCalledWith(temp.filePath, {
        mode: "FILESYSTEM",
        key: reservation.data.storageKey,
      });
      expect(mediaAssetUpdate).toHaveBeenNthCalledWith(1, {
        where: { id: reservation.data.id },
        data: { storedAt },
      });
      expect(uploadMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: `/var/lib/api-whatsapp/media/${reservation.data.storageKey}`,
        }),
        expect.objectContaining({ internalSenderId: SENDER_ID }),
      );
      expect(discard).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("records clean ClamAV evidence and configurable registry TTL", async () => {
    process.env.MEDIA_MALWARE_SCAN_MODE = "clamav";
    process.env.MEDIA_ASSET_TTL_DAYS = "7";
    const temp = await createTempFile();
    const startedAt = Date.now();

    try {
      await service.upload(TENANT_ID, {}, {
        path: temp.filePath,
        mimetype: "image/jpeg",
        size: temp.size,
      });

      expect(mediaAssetCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          scanMode: "CLAMAV",
          scanStatus: "CLEAN",
          expiresAt: expect.any(Date),
        }),
      });
      const reservation = mediaAssetCreate.mock.calls[0]?.[0] as {
        data: { expiresAt: Date };
      };
      expect(reservation.data.expiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + 7 * DAY_MS);
      expect(reservation.data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("fails closed before scanning and credential access when storage configuration is invalid", async () => {
    targetFor.mockImplementation(() => {
      throw new MediaBinaryStorageError("invalid storage root");
    });
    const temp = await createTempFile();

    try {
      await expect(
        service.upload(TENANT_ID, {}, {
          path: temp.filePath,
          mimetype: "image/jpeg",
          size: temp.size,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(scan).not.toHaveBeenCalled();
      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(mediaAssetCreate).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("records a bounded failure after registry reservation when binary staging is unavailable", async () => {
    targetFor.mockImplementation((tenantId: string, assetId: string) => ({
      mode: "FILESYSTEM",
      key: `${tenantId}/${assetId}`,
    }));
    stage.mockRejectedValue(new MediaBinaryStorageError("volume unavailable"));
    const temp = await createTempFile();

    try {
      await expect(
        service.upload(TENANT_ID, {}, {
          path: temp.filePath,
          mimetype: "image/jpeg",
          size: temp.size,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      const reservation = mediaAssetCreate.mock.calls[0]?.[0] as { data: { id: string } };
      expect(scan).toHaveBeenCalled();
      expect(resolveForTenant).toHaveBeenCalled();
      expect(mediaAssetUpdate).toHaveBeenCalledWith({
        where: { id: reservation.data.id },
        data: {
          failedAt: expect.any(Date),
          failureCode: "STORAGE_ERROR",
        },
      });
      expect(uploadMedia).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("fails before registry/provider access when registry TTL configuration is invalid", async () => {
    process.env.MEDIA_ASSET_TTL_DAYS = "0";
    const temp = await createTempFile();

    try {
      await expect(
        service.upload(TENANT_ID, {}, {
          path: temp.filePath,
          mimetype: "image/jpeg",
          size: temp.size,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(scan).toHaveBeenCalled();
      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(mediaAssetCreate).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("rejects a supported declared MIME before storage planning when file content has a different signature", async () => {
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

      expect(targetFor).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(mediaAssetCreate).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("rejects malware before sender, registry, binary copy, and provider access", async () => {
    targetFor.mockImplementation((tenantId: string, assetId: string) => ({
      mode: "FILESYSTEM",
      key: `${tenantId}/${assetId}`,
    }));
    scan.mockRejectedValue(
      new MediaMalwareScanError("MALWARE_DETECTED", "Eicar-Test-Signature FOUND"),
    );
    const temp = await createTempFile();

    try {
      await expect(
        service.upload(TENANT_ID, { senderId: SENDER_ID }, {
          path: temp.filePath,
          mimetype: "image/jpeg",
          size: temp.size,
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(mediaAssetCreate).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("fails closed before sender, registry, binary copy, and provider access when scanning is unavailable", async () => {
    scan.mockRejectedValue(
      new MediaMalwareScanError("SCANNER_UNAVAILABLE", "connection refused"),
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

      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(mediaAssetCreate).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("retains a reserved filesystem binary through a retryable Meta failure until TTL cleanup", async () => {
    const storedAt = new Date();
    targetFor.mockImplementation((tenantId: string, assetId: string) => ({
      mode: "FILESYSTEM",
      key: `${tenantId}/${assetId}`,
    }));
    stage.mockImplementation(async (_filePath: string, target: { mode: string; key: string | null }) => ({
      ...target,
      filePath: `/var/lib/api-whatsapp/media/${target.key}`,
      storedAt,
    }));
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

      const reservation = mediaAssetCreate.mock.calls[0]?.[0] as {
        data: { id: string; storageKey: string };
      };
      expect(reservation.data.storageKey).toBe(`${TENANT_ID}/${reservation.data.id}`);
      expect(mediaAssetUpdate).toHaveBeenNthCalledWith(1, {
        where: { id: reservation.data.id },
        data: { storedAt },
      });
      expect(mediaAssetUpdate).toHaveBeenNthCalledWith(2, {
        where: { id: reservation.data.id },
        data: {
          failedAt: expect.any(Date),
          failureCode: "META_API_ERROR",
        },
      });
      expect(discard).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("lists only the authenticated tenant registry and exposes safe storage evidence without storage keys", async () => {
    mediaAssetFindMany.mockResolvedValue([
      {
        ...pendingAsset,
        providerMediaId: "media-expired",
        storageMode: "FILESYSTEM",
        storageKey: `${TENANT_ID}/${ASSET_ID}`,
        storedAt: new Date(Date.now() - 4 * DAY_MS),
        providerUploadedAt: new Date(Date.now() - 3 * DAY_MS),
        expiresAt: new Date(Date.now() - DAY_MS),
      },
    ]);

    const result = await service.list(TENANT_ID);

    expect(mediaAssetFindMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    expect(result[0]).toEqual(expect.objectContaining({
      assetId: ASSET_ID,
      mediaId: "media-expired",
      storageMode: "FILESYSTEM",
      binaryRetained: true,
      state: "EXPIRED",
    }));
    expect(result[0]).not.toHaveProperty("storageKey");
  });

  it("returns one tenant asset and hides cross-tenant existence", async () => {
    mediaAssetFindFirst.mockResolvedValueOnce(pendingAsset).mockResolvedValueOnce(null);

    await expect(service.findById(TENANT_ID, ASSET_ID)).resolves.toEqual(
      expect.objectContaining({
        assetId: ASSET_ID,
        storageMode: "DISABLED",
        binaryRetained: false,
        state: "UPLOADING",
      }),
    );
    expect(mediaAssetFindFirst).toHaveBeenNthCalledWith(1, {
      where: { id: ASSET_ID, tenantId: TENANT_ID },
    });

    await expect(service.findById(OTHER_TENANT_ID, ASSET_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("removes rejected files before any storage/scanner/sender/provider call", async () => {
    const temp = await createTempFile(Buffer.from("zip"));
    try {
      await expect(
        service.upload(TENANT_ID, {}, {
          path: temp.filePath,
          mimetype: "application/zip",
          size: temp.size,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(targetFor).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(mediaAssetCreate).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
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

      expect(targetFor).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(mediaAssetCreate).not.toHaveBeenCalled();
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

      expect(targetFor).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(resolveForTenant).not.toHaveBeenCalled();
      expect(mediaAssetCreate).not.toHaveBeenCalled();
      expect(uploadMedia).not.toHaveBeenCalled();
      await expectDeleted(temp.filePath);
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });
});
