import type { Request } from "express";
import type { AuditRequestContext } from "./audit.types.js";

export function auditRequestContext(request: Request): AuditRequestContext {
  const userAgent = request.get("user-agent") ?? undefined;
  const ipAddress = request.ip || request.socket.remoteAddress || undefined;
  return {
    ...(ipAddress ? { ipAddress } : {}),
    ...(userAgent ? { userAgent: userAgent.slice(0, 1000) } : {}),
  };
}
