import { Injectable } from "@nestjs/common";
import {
  CampaignRecipientStatus,
  CampaignStatus,
  MessageStatus,
  Prisma,
} from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

interface HttpLabels {
  method: string;
  controller: string;
  handler: string;
  statusCode: string;
}

interface HttpSeries {
  labels: HttpLabels;
  count: number;
  sum: number;
  buckets: number[];
}

interface BacklogRow {
  pending: number;
  due: number;
  leased: number;
  oldestPendingAgeSeconds: number | null;
}

@Injectable()
export class MetricsService {
  private readonly http = new Map<string, HttpSeries>();
  private readonly startedAtSeconds = Date.now() / 1000;

  constructor(private readonly prisma: PrismaService) {}

  recordHttp(
    method: string,
    controller: string,
    handler: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    const labels: HttpLabels = {
      method: this.safeLabel(method.toUpperCase(), "UNKNOWN"),
      controller: this.safeLabel(controller, "UnknownController"),
      handler: this.safeLabel(handler, "unknownHandler"),
      statusCode: String(statusCode),
    };
    const key = JSON.stringify(labels);
    const series = this.http.get(key) ?? {
      labels,
      count: 0,
      sum: 0,
      buckets: HTTP_BUCKETS.map(() => 0),
    };

    const safeDuration = Number.isFinite(durationSeconds) && durationSeconds >= 0
      ? durationSeconds
      : 0;
    series.count += 1;
    series.sum += safeDuration;
    HTTP_BUCKETS.forEach((boundary, index) => {
      if (safeDuration <= boundary) {
        series.buckets[index] += 1;
      }
    });
    this.http.set(key, series);
  }

  async render(): Promise<string> {
    const [messageRows, campaignRows, recipientRows, outboxRows, webhookRows] = await Promise.all([
      this.prisma.message.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      this.prisma.campaign.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      this.prisma.campaignRecipient.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<BacklogRow[]>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE "publishedAt" IS NULL)::int AS "pending",
          COUNT(*) FILTER (
            WHERE "publishedAt" IS NULL
              AND "nextAttemptAt" <= NOW()
              AND ("processingLeaseUntil" IS NULL OR "processingLeaseUntil" <= NOW())
          )::int AS "due",
          COUNT(*) FILTER (
            WHERE "publishedAt" IS NULL
              AND "processingLeaseUntil" > NOW()
          )::int AS "leased",
          EXTRACT(EPOCH FROM (
            NOW() - MIN("createdAt") FILTER (WHERE "publishedAt" IS NULL)
          ))::int AS "oldestPendingAgeSeconds"
        FROM "OutboxEvent"
      `),
      this.prisma.$queryRaw<BacklogRow[]>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE "processed" = false)::int AS "pending",
          COUNT(*) FILTER (
            WHERE "processed" = false
              AND "nextAttemptAt" <= NOW()
              AND ("processingLeaseUntil" IS NULL OR "processingLeaseUntil" <= NOW())
          )::int AS "due",
          COUNT(*) FILTER (
            WHERE "processed" = false
              AND "processingLeaseUntil" > NOW()
          )::int AS "leased",
          EXTRACT(EPOCH FROM (
            NOW() - MIN("receivedAt") FILTER (WHERE "processed" = false)
          ))::int AS "oldestPendingAgeSeconds"
        FROM "WebhookEvent"
      `),
    ]);

    const messages = this.zeroedRecord(MessageStatus);
    for (const row of messageRows) {
      messages[row.status] = row._count._all;
    }
    const campaigns = this.zeroedRecord(CampaignStatus);
    for (const row of campaignRows) {
      campaigns[row.status] = row._count._all;
    }
    const recipients = this.zeroedRecord(CampaignRecipientStatus);
    for (const row of recipientRows) {
      recipients[row.status] = row._count._all;
    }

    const outbox = outboxRows[0] ?? this.emptyBacklog();
    const webhooks = webhookRows[0] ?? this.emptyBacklog();
    const memory = process.memoryUsage();
    const lines: string[] = [];

    this.addGauge(lines, "api_whatsapp_process_start_time_seconds", "Process start time in Unix seconds.", this.startedAtSeconds);
    this.addGauge(lines, "api_whatsapp_process_uptime_seconds", "Process uptime in seconds.", process.uptime());
    this.addGauge(lines, "api_whatsapp_process_resident_memory_bytes", "Resident process memory in bytes.", memory.rss);
    this.addGauge(lines, "api_whatsapp_process_heap_used_bytes", "Node.js heap currently used in bytes.", memory.heapUsed);

    this.renderHttp(lines);
    this.renderEnumGauge(lines, "api_whatsapp_messages", "Persisted messages by current status.", "status", messages);
    this.renderEnumGauge(lines, "api_whatsapp_campaigns", "Campaigns by current lifecycle status.", "status", campaigns);
    this.renderEnumGauge(
      lines,
      "api_whatsapp_campaign_recipients",
      "Campaign recipients by current orchestration status.",
      "status",
      recipients,
    );
    this.renderBacklog(lines, "outbox", "Transactional outbox", outbox);
    this.renderBacklog(lines, "webhook", "Durable webhook processor", webhooks);

    return `${lines.join("\n")}\n`;
  }

  private renderHttp(lines: string[]): void {
    lines.push("# HELP api_whatsapp_http_requests_total HTTP requests handled by bounded controller/handler labels.");
    lines.push("# TYPE api_whatsapp_http_requests_total counter");
    for (const series of this.http.values()) {
      const labels = this.httpLabels(series.labels);
      lines.push(`api_whatsapp_http_requests_total${labels} ${series.count}`);
    }

    lines.push("# HELP api_whatsapp_http_request_duration_seconds HTTP request duration by bounded controller/handler labels.");
    lines.push("# TYPE api_whatsapp_http_request_duration_seconds histogram");
    for (const series of this.http.values()) {
      HTTP_BUCKETS.forEach((boundary, index) => {
        lines.push(
          `api_whatsapp_http_request_duration_seconds_bucket${this.httpLabels(series.labels, String(boundary))} ${series.buckets[index]}`,
        );
      });
      lines.push(
        `api_whatsapp_http_request_duration_seconds_bucket${this.httpLabels(series.labels, "+Inf")} ${series.count}`,
      );
      const labels = this.httpLabels(series.labels);
      lines.push(`api_whatsapp_http_request_duration_seconds_sum${labels} ${series.sum}`);
      lines.push(`api_whatsapp_http_request_duration_seconds_count${labels} ${series.count}`);
    }
  }

  private renderEnumGauge<T extends string>(
    lines: string[],
    metric: string,
    help: string,
    labelName: string,
    values: Record<T, number>,
  ): void {
    lines.push(`# HELP ${metric} ${help}`);
    lines.push(`# TYPE ${metric} gauge`);
    for (const [label, value] of Object.entries(values)) {
      lines.push(`${metric}{${labelName}="${this.escapeLabel(label)}"} ${value}`);
    }
  }

  private renderBacklog(lines: string[], key: string, helpPrefix: string, backlog: BacklogRow): void {
    const metrics: Array<[string, string, number]> = [
      ["pending", `${helpPrefix} records waiting for completion.`, backlog.pending],
      ["due", `${helpPrefix} records currently due and not actively leased.`, backlog.due],
      ["leased", `${helpPrefix} records currently protected by an active processing lease.`, backlog.leased],
      [
        "oldest_pending_age_seconds",
        `Age in seconds of the oldest pending ${helpPrefix.toLowerCase()} record.`,
        backlog.oldestPendingAgeSeconds ?? 0,
      ],
    ];
    for (const [suffix, help, value] of metrics) {
      this.addGauge(lines, `api_whatsapp_${key}_${suffix}`, help, value);
    }
  }

  private addGauge(lines: string[], metric: string, help: string, value: number): void {
    lines.push(`# HELP ${metric} ${help}`);
    lines.push(`# TYPE ${metric} gauge`);
    lines.push(`${metric} ${Number.isFinite(value) ? value : 0}`);
  }

  private httpLabels(labels: HttpLabels, le?: string): string {
    const entries = [
      ["method", labels.method],
      ["controller", labels.controller],
      ["handler", labels.handler],
      ["status_code", labels.statusCode],
      ...(le === undefined ? [] : [["le", le]]),
    ];
    return `{${entries
      .map(([key, value]) => `${key}="${this.escapeLabel(value)}"`)
      .join(",")}}`;
  }

  private safeLabel(value: string, fallback: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }
    return trimmed.slice(0, 96).replace(/[^A-Za-z0-9_.:-]/g, "_");
  }

  private escapeLabel(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
  }

  private zeroedRecord<T extends string>(values: Record<string, T>): Record<T, number> {
    return Object.fromEntries(Object.values(values).map((value) => [value, 0])) as Record<T, number>;
  }

  private emptyBacklog(): BacklogRow {
    return { pending: 0, due: 0, leased: 0, oldestPendingAgeSeconds: null };
  }
}
