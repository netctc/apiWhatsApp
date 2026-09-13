import { isAbsolute, resolve, sep } from "node:path";

export type ProductionConfigProfile = "api" | "worker";

type EnvironmentConfig = Record<string, unknown>;

interface ValidationIssue {
  name: string;
  reason: string;
}

const EXACT_GIT_SHA = /^[0-9a-f]{40}$/;
const META_GRAPH_VERSION = /^v\d+\.\d+$/;
const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const S3_REGION = /^[a-z0-9-]{1,64}$/;
const UNSAFE_API_KEY_SECRET = "replace-with-a-long-random-secret";

function text(config: EnvironmentConfig, name: string): string {
  const value = config[name];
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function configured(config: EnvironmentConfig, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(config, name) && config[name] !== undefined;
}

function issue(issues: ValidationIssue[], name: string, reason: string): void {
  issues.push({ name, reason });
}

function requireText(
  config: EnvironmentConfig,
  issues: ValidationIssue[],
  name: string,
  minimumLength = 1,
): string {
  const value = text(config, name);
  if (!value) {
    issue(issues, name, "is required");
    return "";
  }
  if (value.length < minimumLength) {
    issue(issues, name, `must contain at least ${minimumLength} characters`);
  }
  return value;
}

function validateUrl(
  config: EnvironmentConfig,
  issues: ValidationIssue[],
  name: string,
  protocols: readonly string[],
  options: { required?: boolean; forbidCredentials?: boolean; forbidQueryOrFragment?: boolean } = {},
): URL | undefined {
  const value = text(config, name);
  if (!value) {
    if (options.required) {
      issue(issues, name, "is required");
    }
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issue(issues, name, "must be a valid absolute URL");
    return undefined;
  }

  if (!protocols.includes(url.protocol)) {
    issue(issues, name, `must use ${protocols.join(" or ")}`);
  }
  if (options.forbidCredentials && (url.username || url.password)) {
    issue(issues, name, "must not contain embedded credentials");
  }
  if (options.forbidQueryOrFragment && (url.search || url.hash)) {
    issue(issues, name, "must not contain query parameters or fragments");
  }
  return url;
}

function validateInteger(
  config: EnvironmentConfig,
  issues: ValidationIssue[],
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!configured(config, name) || text(config, name) === "") {
    return;
  }
  const value = Number(text(config, name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    issue(issues, name, `must be an integer between ${minimum} and ${maximum}`);
  }
}

function validateSafeIntegerMinimum(
  config: EnvironmentConfig,
  issues: ValidationIssue[],
  name: string,
  minimum: number,
): void {
  if (!configured(config, name) || text(config, name) === "") {
    return;
  }
  const value = Number(text(config, name));
  if (!Number.isSafeInteger(value) || value < minimum) {
    issue(issues, name, `must be a safe integer greater than or equal to ${minimum}`);
  }
}

function validateNumberRange(
  config: EnvironmentConfig,
  issues: ValidationIssue[],
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (!configured(config, name) || text(config, name) === "") {
    return;
  }
  const value = Number(text(config, name));
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    issue(issues, name, `must be a number between ${minimum} and ${maximum}`);
  }
}

function validateSecretRoots(config: EnvironmentConfig, issues: ValidationIssue[]): void {
  if (!configured(config, "SECRET_FILE_ROOTS")) {
    return;
  }
  const roots = text(config, "SECRET_FILE_ROOTS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (roots.length === 0) {
    issue(issues, "SECRET_FILE_ROOTS", "must contain at least one absolute non-root path");
    return;
  }

  if (roots.some((root) => !isAbsolute(root) || resolve(root) === sep)) {
    issue(issues, "SECRET_FILE_ROOTS", "must contain only absolute non-root paths");
  }
}

function validateSharedProductionConfig(config: EnvironmentConfig, issues: ValidationIssue[]): void {
  validateUrl(config, issues, "DATABASE_URL", ["postgresql:", "postgres:"], { required: true });
  validateUrl(config, issues, "REDIS_URL", ["redis:", "rediss:"], { required: true });
  validateUrl(config, issues, "RABBITMQ_URL", ["amqp:", "amqps:"], { required: true });

  const graphVersion = requireText(config, issues, "META_GRAPH_API_VERSION");
  if (graphVersion && !META_GRAPH_VERSION.test(graphVersion)) {
    issue(issues, "META_GRAPH_API_VERSION", "must use the format vNN.N");
  }

  const graphBase = validateUrl(config, issues, "META_GRAPH_API_BASE_URL", ["https:"], {
    forbidCredentials: true,
    forbidQueryOrFragment: true,
  });
  void graphBase;

  const revision = requireText(config, issues, "APP_REVISION");
  if (revision && !EXACT_GIT_SHA.test(revision)) {
    issue(issues, "APP_REVISION", "must be the exact lowercase 40-character Git commit SHA");
  }

  validateSecretRoots(config, issues);
}

function validateFilesystemMedia(config: EnvironmentConfig, issues: ValidationIssue[]): void {
  const path = requireText(config, issues, "MEDIA_FILESYSTEM_STORAGE_PATH");
  if (path && (!isAbsolute(path) || resolve(path) === sep)) {
    issue(issues, "MEDIA_FILESYSTEM_STORAGE_PATH", "must be an absolute non-root path");
  }
  validateSafeIntegerMinimum(config, issues, "MEDIA_FILESYSTEM_MIN_FREE_BYTES", 0);
  validateNumberRange(config, issues, "MEDIA_FILESYSTEM_MIN_FREE_PERCENT", 0, 100);
}

function validateS3Media(config: EnvironmentConfig, issues: ValidationIssue[]): void {
  const endpoint = validateUrl(config, issues, "MEDIA_S3_ENDPOINT", ["https:"], {
    required: true,
    forbidCredentials: true,
    forbidQueryOrFragment: true,
  });
  if (endpoint && endpoint.pathname !== "/" && endpoint.pathname !== "") {
    issue(issues, "MEDIA_S3_ENDPOINT", "must not contain a path");
  }

  const bucket = requireText(config, issues, "MEDIA_S3_BUCKET");
  if (bucket && (!S3_BUCKET.test(bucket) || bucket.includes(".."))) {
    issue(issues, "MEDIA_S3_BUCKET", "must be a DNS-compatible bucket name");
  }

  const region = text(config, "MEDIA_S3_REGION") || "us-east-1";
  if (!S3_REGION.test(region.toLowerCase())) {
    issue(issues, "MEDIA_S3_REGION", "must contain only lowercase letters, digits, or hyphens");
  }

  requireText(config, issues, "MEDIA_S3_ACCESS_KEY_ID");
  requireText(config, issues, "MEDIA_S3_SECRET_ACCESS_KEY");
  validateInteger(config, issues, "MEDIA_S3_TIMEOUT_MS", 1000, 300000);
}

function validateMediaProductionConfig(config: EnvironmentConfig, issues: ValidationIssue[]): void {
  const storageMode = (text(config, "MEDIA_BINARY_STORAGE_MODE") || "disabled").toLowerCase();
  if (!new Set(["disabled", "filesystem", "s3"]).has(storageMode)) {
    issue(issues, "MEDIA_BINARY_STORAGE_MODE", "must be disabled, filesystem, or s3");
  } else if (storageMode === "filesystem") {
    validateFilesystemMedia(config, issues);
  } else if (storageMode === "s3") {
    validateS3Media(config, issues);
  }

  const malwareMode = (text(config, "MEDIA_MALWARE_SCAN_MODE") || "disabled").toLowerCase();
  if (!new Set(["disabled", "clamav"]).has(malwareMode)) {
    issue(issues, "MEDIA_MALWARE_SCAN_MODE", "must be disabled or clamav");
  } else if (malwareMode === "clamav") {
    requireText(config, issues, "MEDIA_CLAMAV_HOST");
    validateInteger(config, issues, "MEDIA_CLAMAV_PORT", 1, 65535);
    validateInteger(config, issues, "MEDIA_CLAMAV_TIMEOUT_MS", 1000, 600000);
  }
}

function validateApiProductionConfigOnly(config: EnvironmentConfig, issues: ValidationIssue[]): void {
  const apiKeySecret = requireText(config, issues, "API_KEY_HASH_SECRET", 32);
  if (apiKeySecret === UNSAFE_API_KEY_SECRET) {
    issue(issues, "API_KEY_HASH_SECRET", "must not use the documented placeholder value");
  }

  requireText(config, issues, "META_WEBHOOK_VERIFY_TOKEN", 16);
  requireText(config, issues, "META_APP_SECRET", 16);
  requireText(config, issues, "METRICS_BEARER_TOKEN", 32);
  validateInteger(config, issues, "PORT", 1, 65535);
  validateMediaProductionConfig(config, issues);
}

export function validateProductionConfig(
  config: EnvironmentConfig,
  profile: ProductionConfigProfile,
): EnvironmentConfig {
  if (text(config, "NODE_ENV").toLowerCase() !== "production") {
    return config;
  }

  const issues: ValidationIssue[] = [];
  validateSharedProductionConfig(config, issues);
  if (profile === "api") {
    validateApiProductionConfigOnly(config, issues);
  }

  if (issues.length > 0) {
    const details = issues.map(({ name, reason }) => `${name}: ${reason}`).join("; ");
    throw new Error(`Production configuration validation failed (${profile}): ${details}`);
  }

  return config;
}

export function validateApiProductionConfig(config: EnvironmentConfig): EnvironmentConfig {
  return validateProductionConfig(config, "api");
}

export function validateWorkerProductionConfig(config: EnvironmentConfig): EnvironmentConfig {
  return validateProductionConfig(config, "worker");
}
