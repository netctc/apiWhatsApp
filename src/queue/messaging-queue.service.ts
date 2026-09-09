import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from "amqplib";
import { MessageTrafficClass } from "../generated/prisma/client.js";

export interface OutboundQueueJob {
  messageId: string;
  attempt: number;
  trafficClass: MessageTrafficClass;
}

export interface QueueProcessingResult {
  action: "ack" | "retry" | "dead";
  reason?: string;
}

type OutboundHandler = (job: OutboundQueueJob) => Promise<QueueProcessingResult>;
type ExhaustedHandler = (job: OutboundQueueJob, reason?: string) => Promise<void>;

const TRAFFIC_CLASSES: MessageTrafficClass[] = [
  MessageTrafficClass.OTP,
  MessageTrafficClass.TRANSACTIONAL,
  MessageTrafficClass.MARKETING,
];

@Injectable()
export class MessagingQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(MessagingQueueService.name);
  private connection?: ChannelModel;
  private publisherChannel?: ConfirmChannel;
  private readonly consumerChannels = new Map<string, ConfirmChannel>();

  async publishOutboundMessage(messageId: string, trafficClass: MessageTrafficClass): Promise<void> {
    const channel = await this.getPublisherChannel();
    await this.assertTrafficTopology(channel, trafficClass);

    channel.sendToQueue(
      this.trafficQueueName(trafficClass),
      Buffer.from(JSON.stringify({ messageId, trafficClass })),
      {
        persistent: true,
        contentType: "application/json",
        messageId,
        timestamp: Date.now(),
        headers: {
          "x-retry-count": 0,
          "x-traffic-class": trafficClass,
        },
      },
    );

    await channel.waitForConfirms();
  }

  async consumeOutboundMessages(handler: OutboundHandler, onExhausted: ExhaustedHandler): Promise<void> {
    for (const trafficClass of TRAFFIC_CLASSES) {
      await this.startTrafficConsumer(trafficClass, handler, onExhausted);
    }
    await this.startLegacyConsumer(handler, onExhausted);

    this.logger.log(
      `Outbound consumers ready: OTP=${this.prefetchFor(MessageTrafficClass.OTP)}, ` +
        `TRANSACTIONAL=${this.prefetchFor(MessageTrafficClass.TRANSACTIONAL)}, ` +
        `MARKETING=${this.prefetchFor(MessageTrafficClass.MARKETING)}; legacy queue enabled`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const channel of this.consumerChannels.values()) {
      await channel.close().catch(() => undefined);
    }
    this.consumerChannels.clear();
    await this.publisherChannel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private async startTrafficConsumer(
    trafficClass: MessageTrafficClass,
    handler: OutboundHandler,
    onExhausted: ExhaustedHandler,
  ): Promise<void> {
    const channel = await this.getConsumerChannel(trafficClass.toLowerCase());
    await this.assertTrafficTopology(channel, trafficClass);
    await channel.prefetch(this.prefetchFor(trafficClass));

    await channel.consume(this.trafficQueueName(trafficClass), (message) => {
      if (!message) {
        return;
      }
      void this.processDelivery(channel, message, trafficClass, handler, onExhausted);
    });
  }

  private async startLegacyConsumer(
    handler: OutboundHandler,
    onExhausted: ExhaustedHandler,
  ): Promise<void> {
    const channel = await this.getConsumerChannel("legacy");
    await this.assertLegacyTopology(channel);
    await channel.prefetch(this.prefetchFor(MessageTrafficClass.TRANSACTIONAL));

    await channel.consume(this.baseQueueName(), (message) => {
      if (!message) {
        return;
      }
      void this.processDelivery(
        channel,
        message,
        MessageTrafficClass.TRANSACTIONAL,
        handler,
        onExhausted,
      );
    });
  }

  private async processDelivery(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    trafficClass: MessageTrafficClass,
    handler: OutboundHandler,
    onExhausted: ExhaustedHandler,
  ): Promise<void> {
    const parsed = this.parseMessage(message);
    if (!parsed) {
      await this.publishDeadLetter(
        channel,
        trafficClass,
        undefined,
        "Malformed outbound queue message",
      );
      channel.ack(message);
      return;
    }

    const attempt = this.retryCount(message);
    const job: OutboundQueueJob = { messageId: parsed.messageId, attempt, trafficClass };

    try {
      const result = await handler(job);
      if (result.action === "ack") {
        channel.ack(message);
        return;
      }

      if (result.action === "dead") {
        await this.publishDeadLetter(channel, trafficClass, job.messageId, result.reason);
        channel.ack(message);
        return;
      }

      const retryScheduled = await this.scheduleRetry(channel, job, result.reason);
      if (!retryScheduled) {
        await onExhausted(job, result.reason);
        await this.publishDeadLetter(
          channel,
          trafficClass,
          job.messageId,
          result.reason ?? "Retry policy exhausted",
        );
      }
      channel.ack(message);
    } catch (error) {
      this.logger.error(
        `Unexpected ${trafficClass} queue processing error for message ${job.messageId}`,
        error instanceof Error ? error.stack : String(error),
      );
      channel.nack(message, false, true);
    }
  }

  private async scheduleRetry(
    channel: ConfirmChannel,
    job: OutboundQueueJob,
    reason?: string,
  ): Promise<boolean> {
    const delays = this.retryDelays();
    if (job.attempt >= delays.length) {
      return false;
    }

    const delay = delays[job.attempt];
    const retryQueue = this.trafficRetryQueueName(job.trafficClass, delay);
    channel.sendToQueue(
      retryQueue,
      Buffer.from(JSON.stringify({ messageId: job.messageId, trafficClass: job.trafficClass })),
      {
        persistent: true,
        contentType: "application/json",
        messageId: job.messageId,
        timestamp: Date.now(),
        headers: {
          "x-retry-count": job.attempt + 1,
          "x-traffic-class": job.trafficClass,
          ...(reason ? { "x-last-error": reason.slice(0, 512) } : {}),
        },
      },
    );
    await channel.waitForConfirms();

    this.logger.warn(
      `Scheduled ${job.trafficClass} message ${job.messageId} retry #${job.attempt + 1} in ${delay}ms`,
    );
    return true;
  }

  private async publishDeadLetter(
    channel: ConfirmChannel,
    trafficClass: MessageTrafficClass,
    messageId?: string,
    reason?: string,
  ): Promise<void> {
    channel.sendToQueue(
      this.trafficDeadQueueName(trafficClass),
      Buffer.from(
        JSON.stringify({
          messageId: messageId ?? null,
          trafficClass,
          reason: reason ?? "Unknown failure",
          failedAt: new Date().toISOString(),
        }),
      ),
      {
        persistent: true,
        contentType: "application/json",
        messageId,
        timestamp: Date.now(),
        headers: { "x-traffic-class": trafficClass },
      },
    );
    await channel.waitForConfirms();
  }

  private async assertTrafficTopology(
    channel: ConfirmChannel,
    trafficClass: MessageTrafficClass,
  ): Promise<void> {
    const queueName = this.trafficQueueName(trafficClass);
    const deadQueueName = this.trafficDeadQueueName(trafficClass);

    await channel.assertQueue(deadQueueName, { durable: true });
    await channel.assertQueue(queueName, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": deadQueueName,
      },
    });

    for (const delay of this.retryDelays()) {
      await channel.assertQueue(this.trafficRetryQueueName(trafficClass, delay), {
        durable: true,
        arguments: {
          "x-message-ttl": delay,
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": queueName,
        },
      });
    }
  }

  private async assertLegacyTopology(channel: ConfirmChannel): Promise<void> {
    const queueName = this.baseQueueName();
    const deadQueueName = `${queueName}.dead`;

    await channel.assertQueue(deadQueueName, { durable: true });
    await channel.assertQueue(queueName, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": deadQueueName,
      },
    });

    for (const delay of this.retryDelays()) {
      await channel.assertQueue(`${queueName}.retry.${delay}`, {
        durable: true,
        arguments: {
          "x-message-ttl": delay,
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": queueName,
        },
      });
    }
  }

  private async getPublisherChannel(): Promise<ConfirmChannel> {
    if (!this.publisherChannel) {
      this.publisherChannel = await (await this.getConnection()).createConfirmChannel();
    }
    return this.publisherChannel;
  }

  private async getConsumerChannel(key: string): Promise<ConfirmChannel> {
    const existing = this.consumerChannels.get(key);
    if (existing) {
      return existing;
    }
    const channel = await (await this.getConnection()).createConfirmChannel();
    this.consumerChannels.set(key, channel);
    return channel;
  }

  private async getConnection(): Promise<ChannelModel> {
    if (this.connection) {
      return this.connection;
    }

    const rabbitMqUrl = process.env.RABBITMQ_URL;
    if (!rabbitMqUrl) {
      throw new Error("RABBITMQ_URL is required");
    }

    this.connection = await amqp.connect(rabbitMqUrl);
    this.connection.on("close", () => {
      this.connection = undefined;
      this.publisherChannel = undefined;
      this.consumerChannels.clear();
    });
    return this.connection;
  }

  private parseMessage(message: ConsumeMessage): { messageId: string } | undefined {
    try {
      const value = JSON.parse(message.content.toString("utf8")) as { messageId?: unknown };
      return typeof value.messageId === "string" && value.messageId.length > 0
        ? { messageId: value.messageId }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private retryCount(message: ConsumeMessage): number {
    const value = message.properties.headers?.["x-retry-count"];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
  }

  private retryDelays(): number[] {
    const raw = process.env.OUTBOUND_RETRY_DELAYS_MS ?? "5000,30000,120000,600000";
    const values = raw
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);

    return values.length > 0 ? values : [5000, 30000, 120000, 600000];
  }

  private prefetchFor(trafficClass: MessageTrafficClass): number {
    const base = this.positiveInteger(process.env.OUTBOUND_WORKER_PREFETCH, 20);
    switch (trafficClass) {
      case MessageTrafficClass.OTP:
        return this.positiveInteger(
          process.env.OUTBOUND_WORKER_PREFETCH_OTP,
          Math.max(5, Math.ceil(base / 2)),
        );
      case MessageTrafficClass.TRANSACTIONAL:
        return this.positiveInteger(process.env.OUTBOUND_WORKER_PREFETCH_TRANSACTIONAL, base);
      case MessageTrafficClass.MARKETING:
        return this.positiveInteger(
          process.env.OUTBOUND_WORKER_PREFETCH_MARKETING,
          Math.max(1, Math.ceil(base / 4)),
        );
    }
  }

  private positiveInteger(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private baseQueueName(): string {
    return process.env.OUTBOUND_QUEUE_NAME ?? "whatsapp.outbound";
  }

  private trafficQueueName(trafficClass: MessageTrafficClass): string {
    return `${this.baseQueueName()}.${trafficClass.toLowerCase()}`;
  }

  private trafficDeadQueueName(trafficClass: MessageTrafficClass): string {
    return `${this.trafficQueueName(trafficClass)}.dead`;
  }

  private trafficRetryQueueName(trafficClass: MessageTrafficClass, delayMs: number): string {
    return `${this.trafficQueueName(trafficClass)}.retry.${delayMs}`;
  }
}
