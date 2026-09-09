import { Injectable } from "@nestjs/common";
import { PhoneNumbersService } from "../phone-numbers/phone-numbers.service.js";
import { TemplatesService } from "../templates/templates.service.js";

interface TemplateStatusWebhookUpdate {
  wabaId: string;
  providerTemplateId: string;
  name: string;
  language: string;
  status: string;
  rejectionReason?: string;
  raw: Record<string, unknown>;
}

@Injectable()
export class TemplateStatusWebhookService {
  constructor(
    private readonly phoneNumbers: PhoneNumbersService,
    private readonly templates: TemplatesService,
  ) {}

  async process(payload: unknown): Promise<void> {
    for (const update of this.extractUpdates(payload)) {
      const tenantId = await this.phoneNumbers.findTenantIdByWabaId(update.wabaId);
      await this.templates.applyProviderStatusUpdate(tenantId, update.wabaId, {
        providerTemplateId: update.providerTemplateId,
        name: update.name,
        language: update.language,
        status: update.status,
        rejectionReason: update.rejectionReason,
        raw: update.raw,
      });
    }
  }

  private extractUpdates(payload: unknown): TemplateStatusWebhookUpdate[] {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return [];
    }
    const entries = (payload as { entry?: unknown }).entry;
    if (!Array.isArray(entries)) {
      return [];
    }

    const updates: TemplateStatusWebhookUpdate[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const wabaId = this.asString((entry as { id?: unknown }).id);
      const changes = (entry as { changes?: unknown }).changes;
      if (!wabaId || !Array.isArray(changes)) {
        continue;
      }

      for (const change of changes) {
        if (!change || typeof change !== "object" || Array.isArray(change)) {
          continue;
        }
        const field = (change as { field?: unknown }).field;
        if (field !== "message_template_status_update") {
          continue;
        }
        const value = (change as { value?: unknown }).value;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          continue;
        }
        const raw = value as Record<string, unknown>;
        const providerTemplateId = this.asString(raw.message_template_id);
        const name = this.asString(raw.message_template_name);
        const language = this.asString(raw.message_template_language);
        const status = this.asString(raw.event);
        if (!providerTemplateId || !name || !language || !status) {
          continue;
        }

        updates.push({
          wabaId,
          providerTemplateId,
          name,
          language,
          status: status.toUpperCase(),
          rejectionReason: typeof raw.reason === "string" ? raw.reason : undefined,
          raw,
        });
      }
    }
    return updates;
  }

  private asString(value: unknown): string | undefined {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return undefined;
  }
}
