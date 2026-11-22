// Contracts shared by the API and the web app. Every change in a conversation becomes one of these
// events, numbered by `seq`. Clients apply events strictly in seq order and ask for any gap.

export type MessageDto = {
  id: string;
  conversationId: string;
  seq: number;
  authorId: string | null;
  body: string;
  parentId: string | null;
  alsoInChannel: boolean;
  replyCount: number;
  lastReplyAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  /** Lets the sender match the server's copy to the message it showed as "sending". */
  clientMsgId: string | null;
  /** Present in history and thread responses; live updates arrive as reaction events. */
  reactions?: ReactionSummary[];
};

export type ReactionSummary = { emoji: string; count: number; userIds: string[] };

type Base<T extends string, D> = { type: T; conversationId: string; seq: number; at: string; data: D };

export type ConversationEvent =
  | Base<'message.created', { message: MessageDto }>
  | Base<'message.edited', { messageId: string; body: string; editedAt: string }>
  | Base<'message.deleted', { messageId: string; parentId: string | null; deletedAt: string }>
  | Base<'reaction.added', { messageId: string; userId: string; emoji: string }>
  | Base<'reaction.removed', { messageId: string; userId: string; emoji: string }>
  | Base<'member.joined', { userId: string; addedBy: string }>
  | Base<'member.left', { userId: string; removedBy: string }>
  | Base<'conversation.updated', { name?: string; topic?: string | null; archived?: boolean }>;

export type ConversationEventType = ConversationEvent['type'];
