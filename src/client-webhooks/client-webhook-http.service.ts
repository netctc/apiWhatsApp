import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ClientWebhookUrlError,
  isPublicWebhookAddress,
  normalizeClientWebhookUrl,
} from "./client-webhook-url.util.js";

export class ClientWebhookHttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ClientWebhookHttpError";
  }
}

@Injectable()
export class ClientWebhookHttpService {
  constructor(private readonly config: ConfigService) {}

  async post(urlValue: string, body: string, headers: Record<string, string>): Promise<number> {
    let normalized: string;
    try {
      normalized = normalizeClientWebhookUrl(urlValue);
    } catch (error) {
      if (error instanceof ClientWebhookUrlError) {
        throw new ClientWebhookHttpError(error.message, false);
      }
      throw error;
    }

    const url = new URL(normalized);
    const hostname = this.stripIpv6Brackets(url.hostname);
    const addresses = await this.resolveAddresses(hostname);
    const allowPrivate = process.env.NODE_ENV === "test";
    if (!allowPrivate && addresses.some((address) => !isPublicWebhookAddress(address))) {
      throw new ClientWebhookHttpError("Client webhook hostname resolved to a non-public address", false);
    }

    const address = addresses.find((candidate) => allowPrivate || isPublicWebhookAddress(candidate));
    if (!address) {
      throw new ClientWebhookHttpError("Client webhook hostname did not resolve to an allowed address", false);
    }

    return this.requestPinned(url, hostname, address, body, headers);
  }

  private async resolveAddresses(hostname: string): Promise<string[]> {
    try {
      if (isIP(hostname)) {
        return [hostname];
      }
      const results = await lookup(hostname, { all: true, verbatim: true });
      const addresses = [...new Set(results.map((result) => result.address))];
      if (addresses.length === 0) {
        throw new Error("no addresses returned");
      }
      return addresses;
    } catch (error) {
      throw new ClientWebhookHttpError(
        `Client webhook DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  private requestPinned(
    url: URL,
    originalHostname: string,
    address: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<number> {
    const timeoutMs = this.timeoutMs();
    const secure = url.protocol === "https:";
    const port = url.port ? Number(url.port) : secure ? 443 : 80;
    const requestHeaders = {
      ...headers,
      Host: url.host,
      "Content-Length": String(Buffer.byteLength(body)),
    };

    return new Promise((resolve, reject) => {
      const requester = secure ? https.request : http.request;
      const request = requester(
        {
          protocol: url.protocol,
          hostname: address,
          family: isIP(address),
          port,
          method: "POST",
          path: `${url.pathname}${url.search}`,
          headers: requestHeaders,
          ...(secure
            ? {
                servername: isIP(originalHostname) ? undefined : originalHostname,
                rejectUnauthorized: true,
                checkServerIdentity: (_host: string, cert: Parameters<typeof checkServerIdentity>[1]) =>
                  checkServerIdentity(originalHostname, cert),
              }
            : {}),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          resolve(status);
        },
      );

      request.setTimeout(timeoutMs, () => {
        request.destroy(new ClientWebhookHttpError("Client webhook request timed out", true));
      });
      request.on("error", (error) => {
        reject(
          error instanceof ClientWebhookHttpError
            ? error
            : new ClientWebhookHttpError(
                `Client webhook request failed: ${error instanceof Error ? error.message : String(error)}`,
                true,
              ),
        );
      });
      request.end(body);
    });
  }

  private timeoutMs(): number {
    const value = Number(this.config.get("CLIENT_WEBHOOK_HTTP_TIMEOUT_MS") ?? 10000);
    if (!Number.isFinite(value) || value < 500 || value > 60000) {
      throw new ClientWebhookHttpError(
        "CLIENT_WEBHOOK_HTTP_TIMEOUT_MS must be between 500 and 60000 milliseconds",
        true,
      );
    }
    return Math.floor(value);
  }

  private stripIpv6Brackets(value: string): string {
    return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  }
}
