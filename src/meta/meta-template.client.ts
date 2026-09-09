import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MetaApiError } from "./meta-api.error.js";
import { MetaSenderResolverService } from "./meta-sender-resolver.service.js";

export interface MetaMessageTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: unknown[];
  qualityScore?: unknown;
  rejectionReason?: string;
  raw: Record<string, unknown>;
}

export interface MetaTemplateListResult {
  wabaId: string;
  senderId: string;
  templates: MetaMessageTemplate[];
}

@Injectable()
export class MetaTemplateClient {
  constructor(
    private readonly config: ConfigService,
    private readonly senderResolver: MetaSenderResolverService,
  ) {}

  async listTemplates(tenantId: string, senderId?: string): Promise<MetaTemplateListResult> {
    const context = await this.senderResolver.resolveWaba(tenantId, senderId);
    const graphVersion = this.required("META_GRAPH_API_VERSION");
    if (!/^v\d+\.\d+$/.test(graphVersion)) {
      throw new Error("META_GRAPH_API_VERSION must use the format vNN.N");
    }

    const templates: MetaMessageTemplate[] = [];
    let after: string | undefined;
    let completed = false;
    const seenCursors = new Set<string>();

    for (let page = 0; page < 100; page += 1) {
      const url = new URL(`https://graph.facebook.com/${graphVersion}/${context.wabaId}/message_templates`);
      url.searchParams.set(
        "fields",
        "id,name,language,status,category,components,quality_score,rejected_reason",
      );
      url.searchParams.set("limit", "100");
      if (after) {
        url.searchParams.set("after", after);
      }

      const responseBody = await this.getPage(url, context.accessToken);
      templates.push(...this.extractTemplates(responseBody));

      const paging = this.extractPaging(responseBody);
      if (!paging.hasNext) {
        completed = true;
        break;
      }
      if (!paging.after) {
        throw new MetaApiError("Meta template pagination advertised a next page without an after cursor", {
          retryable: false,
          response: responseBody,
        });
      }
      if (seenCursors.has(paging.after)) {
        throw new MetaApiError("Meta template pagination repeated an after cursor", {
          retryable: false,
          response: responseBody,
        });
      }
      seenCursors.add(paging.after);
      after = paging.after;
    }

    if (!completed) {
      throw new MetaApiError("Meta template pagination exceeded the configured 100-page safety limit", {
        retryable: false,
      });
    }

    return {
      wabaId: context.wabaId,
      senderId: context.internalSenderId,
      templates,
    };
  }

  private async getPage(url: URL, accessToken: string): Promise<unknown> {
    const timeoutMs = Number(this.config.get("META_HTTP_TIMEOUT_MS") ?? 15000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "apiWhatsApp/0.5",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MetaApiError(error instanceof Error ? error.message : "Meta template API request failed", {
        retryable: true,
      });
    }

    const body = await this.readResponse(response);
    if (!response.ok) {
      const metaError = this.extractMetaError(body);
      throw new MetaApiError(metaError.message ?? `Meta template API returned HTTP ${response.status}`, {
        httpStatus: response.status,
        code: metaError.code,
        subcode: metaError.subcode,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        response: body,
      });
    }
    return body;
  }

  private extractTemplates(value: unknown): MetaMessageTemplate[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new MetaApiError("Meta template API response must be an object", {
        retryable: false,
        response: value,
      });
    }

    const data = (value as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new MetaApiError("Meta template API response did not include a data array", {
        retryable: false,
        response: value,
      });
    }

    const result: MetaMessageTemplate[] = [];
    for (const candidate of data) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new MetaApiError("Meta template API returned a malformed template entry", {
          retryable: false,
          response: candidate,
        });
      }
      const item = candidate as Record<string, unknown>;
      if (
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        typeof item.language !== "string" ||
        typeof item.status !== "string"
      ) {
        throw new MetaApiError("Meta template API returned a template without required identity fields", {
          retryable: false,
          response: item,
        });
      }

      result.push({
        id: item.id,
        name: item.name,
        language: item.language,
        status: item.status.toUpperCase(),
        category: typeof item.category === "string" ? item.category.toUpperCase() : undefined,
        components: Array.isArray(item.components) ? item.components : undefined,
        qualityScore: item.quality_score,
        rejectionReason: typeof item.rejected_reason === "string" ? item.rejected_reason : undefined,
        raw: item,
      });
    }
    return result;
  }

  private extractPaging(value: unknown): { hasNext: boolean; after?: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { hasNext: false };
    }
    const paging = (value as { paging?: unknown }).paging;
    if (!paging || typeof paging !== "object" || Array.isArray(paging)) {
      return { hasNext: false };
    }
    const pagingObject = paging as { next?: unknown; cursors?: unknown };
    const hasNext = typeof pagingObject.next === "string" && pagingObject.next.length > 0;
    const cursors = pagingObject.cursors;
    if (!cursors || typeof cursors !== "object" || Array.isArray(cursors)) {
      return { hasNext };
    }
    const after = (cursors as { after?: unknown }).after;
    return {
      hasNext,
      ...(typeof after === "string" && after.length > 0 ? { after } : {}),
    };
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

  private extractMetaError(value: unknown): { message?: string; code?: number; subcode?: number } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const error = (value as { error?: unknown }).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) {
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

  private required(name: string): string {
    const value = this.config.get<string>(name);
    if (!value) {
      throw new Error(`${name} is required`);
    }
    return value;
  }
}
