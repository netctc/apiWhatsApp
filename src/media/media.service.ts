import { rm } from "node:fs/promises";
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { isUUID } from "class-validator";
import type { MediaAsset } from "../generated/prisma/client.js";
import { MetaApiError } from "../meta/meta-api.error.js";
import { MetaMediaClient } from "../meta/meta-media.client.js";
import { MetaSenderResolverService } from "../meta/meta-sender-resolver.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  assertMediaContentSignature,
  MediaContentSignatureError,
} from "./media-content-signature.js";
import {
  MediaMalwareScanError,
  MediaMalwareScannerService,
} from "./media-malware-scanner.service.js";
import {
  MediaUploadPolicyError,
  resolveMediaUploadPolicy,
} from "./media-upload.policy.js";

const DEFAULT_MEDIA_ASSET_TTL_DAYS = 30;
const MAX_MEDIA_ASSET_TTL_DAYS = 3650;
const MEDIA_ASSET_LIST_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StoredMediaUploadFile {
  path: string;
  mimetype: string;
  size: number;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly senderResolver: MetaSenderResolverService,
    private readonly metaMedia: MetaMediaClient,
    private readonly malwareScanner: MediaMalwareScannerService,
    private readonly prisma: PrismaService,
  ) {}

  async upload(
    tenantId: string,
    fields: Record<string, unknown>,
    file: StoredMediaUploadFile | undefined,
  ) {
    try {
      if (!file?.path) {
        throw new BadRequestException("Multipart field 'file' is required");
      }

      const senderId = this.readSenderId(fields);

      let policy;
      try {
        policy = resolveMediaUploadPolicy(file.mimetype, file.size);
      } catch (error) {
        if (error instanceof MediaUploadPolicyError) {
          if (error.reason === "FILE_TOO_LARGE") {
            throw new PayloadTooLargeException(error.message);
          }
          throw new BadRequestException(error.message);
        }
        throw error;
      }

      try {
        await assertMediaContentSignature(file.path, policy.mimeType);
      } catch (error) {
        if (error instanceof MediaContentSignatureError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }

      try {
        await this.malwareScanner.scan(file.path);
      } catch (error) {
        if (error instanceof MediaMalwareScanError) {
          if (error.reason === "MALWARE_DETECTED") {
            this.logger.warn("Media upload rejected by malware scanner");
            throw new UnprocessableEntityException("Media file was rejected by security scanning");
          }

          this.logger.error(`Media malware scanner failed closed reason=${error.reason}`);
          throw new ServiceUnavailableException("Media security scanning is unavailable");
        }
        throw error;
      }

      const ttlDays = this.readAssetTtlDays();
      const expiresAt = new Date(Date.now() + ttlDays * DAY_MS);
      const sender = await this.senderResolver.resolveForTenant(tenantId, senderId);
      if (!sender.internalSenderId) {
        throw new Error("Tenant-scoped Meta sender resolution did not return an internal sender ID");
      }

      const scan = this.scanEvidence();
      let asset: MediaAsset;
      try {
        asset = await this.prisma.mediaAsset.create({
          data: {
            tenantId,
            senderId: sender.internalSenderId,
            category: policy.category,
            mimeType: policy.mimeType,
            size: file.size,
            scanMode: scan.mode,
            scanStatus: scan.status,
            expiresAt,
          },
        });
      } catch (error) {
        this.logger.error(
          `Unable to create media asset registry entry tenant=${tenantId} sender=${sender.internalSenderId}`,
        );
        throw new ServiceUnavailableException("Media asset registry is temporarily unavailable", {
          cause: error,
        });
      }

      try {
        const uploaded = await this.metaMedia.uploadMedia(
          {
            filePath: file.path,
            mimeType: policy.mimeType,
            providerFilename: policy.providerFilename,
          },
          sender,
        );
        const providerUploadedAt = new Date();

        let completed: MediaAsset;
        try {
          completed = await this.prisma.mediaAsset.update({
            where: { id: asset.id },
            data: {
              providerMediaId: uploaded.mediaId,
              providerUploadedAt,
              failedAt: null,
              failureCode: null,
            },
          });
        } catch (error) {
          this.logger.error(
            `Meta media upload succeeded but asset registry finalization failed asset=${asset.id}`,
          );
          throw new ServiceUnavailableException("Media asset registry finalization failed", {
            cause: error,
          });
        }

        return {
          mediaId: completed.providerMediaId,
          senderId: completed.senderId,
          category: completed.category,
          mimeType: completed.mimeType,
          size: completed.size,
        };
      } catch (error) {
        if (error instanceof ServiceUnavailableException) {
          throw error;
        }

        if (error instanceof MetaApiError) {
          await this.markAssetFailed(asset.id, this.metaFailureCode(error));
          this.logger.warn(
            `Meta media upload failed asset=${asset.id} sender=${sender.internalSenderId} status=${error.httpStatus ?? "network"} code=${error.code ?? "unknown"} retryable=${error.retryable}`,
          );
          if (error.retryable) {
            throw new ServiceUnavailableException("Meta media upload is temporarily unavailable");
          }
          throw new BadGatewayException("Meta rejected the media upload");
        }

        await this.markAssetFailed(asset.id, "UPLOAD_ERROR");
        throw error;
      }
    } finally {
      if (file?.path) {
        await rm(file.path, { force: true }).catch(() => undefined);
      }
    }
  }

  async list(tenantId: string) {
    const assets = await this.prisma.mediaAsset.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: MEDIA_ASSET_LIST_LIMIT,
    });
    return assets.map((asset) => this.toResponse(asset));
  }

  async findById(tenantId: string, assetId: string) {
    if (!isUUID(assetId, "4")) {
      throw new NotFoundException("Media asset not found");
    }

    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, tenantId },
    });
    if (!asset) {
      throw new NotFoundException("Media asset not found");
    }
    return this.toResponse(asset);
  }

  private async markAssetFailed(assetId: string, failureCode: string): Promise<void> {
    await this.prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        failedAt: new Date(),
        failureCode,
      },
    }).catch((error: unknown) => {
      this.logger.error(
        `Unable to persist media asset failure asset=${assetId} code=${failureCode}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private toResponse(asset: MediaAsset) {
    const state = asset.failureCode
      ? "FAILED"
      : asset.providerMediaId
        ? asset.expiresAt && asset.expiresAt.getTime() <= Date.now()
          ? "EXPIRED"
          : "ACTIVE"
        : "UPLOADING";

    return {
      assetId: asset.id,
      mediaId: asset.providerMediaId,
      senderId: asset.senderId,
      category: asset.category,
      mimeType: asset.mimeType,
      size: asset.size,
      scanMode: asset.scanMode,
      scanStatus: asset.scanStatus,
      state,
      providerUploadedAt: asset.providerUploadedAt,
      expiresAt: asset.expiresAt,
      failedAt: asset.failedAt,
      failureCode: asset.failureCode,
      createdAt: asset.createdAt,
    };
  }

  private readAssetTtlDays(): number {
    const raw = process.env.MEDIA_ASSET_TTL_DAYS;
    if (raw === undefined || raw.trim() === "") {
      return DEFAULT_MEDIA_ASSET_TTL_DAYS;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_MEDIA_ASSET_TTL_DAYS) {
      this.logger.error(
        `Invalid MEDIA_ASSET_TTL_DAYS; expected integer 1-${MAX_MEDIA_ASSET_TTL_DAYS}`,
      );
      throw new ServiceUnavailableException("Media asset registry configuration is invalid");
    }
    return value;
  }

  private scanEvidence(): { mode: "DISABLED" | "CLAMAV"; status: "NOT_SCANNED" | "CLEAN" } {
    const mode = (process.env.MEDIA_MALWARE_SCAN_MODE ?? "disabled").trim().toLowerCase();
    return mode === "clamav"
      ? { mode: "CLAMAV", status: "CLEAN" }
      : { mode: "DISABLED", status: "NOT_SCANNED" };
  }

  private metaFailureCode(error: MetaApiError): string {
    if (error.code !== undefined) {
      return `META_${error.code}${error.subcode !== undefined ? `_${error.subcode}` : ""}`;
    }
    if (error.httpStatus !== undefined) {
      return `HTTP_${error.httpStatus}`;
    }
    return "META_API_ERROR";
  }

  private readSenderId(fields: Record<string, unknown>): string | undefined {
    const keys = Object.keys(fields);
    const unsupported = keys.filter((key) => key !== "senderId");
    if (unsupported.length > 0) {
      throw new BadRequestException(
        `Unsupported multipart field${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
      );
    }

    const senderId = fields.senderId;
    if (senderId === undefined || senderId === "") {
      return undefined;
    }
    if (typeof senderId !== "string" || !isUUID(senderId, "4")) {
      throw new BadRequestException("senderId must be a UUID v4 when provided");
    }
    return senderId;
  }
}
