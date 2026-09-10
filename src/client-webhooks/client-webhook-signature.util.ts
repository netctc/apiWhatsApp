import { createHmac, timingSafeEqual } from "node:crypto";

export function signClientWebhook(secret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(body)
    .digest("hex");
  return `v1=${digest}`;
}

export function verifyClientWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const expected = signClientWebhook(secret, timestamp, body);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signature);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
