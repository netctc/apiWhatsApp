import { generateApiKey, hashApiKey, parseApiKey } from "../src/auth/api-key.util.js";

describe("API key utilities", () => {
  it("generates a parseable API key and a SHA-256 hash", () => {
    const generated = generateApiKey();

    expect(generated.rawKey).toMatch(/^wapi\.[a-f0-9]{16}\.[A-Za-z0-9_-]{32,}$/);
    expect(generated.keyHash).toHaveLength(64);
    expect(generated.keyHash).toBe(hashApiKey(generated.rawKey));
    expect(parseApiKey(generated.rawKey)).toEqual({
      keyPrefix: generated.keyPrefix,
    });
  });

  it("generates unique credentials", () => {
    const first = generateApiKey();
    const second = generateApiKey();

    expect(first.rawKey).not.toBe(second.rawKey);
    expect(first.keyPrefix).not.toBe(second.keyPrefix);
    expect(first.keyHash).not.toBe(second.keyHash);
  });

  it("rejects malformed API keys", () => {
    expect(parseApiKey("not-a-key")).toBeUndefined();
    expect(parseApiKey("wapi.short.secret")).toBeUndefined();
  });
});
