import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from "amqplib";

export interface OutboundQueueJob {
  messageId: string;
  attempt: number;
}

export interface QueueProcessingResult {
  action: "ack" | "retry" | "dead";
  reason?: string;
}

type OutboundHandler = (job: OutboundQueueJob) => Promise<QueueProcessingResult>;
type ExhaustedHandler = (job: OutboundQueueJob, reason?: string) => Promise<void>;

@Injectable()
export class MessagingQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(MessagingQueueService.name);
  private connection?: ChannelModel;
  private publisherChannel?: ConfirmChannel;
  private consumerChannel?: ConfirmChannel;

  async publishOutboundMessage(messageId: string): Promise<void> {
    const channel = await this.getPublisherChannel();
    await this.assertTopology(channel);

    const queueName = this.queueName();
    channel.sendToQueue(queueName, Buffer.from(JSON.stringify({ messageId })), {
      persistent: true,
      contentType: "application/json",
      messageId,
      timestamp: Date.now(),
      headers: { "x-retry-count": 0 },
    });

    await channel.waitForConfirms();
  }

  async consumeOutboundMessages(handler: OutboundHandler, onExhausted: ExhaustedHandler): Promise<void> {
    const channel = await this.getConsumerChannel();
    await this.assertTopology(channel);

    const prefetch = Math.max(1, Number(process.env.OUTBOUND_WORKER_PREFETCH ?? 20));
    await channel.prefetch(prefetch);

    await channel.consume(this.queueName(), (message) => {
      if (!message) {
        return;
      }
      void this.processDelivery(channel, message, handler, onExhausted);
    });

    this.logger.log(`Consuming outbound messages with prefetch=${prefetch}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumerChannel?.close().catch(() => undefined);
    await this.publisherChannel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private async processDelivery(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    handler: OutboundHandler,
    onExhausted: ExhaustedHandler,
  ): Promise<void> {
    const parsed = this.parseMessage(message);
    if (!parsed) {
      await this.publishDeadLetter(channel, undefined, "Malformed outbound queue message");
      channel.ack(message);
      return;
    }

    const attempt = this.retryCount(message);
    const job: OutboundQueueJob = { messageId: parsed.messageId, attempt };

    try {
      const result = await handler(job);
      if (result.action === "ack") {
        channel.ack(message);
        return;
      }

      if (result.action === "dead") {
        await this.publishDeadLetter(channel, job.messageId, result.reason);
        channel.ack(message);
        return;
      }

      const retryScheduled = await this.scheduleRetry(channel, job, result.reason);
      if (!retryScheduled) {
        await onExhausted(job, result.reason);
        await this.publishDeadLetter(channel, job.messageId, result.reason ?? "Retry policy exhausted");
      }
      channel.ack(message);
    } catch (error) {
      this.logger.error(
        `Unexpected queue processing error for message ${job.messageId}`,
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
    const retryQueue = this.retryQueueName(delay);
    channel.sendToQueue(retryQueue, Buffer.from(JSON.stringify({ messageId: job.messageId })), {
      persistent: true,
      contentType: "application/json",
      messageId: job.messageId,
      timestamp: Date.now(),
      headers: {
        "x-retry-count": job.attempt + 1,
        ...(reason ? { "x-last-error": reason.slice(0, 512) } : {}),
      },
    });
    await channel.waitForConfirms();

    this.logger.warn(`Scheduled message ${job.messageId} retry #${job.attempt + 1} in ${delay}ms`);
    return true;
  }

  private async publishDeadLetter(
    channel: ConfirmChannel,
    messageId?: string,
    reason?: string,
  ): Promise<void> {
    channel.sendToQueue(
      this.deadQueueName(),
      Buffer.from(
        JSON.stringify({
          messageId: messageId ?? null,
          reason: reason ?? "Unknown failure",
          failedAt: new Date().toISOString(),
        }),
      ),
      {
        persistent: true,
        contentType: "application/json",
        messageId,
        timestamp: Date.now(),
      },
    );
    await channel.waitForConfirms();
  }

  private async assertTopology(channel: ConfirmChannel): Promise<void> {
    const queueName = this.queueName();
    const deadQueueName = this.deadQueueName();

    await channel.assertQueue(deadQueueName, { durable: true });
    await channel.assertQueue(queueName, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": deadQueueName,
      },
    });

    for (const delay of this.retryDelays()) {
      await channel.assertQueue(this.retryQueueName(delay), {
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

  private async getConsumerChannel(): Promise<ConfirmChannel> {
    if (!this.consumerChannel) {
      this.consumerChannel = await (await this.getConnection()).createConfirmChannel();
    }
    return this.consumerChannel;
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
      this.consumerChannel = undefined;
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

  private queueName(): string {
    return process.env.OUTBOUND_QUEUE_NAME ?? "whatsapp.outbound";
  }

  private deadQueueName(): string {
    return `${this.queueName()}.dead`;
  }

  private retryQueueName(delayMs: number): string {
    return `${this.queueName()}.retry.${delayMs}`;
  }
}
