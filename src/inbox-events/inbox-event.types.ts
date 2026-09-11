export const INBOX_EVENT_TYPES = [
  "conversation.created",
  "conversation.updated",
  "conversation.message.created",
  "conversation.note.created",
  "canned_response.created",
  "canned_response.updated",
] as const;

export type InboxEventType = (typeof INBOX_EVENT_TYPES)[number];

export type InboxEventData = Readonly<{
  conversationId?: string;
  messageId?: string;
  noteId?: string;
  cannedResponseId?: string;
  status?: string;
  priority?: string;
  assignedAgentId?: string | null;
  assignedTeamId?: string | null;
  unreadCount?: number;
  revision?: number;
  active?: boolean;
}>;

export type InboxRealtimeEvent = Readonly<{
  id: string;
  type: InboxEventType;
  occurredAt: string;
  data: InboxEventData;
}>;

export type InboxRealtimeEnvelope = Readonly<{
  tenantId: string;
  event: InboxRealtimeEvent;
}>;
