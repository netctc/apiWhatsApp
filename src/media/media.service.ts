import { rm } from "node:fs/promises";
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { isUUID } from "class-validator";
import { MetaApiError } from "../meta/meta-api.error.js";
import { MetaMediaClient } from "../meta/meta-media.client.js";
import { MetaSenderResolverService } from "../meta/meta-sender-resolver.service.js";
import {
  MediaUploadPolicyError,
  resolveMediaUploadPolicy,
} from "./media-upload.policy.js";

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

      const sender = await this.senderResolver.resolveForTenant(tenantId, senderId);
      if (!sender.internalSenderId) {
        throw new Error("Tenant-scoped Meta sender resolution did not return an internal sender ID");
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

        return {
          mediaId: uploaded.mediaId,
          senderId: sender.internalSenderId,
          category: policy.category,
          mimeType: policy.mimeType,
          size: file.size,
        };
      } catch (error) {
        if (error instanceof MetaApiError) {
          this.logger.warn(
            `Meta media upload failed sender=${sender.internalSenderId} status=${error.httpStatus ?? "network"} code=${error.code ?? "unknown"} retryable=${error.retryable}`,
          );
          if (error.retryable) {
            throw new ServiceUnavailableException("Meta media upload is temporarily unavailable");
          }
          throw new BadGatewayException("Meta rejected the media upload");
        }
        throw error;
      }
    } finally {
      if (file?.path) {
        await rm(file.path, { force: true }).catch(() => undefined);
      }
    }
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
