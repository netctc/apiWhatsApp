import { openAsBlob } from "node:fs";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_USER_AGENT } from "../version.js";
import { MetaApiError } from "./meta-api.error.js";
import { metaGraphUrl } from "./meta-graph-url.util.js";
import type { MetaSenderContext } from "./meta-sender-resolver.service.js";

export interface MetaMediaUploadInput {
  filePath: string;
  mimeType: string;
  providerFilename: string;
}

export interface MetaMediaUploadResult {
  mediaId: string;
}

@Injectable()
export class MetaMediaClient {
  constructor(private readonly config: ConfigService) {}

  async uploadMedia(
    input: MetaMediaUploadInput,
    sender: MetaSenderContext,
  ): Promise<MetaMediaUploadResult> {
    const graphVersion = this.required("META_GRAPH_API_VERSION");
    const timeoutMs = this.uploadTimeoutMs();

    if (!/^v\d+\.\d+$/.test(graphVersion)) {
      throw new Error("META_GRAPH_API_VERSION must use the format vNN.N");
    }

    const file = await openAsBlob(input.filePath, { type: input.mimeType });
    const formData = new FormData();
    formData.append("messaging_product", "whatsapp");
    formData.append("file", file, input.providerFilename);

    const url = metaGraphUrl(
      this.config,
      `${graphVersion}/${encodeURIComponent(sender.phoneNumberId)}/media`,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sender.accessToken}`,
          "User-Agent": APP_USER_AGENT,
        },
        body: formData,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MetaApiError(error instanceof Error ? error.message : "Meta media upload failed", {
        retryable: true,
      });
    }

    const responseBody = await this.readResponse(response);
    if (!response.ok) {
      const metaError = this.extractMetaError(responseBody);
      throw new MetaApiError(metaError.message ?? `Meta API returned HTTP ${response.status}`, {
        httpStatus: response.status,
        code: metaError.code,
        subcode: metaError.subcode,
        retryable: this.isRetryable(response.status, metaError.code),
        response: responseBody,
      });
    }

    const mediaId = this.extractMediaId(responseBody);
    if (!mediaId) {
      throw new MetaApiError("Meta API response did not include a media id", {
        httpStatus: response.status,
        retryable: false,
        response: responseBody,
      });
    }

    return { mediaId };
  }

  private uploadTimeoutMs(): number {
    const value = Number(this.config.get("META_MEDIA_UPLOAD_TIMEOUT_MS") ?? 120000);
    if (!Number.isFinite(value) || value < 1000 || value > 600000) {
      throw new Error("META_MEDIA_UPLOAD_TIMEOUT_MS must be between 1000 and 600000 milliseconds");
    }
    return Math.floor(value);
  }

  private required(name: string): string {
    const value = this.config.get<string>(name);
    if (!value) {
      throw new Error(`${name} is required`);
    }
    return value;
  }

  private async readResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }

  private extractMediaId(value: unknown): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id : undefined;
  }

  private extractMetaError(value: unknown): { message?: string; code?: number; subcode?: number } {
    if (!value || typeof value !== "object") {
      return {};
    }

    const error = (value as { error?: unknown }).error;
    if (!error || typeof error !== "object") {
      return {};
    }

    const candidate = error as {
      message?: unknown;
      code?: unknown;
      error_subcode?: unknown;
    };

    return {
      message: typeof candidate.message === "string" ? candidate.message : undefined,
      code: typeof candidate.code === "number" ? candidate.code : undefined,
      subcode: typeof candidate.error_subcode === "number" ? candidate.error_subcode : undefined,
    };
  }

  private isRetryable(httpStatus: number, code?: number): boolean {
    if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
      return true;
    }

    return code !== undefined && new Set([1, 2, 4, 17, 32, 613, 80007, 130429, 131000, 131016, 131056]).has(code);
  }
}
