import type { ApiPrincipal } from "../auth/auth.types.js";
import { Prisma } from "../generated/prisma/client.js";
import type { AuditRequestContext } from "./audit.types.js";

export interface MutationActor {
  tenantId: string;
  apiKeyId?: string;
}

export function mutationActor(value: string | ApiPrincipal): MutationActor {
  return typeof value === "string"
    ? { tenantId: value }
    : { tenantId: value.tenantId, apiKeyId: value.apiKeyId };
}

export function auditLogData(
  actor: MutationActor,
  context: AuditRequestContext | undefined,
  action: string,
  entityType: string,
  entityId: string | undefined,
  metadata?: unknown,
): Prisma.AuditLogUncheckedCreateInput | undefined {
  if (!actor.apiKeyId) {
    return undefined;
  }

  return {
    tenantId: actor.tenantId,
    actorApiKeyId: actor.apiKeyId,
    action,
    entityType,
    entityId,
    ...(metadata === undefined ? {} : { metadata: toJson(metadata) }),
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
  };
}

export function changedFields(
  source: Record<string, unknown>,
  aliases: Record<string, string> = {},
): string[] {
  return Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .map((key) => aliases[key] ?? key)
    .sort();
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}
