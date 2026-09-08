import { generateApiKey, hashApiKey } from "../src/auth/api-key.util.js";

describe("API key utilities", () => {
  it("generates unique keys with the expected public prefix", () => {
    const first = generateApiKey();
    const second = generateApiKey();

    expect(first.rawKey).toMatch(/^wapi_[a-f0-9]{12}_[A-Za-z0-9_-]+$/);
    expect(first.prefix).toHaveLength(12);
    expect(first.rawKey).not.toBe(second.rawKey);
  });

  it("hashes the same key deterministically and changes with the server secret", () => {
    const key = "wapi_0123456789ab_example-secret";

    expect(hashApiKey(key, "server-secret-a")).toBe(hashApiKey(key, "server-secret-a"));
    expect(hashApiKey(key, "server-secret-a")).not.toBe(hashApiKey(key, "server-secret-b"));
  });
});
