export const IS_PUBLIC_KEY = "auth:isPublic";
export const REQUIRED_SCOPES_KEY = "auth:requiredScopes";

export enum ApiScope {
  MESSAGES_READ = "messages:read",
  MESSAGES_WRITE = "messages:write",
  CONTACTS_READ = "contacts:read",
  CONTACTS_WRITE = "contacts:write",
  PHONE_NUMBERS_READ = "phone_numbers:read",
  PHONE_NUMBERS_WRITE = "phone_numbers:write",
}

export const DEFAULT_API_SCOPES: ApiScope[] = [
  ApiScope.MESSAGES_READ,
  ApiScope.MESSAGES_WRITE,
  ApiScope.CONTACTS_READ,
  ApiScope.CONTACTS_WRITE,
  ApiScope.PHONE_NUMBERS_READ,
  ApiScope.PHONE_NUMBERS_WRITE,
];
