export enum ClientWebhookEventType {
  MESSAGE_RECEIVED = "message.received",
  MESSAGE_SENT = "message.sent",
  MESSAGE_DELIVERED = "message.delivered",
  MESSAGE_READ = "message.read",
  MESSAGE_FAILED = "message.failed",
}

export const CLIENT_WEBHOOK_EVENT_TYPES: ClientWebhookEventType[] = Object.values(ClientWebhookEventType);

export interface ClientWebhookEnvelope {
  id: string;
  type: ClientWebhookEventType;
  createdAt: string;
  data: Record<string, unknown>;
}
