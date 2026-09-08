import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MetaApiError } from "./meta-api.error.js";
import { mapMessageToMetaPayload } from "./meta-message.mapper.js";

interface OutboundMessageRecord {
  type: Parameters<typeof mapMessageToMetaPayload>[0]["type"];
  to: string | null;
  payload: unknown;
}

export interface MetaSendMessageResult {
  providerMessageId: string;
  response: unknown;
}

@Injectable()
export class MetaWhatsAppClient {
  constructor(private readonly config: ConfigService) {}

  async sendMessage(
    message: OutboundMessageRecord,
    providerPhoneNumberId?: string,
  ): Promise<MetaSendMessageResult> {
    const graphVersion = this.required("META_GRAPH_API_VERSION");
    const phoneNumberId = providerPhoneNumberId ?? this.required("META_WHATSAPP_PHONE_NUMBER_ID");
    const accessToken = this.required("META_WHATSAPP_ACCESS_TOKEN");
    const timeoutMs = Number(this.config.get("META_HTTP_TIMEOUT_MS") ?? 15000);

    if (!/^v\d+\.\d+$/.test(graphVersion)) {
      throw new Error("META_GRAPH_API_VERSION must use the format vNN.N");
    }

    if (!/^\d+$/.test(phoneNumberId)) {
      throw new Error("WhatsApp provider phone number ID must contain digits only");
    }

    const requestBody = mapMessageToMetaPayload(message);
    const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "apiWhatsApp/0.1",
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MetaApiError(error instanceof Error ? error.message : "Meta API request failed", {
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

    const providerMessageId = this.extractProviderMessageId(responseBody);
    if (!providerMessageId) {
      throw new MetaApiError("Meta API response did not include a message id", {
        httpStatus: response.status,
        retryable: false,
        response: responseBody,
      });
    }

    return { providerMessageId, response: responseBody };
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

  private extractProviderMessageId(value: unknown): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const messages = (value as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return undefined;
    }

    const first = messages[0];
    if (!first || typeof first !== "object") {
      return undefined;
    }

    const id = (first as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
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
