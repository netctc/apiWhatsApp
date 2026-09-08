import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ListAuditLogsQueryDto } from "./dto/list-audit-logs-query.dto.js";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, query: ListAuditLogsQueryDto) {
    if (query.cursor) {
      const cursor = await this.prisma.auditLog.findFirst({
        where: { id: query.cursor, tenantId },
        select: { id: true },
      });
      if (!cursor) {
        throw new BadRequestException("Audit cursor is invalid for this tenant");
      }
    }

    const where: Prisma.AuditLogWhereInput = {
      tenantId,
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
    };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        actorApiKeyId: true,
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
      },
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
  }
}
