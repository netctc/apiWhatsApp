import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Injectable } from "@nestjs/common";
import { createS3SignedHeaders } from "./media-s3-signature.js";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

interface MediaS3Configuration {
  endpoint: URL;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  timeoutMs: number;
}

export type MediaS3Diagnostics =
  | { status: "up"; mode: "s3" }
  | { status: "down"; mode: "s3"; error: "not_configured" | "unavailable" };

export class MediaS3StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaS3StorageError";
  }
}

@Injectable()
export class MediaS3StorageService {
  assertConfigured(): void {
    this.configuration();
  }

  async putObject(key: string, filePath: string): Promise<Date> {
    const config = this.configuration();
    const file = await stat(filePath).catch((error: unknown) => {
      throw new MediaS3StorageError(
        `Unable to inspect media file for S3 storage: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (!file.isFile()) {
      throw new MediaS3StorageError("Media S3 source path is not a regular file");
    }

    const payloadHash = await this.hashFile(filePath);
    const url = this.objectUrl(config, key);
    const response = await this.signedRequest({
      config,
      method: "PUT",
      url,
      payloadHash,
      body: createReadStream(filePath),
      contentLength: file.size,
    });

    if (!response.ok) {
      await this.cancelBody(response);
      throw new MediaS3StorageError(`S3 media upload failed with HTTP ${response.status}`);
    }
    await this.cancelBody(response);
    return new Date();
  }

  async deleteObject(key: string): Promise<void> {
    const config = this.configuration();
    const response = await this.signedRequest({
      config,
      method: "DELETE",
      url: this.objectUrl(config, key),
      payloadHash: EMPTY_SHA256,
    });

    if (response.ok || response.status === 404) {
      await this.cancelBody(response);
      return;
    }
    await this.cancelBody(response);
    throw new MediaS3StorageError(`S3 media deletion failed with HTTP ${response.status}`);
  }

  async diagnostics(): Promise<MediaS3Diagnostics> {
    let config: MediaS3Configuration;
    try {
      config = this.configuration();
    } catch {
      return { status: "down", mode: "s3", error: "not_configured" };
    }

    try {
      const response = await this.signedRequest({
        config,
        method: "HEAD",
        url: this.bucketUrl(config),
        payloadHash: EMPTY_SHA256,
      });
      const healthy = response.ok;
      await this.cancelBody(response);
      return healthy
        ? { status: "up", mode: "s3" }
        : { status: "down", mode: "s3", error: "unavailable" };
    } catch {
      return { status: "down", mode: "s3", error: "unavailable" };
    }
  }

  private async signedRequest(input: {
    config: MediaS3Configuration;
    method: "PUT" | "DELETE" | "HEAD";
    url: URL;
    payloadHash: string;
    body?: NodeJS.ReadableStream;
    contentLength?: number;
  }): Promise<Response> {
    const signed = createS3SignedHeaders({
      method: input.method,
      url: input.url,
      region: input.config.region,
      accessKeyId: input.config.accessKeyId,
      secretAccessKey: input.config.secretAccessKey,
      sessionToken: input.config.sessionToken,
      payloadHash: input.payloadHash,
      date: new Date(),
    });
    const headers: Record<string, string> = {
      authorization: signed.authorization,
    };
    for (const [name, value] of Object.entries(signed.headers)) {
      if (name !== "host") {
        headers[name] = value;
      }
    }
    if (input.contentLength !== undefined) {
      headers["content-length"] = String(input.contentLength);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.config.timeoutMs);
    timeout.unref();
    try {
      const init = {
        method: input.method,
        headers,
        body: input.body,
        signal: controller.signal,
        redirect: "error",
        ...(input.body ? { duplex: "half" as const } : {}),
      } as RequestInit & { duplex?: "half" };
      return await fetch(input.url, init);
    } catch (error) {
      throw new MediaS3StorageError(
        `Unable to communicate with S3 media storage: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async hashFile(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    try {
      for await (const chunk of stream) {
        hash.update(chunk);
      }
      return hash.digest("hex");
    } catch (error) {
      throw new MediaS3StorageError(
        `Unable to hash media file for S3 storage: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      stream.destroy();
    }
  }

  private configuration(): MediaS3Configuration {
    const endpointRaw = process.env.MEDIA_S3_ENDPOINT?.trim();
    if (!endpointRaw) {
      throw new MediaS3StorageError("MEDIA_S3_ENDPOINT is required for S3 media storage");
    }

    let endpoint: URL;
    try {
      endpoint = new URL(endpointRaw);
    } catch {
      throw new MediaS3StorageError("MEDIA_S3_ENDPOINT must be an absolute URL");
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new MediaS3StorageError("MEDIA_S3_ENDPOINT cannot contain credentials, query, or fragment");
    }
    if (endpoint.pathname !== "/" && endpoint.pathname !== "") {
      throw new MediaS3StorageError("MEDIA_S3_ENDPOINT cannot contain a path");
    }
    if (endpoint.protocol !== "https:" && !(process.env.NODE_ENV === "test" && endpoint.protocol === "http:")) {
      throw new MediaS3StorageError("MEDIA_S3_ENDPOINT must use HTTPS outside test mode");
    }

    const bucket = process.env.MEDIA_S3_BUCKET?.trim() ?? "";
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
      throw new MediaS3StorageError("MEDIA_S3_BUCKET must be a valid DNS-compatible bucket name");
    }

    const region = (process.env.MEDIA_S3_REGION?.trim() || DEFAULT_REGION).toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(region)) {
      throw new MediaS3StorageError("MEDIA_S3_REGION is invalid");
    }

    const accessKeyId = process.env.MEDIA_S3_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.MEDIA_S3_SECRET_ACCESS_KEY?.trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new MediaS3StorageError(
        "MEDIA_S3_ACCESS_KEY_ID and MEDIA_S3_SECRET_ACCESS_KEY are required for S3 media storage",
      );
    }

    const sessionToken = process.env.MEDIA_S3_SESSION_TOKEN?.trim() || undefined;
    const timeoutMs = this.readTimeout(process.env.MEDIA_S3_TIMEOUT_MS);
    return {
      endpoint,
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      timeoutMs,
    };
  }

  private readTimeout(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === "") {
      return DEFAULT_TIMEOUT_MS;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1000 || value > MAX_TIMEOUT_MS) {
      throw new MediaS3StorageError(
        `MEDIA_S3_TIMEOUT_MS must be an integer between 1000 and ${MAX_TIMEOUT_MS}`,
      );
    }
    return value;
  }

  private bucketUrl(config: MediaS3Configuration): URL {
    return new URL(`/${encodeURIComponent(config.bucket)}`, config.endpoint.origin);
  }

  private objectUrl(config: MediaS3Configuration, key: string): URL {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(key)) {
      throw new MediaS3StorageError("Invalid server-generated media S3 storage key");
    }
    const encodedKey = key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
    return new URL(`/${encodeURIComponent(config.bucket)}/${encodedKey}`, config.endpoint.origin);
  }

  private async cancelBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }
}
