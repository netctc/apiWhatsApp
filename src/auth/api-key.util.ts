import { createHash, randomBytes } from "node:crypto";

const API_KEY_PREFIX = "wapi";
const KEY_PREFIX_BYTES = 8;
const KEY_SECRET_BYTES = 32;
const API_KEY_PATTERN = /^wapi\.([a-f0-9]{16})\.([A-Za-z0-9_-]{32,})$/;

export interface GeneratedApiKey {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const keyPrefix = randomBytes(KEY_PREFIX_BYTES).toString("hex");
  const secret = randomBytes(KEY_SECRET_BYTES).toString("base64url");
  const rawKey = `${API_KEY_PREFIX}.${keyPrefix}.${secret}`;

  return {
    rawKey,
    keyPrefix,
    keyHash: hashApiKey(rawKey),
  };
}

export function parseApiKey(rawKey: string): { keyPrefix: string } | undefined {
  const match = API_KEY_PATTERN.exec(rawKey);
  if (!match) {
    return undefined;
  }

  return { keyPrefix: match[1] };
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}
