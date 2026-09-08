import { normalizeWhatsAppPhoneNumber } from "../common/phone-number.util.js";
import { MessageType } from "../generated/prisma/client.js";

interface OutboundMessageRecord {
  type: MessageType;
  to: string | null;
  payload: unknown;
}

interface MetaMessagePayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "text" | "template";
  text?: {
    body: string;
    preview_url?: boolean;
  };
  template?: {
    name: string;
    language: { code: string };
    components?: unknown[];
  };
}

export function mapMessageToMetaPayload(message: OutboundMessageRecord): MetaMessagePayload {
  const to = normalizeRecipient(message.to);
  const payload = asObject(message.payload);

  switch (message.type) {
    case MessageType.TEXT:
      return mapTextMessage(to, payload);
    case MessageType.TEMPLATE:
      return mapTemplateMessage(to, payload);
    default:
      throw new Error(`Unsupported outbound message type: ${message.type}`);
  }
}

function mapTextMessage(to: string, payload: Record<string, unknown>): MetaMessagePayload {
  const body = payload.body;
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new Error("TEXT payload requires a non-empty 'body' string");
  }

  const previewUrl = payload.previewUrl;
  if (previewUrl !== undefined && typeof previewUrl !== "boolean") {
    throw new Error("TEXT payload 'previewUrl' must be a boolean when provided");
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: {
      body,
      ...(typeof previewUrl === "boolean" ? { preview_url: previewUrl } : {}),
    },
  };
}

function mapTemplateMessage(to: string, payload: Record<string, unknown>): MetaMessagePayload {
  const name = payload.name;
  const language = payload.language;
  const components = payload.components;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("TEMPLATE payload requires a non-empty 'name' string");
  }

  if (typeof language !== "string" || language.trim().length === 0) {
    throw new Error("TEMPLATE payload requires a non-empty 'language' string");
  }

  if (components !== undefined && !Array.isArray(components)) {
    throw new Error("TEMPLATE payload 'components' must be an array when provided");
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name,
      language: { code: language },
      ...(Array.isArray(components) ? { components } : {}),
    },
  };
}

function normalizeRecipient(value: string | null): string {
  if (!value) {
    throw new Error("Outbound message recipient is required");
  }

  try {
    return normalizeWhatsAppPhoneNumber(value);
  } catch {
    throw new Error("Outbound message recipient must be a valid international phone number");
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Message payload must be an object");
  }

  return value as Record<string, unknown>;
}
