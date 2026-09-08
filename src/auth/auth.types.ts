import type { Request } from "express";

export interface ApiAuthContext {
  tenantId: string;
  apiKeyId: string;
  scopes: string[];
}

export interface AuthenticatedRequest extends Request {
  auth?: ApiAuthContext;
}
