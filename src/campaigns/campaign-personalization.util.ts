export interface CampaignPersonalizationContact {
  name?: string | null;
  phone: string;
  language?: string | null;
  timezone?: string | null;
  metadata?: unknown;
}

export class CampaignPersonalizationTemplateError extends Error {}
export class CampaignPersonalizationValueError extends Error {}

const DIRECT_TOKEN = /^\{\{contact\.(name|phone|language|timezone)\}\}$/;
const METADATA_TOKEN = /^\{\{contact\.metadata\.([A-Za-z0-9_-]{1,64})\}\}$/;
const PLACEHOLDER_MARKER = /\{\{|\}\}/;
const MAX_COMPONENT_NODES = 1000;
const MAX_PERSONALIZATION_TOKENS = 50;
const MAX_DEPTH = 20;

export function isCampaignPersonalizationEnabled(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (value as Record<string, unknown>).personalizationEnabled === true;
}

export function validateCampaignComponents(value: unknown): void {
  const state = { nodes: 0, tokens: 0 };
  visit(value, 0, state);
}

export function renderCampaignComponents(
  value: unknown,
  contact: CampaignPersonalizationContact,
): unknown {
  return render(value, contact, 0);
}

function visit(
  value: unknown,
  depth: number,
  state: { nodes: number; tokens: number },
): void {
  if (depth > MAX_DEPTH) {
    throw new CampaignPersonalizationTemplateError(
      `Campaign components exceed the maximum nesting depth of ${MAX_DEPTH}`,
    );
  }

  state.nodes += 1;
  if (state.nodes > MAX_COMPONENT_NODES) {
    throw new CampaignPersonalizationTemplateError(
      `Campaign components exceed the maximum node count of ${MAX_COMPONENT_NODES}`,
    );
  }

  if (typeof value === "string") {
    if (DIRECT_TOKEN.test(value) || METADATA_TOKEN.test(value)) {
      state.tokens += 1;
      if (state.tokens > MAX_PERSONALIZATION_TOKENS) {
        throw new CampaignPersonalizationTemplateError(
          `Campaign components exceed the maximum personalization token count of ${MAX_PERSONALIZATION_TOKENS}`,
        );
      }
      return;
    }

    if (PLACEHOLDER_MARKER.test(value)) {
      throw new CampaignPersonalizationTemplateError(
        `Unsupported personalization token '${value}'. Tokens must occupy the entire string value.`,
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, depth + 1, state);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      visit(nested, depth + 1, state);
    }
  }
}

function render(
  value: unknown,
  contact: CampaignPersonalizationContact,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) {
    throw new CampaignPersonalizationTemplateError(
      `Campaign components exceed the maximum nesting depth of ${MAX_DEPTH}`,
    );
  }

  if (typeof value === "string") {
    const direct = DIRECT_TOKEN.exec(value);
    if (direct) {
      const field = direct[1] as "name" | "phone" | "language" | "timezone";
      return requireScalar(contact[field], value);
    }

    const metadata = METADATA_TOKEN.exec(value);
    if (metadata) {
      const key = metadata[1]!;
      const source = contact.metadata;
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new CampaignPersonalizationValueError(
          `Missing personalization value for ${value}`,
        );
      }
      return requireScalar((source as Record<string, unknown>)[key], value);
    }

    if (PLACEHOLDER_MARKER.test(value)) {
      throw new CampaignPersonalizationTemplateError(
        `Unsupported personalization token '${value}'. Tokens must occupy the entire string value.`,
      );
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => render(item, contact, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        render(nested, contact, depth + 1),
      ]),
    );
  }

  return value;
}

function requireScalar(value: unknown, token: string): string {
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new CampaignPersonalizationValueError(`Missing personalization value for ${token}`);
    }
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  throw new CampaignPersonalizationValueError(`Missing personalization value for ${token}`);
}
