const MEDIA_MESSAGE_TYPES = ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"] as const;

export type MediaMessageType = (typeof MEDIA_MESSAGE_TYPES)[number];

export interface NormalizedMediaPayload {
  id?: string;
  link?: string;
  caption?: string;
  filename?: string;
}

export class MediaPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaPayloadError";
  }
}

export function isMediaMessageType(value: string): value is MediaMessageType {
  return MEDIA_MESSAGE_TYPES.includes(value as MediaMessageType);
}

export function normalizeMediaPayload(type: string, input: unknown): NormalizedMediaPayload {
  if (!isMediaMessageType(type)) {
    throw new MediaPayloadError(`Unsupported media message type: ${type}`);
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MediaPayloadError(`${type} payload must be an object`);
  }

  const payload = input as Record<string, unknown>;
  const allowedKeys = new Set<string>(["id", "link"]);
  if (type !== "AUDIO") {
    allowedKeys.add("caption");
  }
  if (type === "DOCUMENT") {
    allowedKeys.add("filename");
  }

  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new MediaPayloadError(`${type} payload contains unsupported field '${key}'`);
    }
  }

  const id = readOptionalString(payload.id, `${type} payload 'id'`, 512);
  const link = readOptionalString(payload.link, `${type} payload 'link'`, 2048);

  if ((id ? 1 : 0) + (link ? 1 : 0) !== 1) {
    throw new MediaPayloadError(`${type} payload requires exactly one of 'id' or 'link'`);
  }

  if (link) {
    validateHttpsLink(type, link);
  }

  const caption =
    type === "AUDIO"
      ? undefined
      : readOptionalString(payload.caption, `${type} payload 'caption'`, 1024);
  const filename =
    type === "DOCUMENT"
      ? readOptionalString(payload.filename, `${type} payload 'filename'`, 240)
      : undefined;

  if (filename && containsControlCharacter(filename)) {
    throw new MediaPayloadError("DOCUMENT payload 'filename' cannot contain control characters");
  }

  return {
    ...(id ? { id } : {}),
    ...(link ? { link } : {}),
    ...(caption ? { caption } : {}),
    ...(filename ? { filename } : {}),
  };
}

function readOptionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new MediaPayloadError(`${label} must be a string when provided`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new MediaPayloadError(`${label} cannot be blank`);
  }
  if (normalized.length > maxLength) {
    throw new MediaPayloadError(`${label} cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function validateHttpsLink(type: MediaMessageType, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaPayloadError(`${type} payload 'link' must be an absolute HTTPS URL`);
  }

  if (url.protocol !== "https:" || !url.hostname) {
    throw new MediaPayloadError(`${type} payload 'link' must be an absolute HTTPS URL`);
  }
  if (url.username || url.password) {
    throw new MediaPayloadError(`${type} payload 'link' cannot contain embedded credentials`);
  }
  if (url.hash) {
    throw new MediaPayloadError(`${type} payload 'link' cannot contain a URL fragment`);
  }
}
