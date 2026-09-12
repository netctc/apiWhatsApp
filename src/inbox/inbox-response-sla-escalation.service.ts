import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";

const DEFAULT_ESCALATION_INTERVAL_MS = 60 * 1000;
const MIN_ESCALATION_INTERVAL_MS = 5 * 1000;
const MAX_ESCALATION_INTERVAL_MS = 60 * 60 * 1000;
const ESCALATION_BATCH_SIZE = 200;

interface EscalatedConversationRow {
  id: string;
  tenantId: string;
}

@Injectable()
export class InboxResponseSlaEscalationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InboxResponseSlaEscalationService.name);
  private escalationTimer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const intervalMs = this.readEscalationIntervalMs();
    await this.runScan("Initial");

    this.escalationTimer = setInterval(() => {
      void this.runScan("Periodic");
    }, intervalMs);
    this.escalationTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.escalationTimer) {
      clearInterval(this.escalationTimer);
      this.escalationTimer = undefined;
    }
  }

  async escalateOverdue(now = new Date()): Promise<number> {
    const rows = await this.prisma.$queryRaw<EscalatedConversationRow[]>(Prisma.sql`
      WITH due AS (
        SELECT c."id"
        FROM "Conversation" AS c
        WHERE c."status" IN ('OPEN'::"ConversationStatus", 'PENDING'::"ConversationStatus")
          AND c."responseSlaStartedAt" IS NOT NULL
          AND c."responseSlaDueAt" IS NOT NULL
          AND c."responseSlaDueAt" <= ${now}
          AND c."responseSlaRespondedAt" IS NULL
          AND c."responseSlaEscalatedAt" IS NULL
        ORDER BY c."responseSlaDueAt" ASC, c."id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${ESCALATION_BATCH_SIZE}
      )
      UPDATE "Conversation" AS c
      SET
        "responseSlaEscalatedAt" = ${now},
        "updatedAt" = CURRENT_TIMESTAMP
      FROM due
      WHERE c."id" = due."id"
        AND c."status" IN ('OPEN'::"ConversationStatus", 'PENDING'::"ConversationStatus")
        AND c."responseSlaDueAt" <= ${now}
        AND c."responseSlaRespondedAt" IS NULL
        AND c."responseSlaEscalatedAt" IS NULL
      RETURNING c."id", c."tenantId"
    `);

    if (rows.length > 0) {
      this.logger.warn(`Escalated ${rows.length} overdue inbox response SLA cycle${rows.length === 1 ? "" : "s"}`);
    }
    return rows.length;
  }

  private async runScan(prefix: "Initial" | "Periodic"): Promise<void> {
    await this.escalateOverdue().catch((error: unknown) => {
      this.logger.error(
        `${prefix} inbox response SLA escalation scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private readEscalationIntervalMs(): number {
    const raw = process.env.INBOX_SLA_ESCALATION_INTERVAL_MS;
    if (raw === undefined || raw.trim() === "") {
      return DEFAULT_ESCALATION_INTERVAL_MS;
    }

    const value = Number(raw);
    if (
      !Number.isInteger(value) ||
      value < MIN_ESCALATION_INTERVAL_MS ||
      value > MAX_ESCALATION_INTERVAL_MS
    ) {
      throw new Error(
        `INBOX_SLA_ESCALATION_INTERVAL_MS must be an integer between ${MIN_ESCALATION_INTERVAL_MS} and ${MAX_ESCALATION_INTERVAL_MS}`,
      );
    }
    return value;
  }
}
