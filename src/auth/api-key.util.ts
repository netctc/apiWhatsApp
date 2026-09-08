import { createHmac, randomBytes } from "node:crypto";

const KEY_PREFIX = "wapi";

export function generateApiKey(): { rawKey: string; prefix: string } {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return {
    rawKey: `${KEY_PREFIX}_${prefix}_${secret}`,
    prefix,
  };
}

export function hashApiKey(rawKey: string, hashSecret: string): string {
  return createHmac("sha256", hashSecret).update(rawKey).digest("hex");
}
