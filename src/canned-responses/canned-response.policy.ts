/** Application limits, independent of provider template approval or sending policy. */
export const SHORTCUT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_REVISION = 2147483646;

export class CannedResponseInputError extends Error {}

export interface CannedResponseContent {
  shortcut: string;
  title: string;
  body: string;
}

export interface CannedResponsePatch {
  expectedRevision: number;
  changes: Partial<CannedResponseContent> & { active?: boolean };
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CannedResponseInputError("A canned response object is required");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new CannedResponseInputError("Unknown canned response field");
  }
  return input;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new CannedResponseInputError(`${label} must be text`);
  }
  const normalized = value.trim();
  const characters = Array.from(normalized);
  if (!characters.length || characters.length > maximum) {
    throw new CannedResponseInputError(`${label} must contain 1-${maximum} characters`);
  }
  // PostgreSQL text cannot store NUL; reject unpaired UTF-16 surrogates before encoding.
  if (characters.some((character) => character === "\0" ||
    (character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff))) {
    throw new CannedResponseInputError(`${label} contains unsupported characters`);
  }
  return normalized;
}

export function normalizeShortcut(value: unknown): string {
  const shortcut = text(value, "Shortcut", 32).toLowerCase();
  if (!SHORTCUT_PATTERN.test(shortcut)) {
    throw new CannedResponseInputError("Shortcut must start with a letter and contain only a-z, 0-9, _ or -");
  }
  return shortcut;
}

export function prepareCannedResponseCreate(value: unknown): CannedResponseContent {
  const input = record(value, ["shortcut", "title", "body"]);
  return {
    shortcut: normalizeShortcut(input.shortcut),
    title: text(input.title, "Title", 100),
    body: text(input.body, "Body", 4096),
  };
}

export function prepareCannedResponsePatch(value: unknown): CannedResponsePatch {
  const input = record(value, ["shortcut", "title", "body", "active", "expectedRevision"]);
  if (!Number.isInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 ||
    (input.expectedRevision as number) > MAX_REVISION) {
    throw new CannedResponseInputError("expectedRevision must be a positive supported integer");
  }
  const changes: CannedResponsePatch["changes"] = {};
  if (input.shortcut !== undefined) changes.shortcut = normalizeShortcut(input.shortcut);
  if (input.title !== undefined) changes.title = text(input.title, "Title", 100);
  if (input.body !== undefined) changes.body = text(input.body, "Body", 4096);
  if (input.active !== undefined) {
    if (typeof input.active !== "boolean") throw new CannedResponseInputError("active must be a boolean");
    changes.active = input.active;
  }
  if (!Object.keys(changes).length) throw new CannedResponseInputError("At least one mutable field is required");
  return { expectedRevision: input.expectedRevision as number, changes };
}
