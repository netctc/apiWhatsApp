export const IS_PUBLIC_KEY = "auth:isPublic";
export const REQUIRED_SCOPES_KEY = "auth:requiredScopes";

export enum ApiScope {
  MESSAGES_READ = "messages:read",
  MESSAGES_WRITE = "messages:write",
  MEDIA_WRITE = "media:write",
  CONTACTS_READ = "contacts:read",
  CONTACTS_WRITE = "contacts:write",
  PHONE_NUMBERS_READ = "phone_numbers:read",
  PHONE_NUMBERS_WRITE = "phone_numbers:write",
  TEMPLATES_READ = "templates:read",
  TEMPLATES_WRITE = "templates:write",
  CAMPAIGNS_READ = "campaigns:read",
  CAMPAIGNS_WRITE = "campaigns:write",
  SEGMENTS_READ = "segments:read",
  SEGMENTS_WRITE = "segments:write",
  CLIENT_WEBHOOKS_READ = "client_webhooks:read",
  CLIENT_WEBHOOKS_WRITE = "client_webhooks:write",
  OPERATIONS_READ = "operations:read",
  API_KEYS_READ = "api_keys:read",
  API_KEYS_WRITE = "api_keys:write",
  AUDIT_READ = "audit:read",
}

export const DEFAULT_API_SCOPES: ApiScope[] = Object.values(ApiScope);
