import {
  validateApiProductionConfig,
  validateWorkerProductionConfig,
} from "../src/config/production-config.validator.js";

function sharedProductionConfig(): Record<string, unknown> {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://db.example.internal:5432/api_whatsapp",
    REDIS_URL: "rediss://redis.example.internal:6379",
    RABBITMQ_URL: "amqps://rabbit.example.internal:5671",
    META_GRAPH_API_VERSION: "v24.0",
    APP_REVISION: "a".repeat(40),
    SECRET_FILE_ROOTS: "/run/secrets/api-whatsapp,/mnt/runtime-secrets",
  };
}

function apiProductionConfig(): Record<string, unknown> {
  return {
    ...sharedProductionConfig(),
    PORT: "3000",
    API_KEY_HASH_SECRET: "k".repeat(48),
    META_WEBHOOK_VERIFY_TOKEN: "verify-token-1234567890",
    META_APP_SECRET: "m".repeat(32),
    METRICS_BEARER_TOKEN: "t".repeat(48),
    MEDIA_BINARY_STORAGE_MODE: "disabled",
    MEDIA_MALWARE_SCAN_MODE: "disabled",
  };
}

function errorMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected production configuration validation to fail");
}

describe("production configuration validator", () => {
  it("is a no-op outside production", () => {
    const config = { NODE_ENV: "test" };
    expect(validateApiProductionConfig(config)).toBe(config);
    expect(validateWorkerProductionConfig(config)).toBe(config);
  });

  it("accepts a complete production API profile", () => {
    const config = apiProductionConfig();
    expect(validateApiProductionConfig(config)).toBe(config);
  });

  it("accepts a production worker profile without API-only secrets", () => {
    const config = sharedProductionConfig();
    expect(validateWorkerProductionConfig(config)).toBe(config);
  });

  it("fails shared configuration on missing dependencies, malformed Meta version, and revision", () => {
    const config = sharedProductionConfig();
    delete config.DATABASE_URL;
    config.REDIS_URL = "http://redis.example.internal";
    config.RABBITMQ_URL = "https://rabbit.example.internal";
    config.META_GRAPH_API_VERSION = "vXX.X";
    config.APP_REVISION = "ABC123";

    const message = errorMessage(() => validateWorkerProductionConfig(config));
    expect(message).toContain("DATABASE_URL: is required");
    expect(message).toContain("REDIS_URL: must use redis: or rediss:");
    expect(message).toContain("RABBITMQ_URL: must use amqp: or amqps:");
    expect(message).toContain("META_GRAPH_API_VERSION: must use the format vNN.N");
    expect(message).toContain("APP_REVISION: must be the exact lowercase 40-character Git commit SHA");
  });

  it("requires API authentication, webhook, and metrics credentials without leaking values", () => {
    const config = apiProductionConfig();
    config.API_KEY_HASH_SECRET = "api-secret-do-not-leak";
    config.META_WEBHOOK_VERIFY_TOKEN = "webhook-secret";
    config.META_APP_SECRET = "meta-secret";
    config.METRICS_BEARER_TOKEN = "metrics-secret-do-not-leak";

    const message = errorMessage(() => validateApiProductionConfig(config));
    expect(message).toContain("API_KEY_HASH_SECRET");
    expect(message).toContain("META_WEBHOOK_VERIFY_TOKEN");
    expect(message).toContain("META_APP_SECRET");
    expect(message).toContain("METRICS_BEARER_TOKEN");
    expect(message).not.toContain("api-secret-do-not-leak");
    expect(message).not.toContain("webhook-secret");
    expect(message).not.toContain("meta-secret");
    expect(message).not.toContain("metrics-secret-do-not-leak");
  });

  it("rejects the documented API key placeholder even though it is long enough", () => {
    const config = apiProductionConfig();
    config.API_KEY_HASH_SECRET = "replace-with-a-long-random-secret";

    expect(errorMessage(() => validateApiProductionConfig(config))).toContain(
      "API_KEY_HASH_SECRET: must not use the documented placeholder value",
    );
  });

  it("validates an optional custom Meta Graph base URL without exposing it", () => {
    const config = sharedProductionConfig();
    config.META_GRAPH_API_BASE_URL = "http://user:password@graph.example.test/path?token=secret";

    const message = errorMessage(() => validateWorkerProductionConfig(config));
    expect(message).toContain("META_GRAPH_API_BASE_URL: must use https:");
    expect(message).toContain("META_GRAPH_API_BASE_URL: must not contain embedded credentials");
    expect(message).toContain("META_GRAPH_API_BASE_URL: must not contain query parameters or fragments");
    expect(message).not.toContain("password");
    expect(message).not.toContain("token=secret");
  });

  it("validates mounted secret root syntax when explicitly configured", () => {
    const config = sharedProductionConfig();
    config.SECRET_FILE_ROOTS = "/run/secrets/api-whatsapp,relative/path,/";

    expect(errorMessage(() => validateWorkerProductionConfig(config))).toContain(
      "SECRET_FILE_ROOTS: must contain only absolute non-root paths",
    );
  });

  it("accepts valid filesystem media storage and rejects unsafe filesystem controls", () => {
    const valid = apiProductionConfig();
    valid.MEDIA_BINARY_STORAGE_MODE = "filesystem";
    valid.MEDIA_FILESYSTEM_STORAGE_PATH = "/var/lib/api-whatsapp/media";
    valid.MEDIA_FILESYSTEM_MIN_FREE_BYTES = "0";
    valid.MEDIA_FILESYSTEM_MIN_FREE_PERCENT = "5";
    expect(validateApiProductionConfig(valid)).toBe(valid);

    const invalid = { ...valid };
    invalid.MEDIA_FILESYSTEM_STORAGE_PATH = "/";
    invalid.MEDIA_FILESYSTEM_MIN_FREE_BYTES = "-1";
    invalid.MEDIA_FILESYSTEM_MIN_FREE_PERCENT = "101";
    const message = errorMessage(() => validateApiProductionConfig(invalid));
    expect(message).toContain("MEDIA_FILESYSTEM_STORAGE_PATH: must be an absolute non-root path");
    expect(message).toContain("MEDIA_FILESYSTEM_MIN_FREE_BYTES");
    expect(message).toContain("MEDIA_FILESYSTEM_MIN_FREE_PERCENT");
  });

  it("validates S3 configuration only when S3 storage is enabled", () => {
    const disabled = apiProductionConfig();
    disabled.MEDIA_S3_ENDPOINT = "http://unsafe.example.test";
    expect(validateApiProductionConfig(disabled)).toBe(disabled);

    const s3 = apiProductionConfig();
    s3.MEDIA_BINARY_STORAGE_MODE = "s3";
    s3.MEDIA_S3_ENDPOINT = "http://user:secret@s3.example.test/path?credential=leak";
    s3.MEDIA_S3_BUCKET = "Invalid..Bucket";
    s3.MEDIA_S3_REGION = "bad_region";
    s3.MEDIA_S3_ACCESS_KEY_ID = "";
    s3.MEDIA_S3_SECRET_ACCESS_KEY = "super-secret-s3-value";
    s3.MEDIA_S3_TIMEOUT_MS = "999";

    const message = errorMessage(() => validateApiProductionConfig(s3));
    expect(message).toContain("MEDIA_S3_ENDPOINT: must use https:");
    expect(message).toContain("MEDIA_S3_ENDPOINT: must not contain embedded credentials");
    expect(message).toContain("MEDIA_S3_ENDPOINT: must not contain query parameters or fragments");
    expect(message).toContain("MEDIA_S3_ENDPOINT: must not contain a path");
    expect(message).toContain("MEDIA_S3_BUCKET: must be a DNS-compatible bucket name");
    expect(message).toContain("MEDIA_S3_REGION");
    expect(message).toContain("MEDIA_S3_ACCESS_KEY_ID: is required");
    expect(message).toContain("MEDIA_S3_TIMEOUT_MS");
    expect(message).not.toContain("super-secret-s3-value");
    expect(message).not.toContain("credential=leak");
  });

  it("validates ClamAV configuration only when malware scanning is enabled", () => {
    const disabled = apiProductionConfig();
    disabled.MEDIA_CLAMAV_PORT = "99999";
    expect(validateApiProductionConfig(disabled)).toBe(disabled);

    const clamav = apiProductionConfig();
    clamav.MEDIA_MALWARE_SCAN_MODE = "clamav";
    clamav.MEDIA_CLAMAV_HOST = "";
    clamav.MEDIA_CLAMAV_PORT = "0";
    clamav.MEDIA_CLAMAV_TIMEOUT_MS = "999";

    const message = errorMessage(() => validateApiProductionConfig(clamav));
    expect(message).toContain("MEDIA_CLAMAV_HOST: is required");
    expect(message).toContain("MEDIA_CLAMAV_PORT");
    expect(message).toContain("MEDIA_CLAMAV_TIMEOUT_MS");
  });

  it("rejects unsupported optional modes and an invalid API port", () => {
    const config = apiProductionConfig();
    config.PORT = "70000";
    config.MEDIA_BINARY_STORAGE_MODE = "local";
    config.MEDIA_MALWARE_SCAN_MODE = "scanner";

    const message = errorMessage(() => validateApiProductionConfig(config));
    expect(message).toContain("PORT: must be an integer between 1 and 65535");
    expect(message).toContain("MEDIA_BINARY_STORAGE_MODE: must be disabled, filesystem, or s3");
    expect(message).toContain("MEDIA_MALWARE_SCAN_MODE: must be disabled or clamav");
  });
});
