import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { auditLogData, mutationActor } from "../audit/audit-write.util.js";
import type { AuditRequestContext } from "../audit/audit.types.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CannedResponseInputError, normalizeShortcut, prepareCannedResponseCreate, prepareCannedResponsePatch } from "./canned-response.policy.js";
import type { CreateCannedResponseDto, ListCannedResponsesQueryDto, UpdateCannedResponseDto } from "./dto/canned-response-input.dto.js";
import type { CannedResponseDto, CannedResponsePageDto } from "./dto/canned-response.dto.js";

const select = {
  id: true, shortcut: true, title: true, body: true, active: true,
  revision: true, createdAt: true, updatedAt: true,
} satisfies Prisma.InboxCannedResponseSelect;

@Injectable()
export class CannedResponsesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(principal: ApiPrincipal, dto: CreateCannedResponseDto, context?: AuditRequestContext): Promise<CannedResponseDto> {
    try {
      const content = prepareCannedResponseCreate(dto);
      return await this.prisma.$transaction(async (tx) => {
        const item = await tx.inboxCannedResponse.create({ data: { tenantId: principal.tenantId, ...content }, select });
        const audit = auditLogData(mutationActor(principal), context, "inbox.canned_response.created", "InboxCannedResponse", item.id, { revision: item.revision, active: item.active });
        if (audit) await tx.auditLog.create({ data: audit });
        return item;
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async list(tenantId: string, query: ListCannedResponsesQueryDto): Promise<CannedResponsePageDto> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100 || !["active", "inactive", "all"].includes(query.status)) {
      throw new BadRequestException("Invalid canned response page parameters");
    }
    let shortcut: string | undefined;
    try {
      shortcut = query.shortcut === undefined ? undefined : normalizeShortcut(query.shortcut);
    } catch (error) {
      this.rethrow(error);
    }
    let position: Prisma.InboxCannedResponseWhereInput = {};
    if (query.cursor !== undefined) {
      const anchor = await this.prisma.inboxCannedResponse.findFirst({
        where: { id: query.cursor, tenantId }, select: { id: true, createdAt: true },
      });
      if (!anchor) throw new BadRequestException("Canned response cursor is invalid for this tenant");
      // The anchor may no longer match active/shortcut. Exclude its position, not
      // the first matching row: cursor + skip: 1 would silently drop that row.
      // This table uses TIMESTAMP(3), so its timestamp round-trips exactly via Date.
      position = {
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ],
      };
    }
    const rows = await this.prisma.inboxCannedResponse.findMany({
      where: {
        tenantId,
        ...(query.status === "all" ? {} : { active: query.status === "active" }),
        ...(shortcut === undefined ? {} : { shortcut }),
        ...position,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select,
    });
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  }

  async find(tenantId: string, id: string): Promise<CannedResponseDto> {
    const item = await this.prisma.inboxCannedResponse.findFirst({ where: { id, tenantId }, select });
    if (!item) throw new NotFoundException("Canned response not found");
    return item;
  }

  async update(principal: ApiPrincipal, id: string, dto: UpdateCannedResponseDto, context?: AuditRequestContext): Promise<CannedResponseDto> {
    try {
      const { expectedRevision, changes } = prepareCannedResponsePatch(dto);
      return await this.prisma.$transaction(async (tx) => {
        // Compare and increment in one SQL UPDATE; no read-then-write race or timestamp token.
        const result = await tx.inboxCannedResponse.updateMany({
          where: { id, tenantId: principal.tenantId, revision: expectedRevision },
          data: { ...changes, revision: { increment: 1 } },
        });
        if (result.count === 0) {
          const exists = await tx.inboxCannedResponse.findFirst({ where: { id, tenantId: principal.tenantId }, select: { id: true } });
          if (!exists) throw new NotFoundException("Canned response not found");
          throw new ConflictException("Canned response revision has changed; reload before updating");
        }
        const item = await tx.inboxCannedResponse.findFirstOrThrow({ where: { id, tenantId: principal.tenantId }, select });
        const audit = auditLogData(mutationActor(principal), context, "inbox.canned_response.updated", "InboxCannedResponse", id, {
          changedFields: Object.keys(changes).sort(), revision: item.revision, active: item.active,
        });
        if (audit) await tx.auditLog.create({ data: audit });
        return item;
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof CannedResponseInputError) throw new BadRequestException(error.message);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictException("Canned response shortcut already exists in this tenant");
    }
    throw error;
  }
}
