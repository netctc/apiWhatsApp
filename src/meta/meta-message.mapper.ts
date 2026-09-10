import { MessageType } from "../generated/prisma/client.js";
import { normalizeMediaPayload } from "../messages/media-payload.util.js";

interface OutboundMessageRecord {
  type: MessageType;
  to: string | null;
  payload: unknown;
}

interface MetaMediaObject {
  id?: string;
  link?: string;
  caption?: string;
  filename?: string;
}

interface MetaMessagePayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "text" | "template" | "image" | "video" | "audio" | "document";
  text?: {
    body: string;
    preview_url?: boolean;
  };
  template?: {
    name: string;
    language: { code: string };
    components?: unknown[];
  };
  image?: MetaMediaObject;
  video?: MetaMediaObject;
  audio?: MetaMediaObject;
  document?: MetaMediaObject;
}

export function mapMessageToMetaPayload(message: OutboundMessageRecord): MetaMessagePayload {
  const to = normalizeRecipient(message.to);
  const payload = asObject(message.payload);

  switch (message.type) {
    case MessageType.TEXT:
      return mapTextMessage(to, payload);
    case MessageType.TEMPLATE:
      return mapTemplateMessage(to, payload);
    case MessageType.IMAGE:
      return mapMediaMessage(to, "IMAGE", payload);
    case MessageType.VIDEO:
      return mapMediaMessage(to, "VIDEO", payload);
    case MessageType.AUDIO:
      return mapMediaMessage(to, "AUDIO", payload);
    case MessageType.DOCUMENT:
      return mapMediaMessage(to, "DOCUMENT", payload);
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

function mapMediaMessage(
  to: string,
  type: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT",
  payload: Record<string, unknown>,
): MetaMessagePayload {
  const media = normalizeMediaPayload(type, payload);

  switch (type) {
    case "IMAGE":
      return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: media,
      };
    case "VIDEO":
      return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "video",
        video: media,
      };
    case "AUDIO":
      return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "audio",
        audio: media,
      };
    case "DOCUMENT":
      return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "document",
        document: media,
      };
  }
}

function normalizeRecipient(value: string | null): string {
  if (!value) {
    throw new Error("Outbound message recipient is required");
  }

  const normalized = value.replace(/\D/g, "");
  if (normalized.length < 8 || normalized.length > 15) {
    throw new Error("Outbound message recipient must be a valid international phone number");
  }

  return normalized;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Message payload must be an object");
  }

  return value as Record<string, unknown>;
}
