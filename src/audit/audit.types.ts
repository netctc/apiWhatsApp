export interface AuditRequestContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditActor {
  tenantId: string;
  apiKeyId: string;
}
