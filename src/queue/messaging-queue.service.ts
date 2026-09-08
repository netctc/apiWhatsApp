import { Injectable, OnModuleDestroy } from "@nestjs/common";
import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";

@Injectable()
export class MessagingQueueService implements OnModuleDestroy {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;

  async publishOutboundMessage(messageId: string): Promise<void> {
    const channel = await this.getChannel();
    const queueName = process.env.OUTBOUND_QUEUE_NAME ?? "whatsapp.outbound";

    await channel.assertQueue(queueName, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": `${queueName}.dead`,
      },
    });

    await channel.assertQueue(`${queueName}.dead`, { durable: true });

    channel.sendToQueue(
      queueName,
      Buffer.from(JSON.stringify({ messageId })),
      {
        persistent: true,
        contentType: "application/json",
        messageId,
        timestamp: Date.now(),
      },
    );

    await channel.waitForConfirms();
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  private async getChannel(): Promise<ConfirmChannel> {
    if (this.channel) {
      return this.channel;
    }

    const rabbitMqUrl = process.env.RABBITMQ_URL;
    if (!rabbitMqUrl) {
      throw new Error("RABBITMQ_URL is required");
    }

    this.connection = await amqp.connect(rabbitMqUrl);
    this.channel = await this.connection.createConfirmChannel();
    return this.channel;
  }
}
