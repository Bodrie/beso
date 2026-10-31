import { z } from 'zod';
import { reactionTypeSchema, setReactionSchema } from './comments.js';
import { apiErrorSchema } from './errors.js';
import { uuidSchema } from './common.js';
import type { Activity } from './activities.js';
import type { Notification } from './notifications.js';
import { cursorQuerySchema, paginatedSchema } from './pagination.js';
import { groupPictureKeySchema, messageImageKeySchema, storedImageSchema } from './uploads.js';
import { userSummarySchema } from './users.js';

export const MESSAGE_MAX_LENGTH = 2000;
export const GROUP_TITLE_MAX_LENGTH = 60;
/** Members per group, the creator included. */
export const GROUP_MAX_MEMBERS = 50;

export const CONVERSATION_KINDS = ['direct', 'group'] as const;
export const conversationKindSchema = z.enum(CONVERSATION_KINDS);
export type ConversationKind = z.infer<typeof conversationKindSchema>;

/** Group admins rename, remove people and hand the role on; every member adds people and leaves. */
export const CONVERSATION_ROLES = ['admin', 'member'] as const;
export const conversationRoleSchema = z.enum(CONVERSATION_ROLES);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

export const MESSAGE_KINDS = ['user', 'system'] as const;
export const messageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof messageKindSchema>;

/**
 * What a system line is about: who joined, who left or was removed, the new name, who became
 * or stopped being an admin, that the group was created (ADR 0009 amendment 3), that the
 * group's picture changed or was removed (amendment "group pictures").
 */
export const SYSTEM_LINE_TYPES = [
  'members_added',
  'member_left',
  'member_removed',
  'renamed',
  'group_created',
  'admin_added',
  'admin_removed',
  'picture_changed',
  'picture_removed',
] as const;
const personRefSchema = z.object({ id: z.uuid(), name: z.string() });
export const systemLineSchema = z.object({
  type: z.enum(SYSTEM_LINE_TYPES),
  /** Who did it, named as at the time (a client prefers the current name of someone still in). */
  actor: personRefSchema,
  /** The people concerned (added or removed); empty for a rename. */
  users: z.array(personRefSchema),
  /** The new title of a rename, null otherwise. */
  title: z.string().nullable(),
});
export type SystemLine = z.infer<typeof systemLineSchema>;

/**
 * One member's reaction. Messages carry the plain list, not a per-viewer summary: a push is the
 * same for every member, and each client works out counts and its own reaction from it.
 */
export const messageReactionSchema = z.object({ userId: z.uuid(), type: reactionTypeSchema });
export type MessageReaction = z.infer<typeof messageReactionSchema>;

/**
 * A post sent to the chat (ADR 0009 amendment 4): a reference only, because one push serves every
 * member and who may see the post differs between them. Each client loads it through
 * `GET /posts/:id`, which applies the viewer's blocks; `{ unavailable: true }` once it was deleted.
 */
export const sharedPostRefSchema = z.union([
  z.object({ unavailable: z.literal(true) }),
  z.object({ id: z.uuid() }),
]);
export type SharedPostRef = z.infer<typeof sharedPostRefSchema>;

/** How long the quoted start of a replied-to message is. */
export const REPLY_EXCERPT_LENGTH = 140;

/**
 * The message a reply answers, as a quote above the reply: who wrote it and how it began, as
 * of the read. A client that has the original loaded shows the original as it is now (edited,
 * deleted). `{ unavailable: true }` once the original left with its sender's account.
 */
export const replyRefSchema = z.union([
  z.object({ unavailable: z.literal(true) }),
  z.object({
    id: z.uuid(),
    senderId: z.uuid(),
    excerpt: z.string(),
    /** What it carried besides its text. */
    attachment: z.enum(['picture', 'post']).nullable(),
    deleted: z.boolean(),
  }),
]);
export type ReplyRef = z.infer<typeof replyRefSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  senderId: z.uuid(),
  /** `system` lines are written by the server about membership changes and renames. */
  kind: messageKindSchema,
  /** Empty when the message is a picture or a post only, a system line or deleted. */
  content: z.string(),
  image: storedImageSchema.nullable(),
  /** A post sent along; null on most messages, and once the message is deleted. */
  sharedPost: sharedPostRefSchema.nullable(),
  /** The message this one answers; null when it answers none, and once it is deleted. */
  replyTo: replyRefSchema.nullable(),
  /** @deprecated `image.url`, kept for tabs opened before D2 (they parse the old shape). */
  imageUrl: z.url().nullable(),
  /** Null until the sender edited the text; the previous texts are its revisions. */
  editedAt: z.iso.datetime().nullable(),
  /** Set once the sender deleted it: the row stays (ordering, read marks), its content is gone. */
  deletedAt: z.iso.datetime().nullable(),
  /** The subject of a system line; null on a user's message. */
  system: systemLineSchema.nullable(),
  /** Empty on system lines and deleted messages. */
  reactions: z.array(messageReactionSchema),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof messageSchema>;

export const messageListSchema = paginatedSchema(messageSchema);
export type MessageList = z.infer<typeof messageListSchema>;

/** Text, a picture, a post or any of them together; never none. */
export const sendMessageSchema = z
  .object({
    content: z
      .string()
      .trim()
      .max(MESSAGE_MAX_LENGTH, `At most ${MESSAGE_MAX_LENGTH} characters`)
      .default(''),
    imageKey: messageImageKeySchema.optional(),
    /** A post to send to the chat ("Send" on a post); the sender must be able to see it. */
    postId: uuidSchema.optional(),
    /** The message this one answers, in the same conversation, not deleted, not a system line. */
    replyToId: uuidSchema.optional(),
  })
  .refine(
    (value) =>
      value.content.length > 0 || value.imageKey !== undefined || value.postId !== undefined,
    { message: 'Write something or attach a picture', path: ['content'] },
  );
export type SendMessageInput = z.input<typeof sendMessageSchema>;
export type SendMessageData = z.output<typeof sendMessageSchema>;

/** The sender changes the text (the picture stays); an unchanged text is a no-op. */
export const editMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'Write something first')
    .max(MESSAGE_MAX_LENGTH, `At most ${MESSAGE_MAX_LENGTH} characters`),
});
export type EditMessageInput = z.input<typeof editMessageSchema>;
export type EditMessageData = z.output<typeof editMessageSchema>;

/** One reaction per member and message; `PUT` sets or switches it, `DELETE` removes it. */
export const messageReactionInputSchema = setReactionSchema;

export const messagesQuerySchema = cursorQuerySchema;
/** The list is keyset-paginated by activity (`lastMessageAt`, else `createdAt`), newest first. */
export const conversationsQuerySchema = cursorQuerySchema;

/** Read state lives on the membership: everything up to `lastReadAt` has been seen. */
export const conversationMemberSchema = z.object({
  user: userSummarySchema,
  role: conversationRoleSchema,
  joinedAt: z.iso.datetime(),
  lastReadAt: z.iso.datetime().nullable(),
});
export type ConversationMember = z.infer<typeof conversationMemberSchema>;

/**
 * A direct conversation is the one thread between two people (no title); a group has a
 * title, maybe a picture, and any number of members. `members` always includes the viewer.
 */
export const conversationSchema = z.object({
  id: z.uuid(),
  kind: conversationKindSchema,
  title: z.string().nullable(),
  /** A group's picture, set by its admins (an upload of kind `group`); null for a direct thread. */
  pictureUrl: z.string().nullable(),
  createdById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime().nullable(),
  members: z.array(conversationMemberSchema),
  lastMessage: messageSchema.nullable(),
  unreadCount: z.int().nonnegative(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const conversationListSchema = paginatedSchema(conversationSchema);
export type ConversationList = z.infer<typeof conversationListSchema>;

const memberIdsSchema = z
  .array(uuidSchema)
  .min(1, 'Pick at least one person')
  .max(GROUP_MAX_MEMBERS - 1, `At most ${GROUP_MAX_MEMBERS} members`);

const groupTitleSchema = z
  .string()
  .trim()
  .min(1, 'Give the group a name')
  .max(GROUP_TITLE_MAX_LENGTH, `At most ${GROUP_TITLE_MAX_LENGTH} characters`);

export const createGroupSchema = z.object({
  title: groupTitleSchema,
  /** The other members; the creator is added by the server (as its admin). */
  memberIds: memberIdsSchema,
});
export type CreateGroupInput = z.input<typeof createGroupSchema>;

export const addMembersSchema = z.object({ userIds: memberIdsSchema });
export type AddMembersInput = z.input<typeof addMembersSchema>;

/** Admins only. */
export const renameGroupSchema = z.object({ title: groupTitleSchema });
export type RenameGroupInput = z.input<typeof renameGroupSchema>;

/** Admins only: the group's picture, an upload made with `?kind=group`. */
export const setGroupPictureSchema = z.object({ pictureKey: groupPictureKeySchema });
export type SetGroupPictureInput = z.infer<typeof setGroupPictureSchema>;

/** Admins only; demoting the last admin is refused. */
export const setMemberRoleSchema = z.object({ role: conversationRoleSchema });
export type SetMemberRoleInput = z.infer<typeof setMemberRoleSchema>;

export const markReadResultSchema = z.object({ readAt: z.iso.datetime() });
export type MarkReadResult = z.infer<typeof markReadResultSchema>;

// --- socket.io contract ---------------------------------------------------

export const SOCKET_EVENTS = {
  /** server → client: the full list of online users (deduplicated per user). */
  presenceUpdate: 'presence:update',
  /** client → server with ack: SendMessagePayload → MessageAck. */
  messageSend: 'message:send',
  /** server → client (every member): a persisted Message (a system line included). */
  messageNew: 'message:new',
  /** server → client (every member): the Message as it is now, `deletedAt` set and content gone. */
  messageDeleted: 'message:deleted',
  /** server → client (every member): the Message as it is now after an edit or a reaction. */
  messageUpdated: 'message:updated',
  /** client → server with ack: MarkReadPayload → MarkReadAck. */
  messageRead: 'message:read',
  /** server → client (the other members): ConversationReadPayload – `userId` caught up. */
  conversationRead: 'conversation:read',
  /** server → client (every member): the conversation was created or its members changed; fetch it. */
  conversationUpdate: 'conversation:update',
  /** server → client (the member who left): forget this conversation. */
  conversationRemoved: 'conversation:removed',
  /** client → server, no ack: the sender started or stopped typing in `conversationId`. */
  typing: 'typing',
  /** server → client (the other members): TypingUpdate. */
  typingUpdate: 'typing:update',
  /** server → client (the recipient): a Notification that was just written (ADR 0015). */
  notificationNew: 'notification:new',
  /**
   * server → client (the actor's followers who may see it): an Activity that was just recorded
   * (C7). Undone likes and follows push nothing; they are gone at the next fetch.
   */
  activityNew: 'activity:new',
  /** server → client: an ApiError raised by a handler outside the ack flow. */
  exception: 'exception',
} as const;

export const presenceUpdateSchema = z.array(userSummarySchema);
export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;

export const sendMessagePayloadSchema = sendMessageSchema.extend({ conversationId: uuidSchema });
export type SendMessagePayload = z.input<typeof sendMessagePayloadSchema>;

export const markReadPayloadSchema = z.object({ conversationId: uuidSchema });
export type MarkReadPayload = z.infer<typeof markReadPayloadSchema>;

export const messageAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), message: messageSchema }),
  z.object({ ok: z.literal(false), error: apiErrorSchema }),
]);
export type MessageAck = z.infer<typeof messageAckSchema>;

export const markReadAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), readAt: z.iso.datetime() }),
  z.object({ ok: z.literal(false), error: apiErrorSchema }),
]);
export type MarkReadAck = z.infer<typeof markReadAckSchema>;

export const typingPayloadSchema = z.object({ conversationId: uuidSchema, typing: z.boolean() });
export type TypingPayload = z.infer<typeof typingPayloadSchema>;

/** Ephemeral: never stored, so a client treats a stale `typing: true` as over after a few seconds. */
export const typingUpdateSchema = z.object({
  conversationId: z.uuid(),
  userId: z.uuid(),
  typing: z.boolean(),
});
export type TypingUpdate = z.infer<typeof typingUpdateSchema>;

export const conversationReadPayloadSchema = z.object({
  conversationId: z.uuid(),
  userId: z.uuid(),
  readAt: z.iso.datetime(),
});
export type ConversationReadPayload = z.infer<typeof conversationReadPayloadSchema>;

export const conversationRefSchema = z.object({ conversationId: z.uuid() });
export type ConversationRef = z.infer<typeof conversationRefSchema>;

/** Typed event maps for socket.io on both ends. */
export type ServerToClientEvents = {
  [SOCKET_EVENTS.presenceUpdate]: (users: PresenceUpdate) => void;
  [SOCKET_EVENTS.messageNew]: (message: Message) => void;
  [SOCKET_EVENTS.messageDeleted]: (message: Message) => void;
  [SOCKET_EVENTS.messageUpdated]: (message: Message) => void;
  [SOCKET_EVENTS.conversationRead]: (payload: ConversationReadPayload) => void;
  [SOCKET_EVENTS.conversationUpdate]: (payload: ConversationRef) => void;
  [SOCKET_EVENTS.conversationRemoved]: (payload: ConversationRef) => void;
  [SOCKET_EVENTS.typingUpdate]: (payload: TypingUpdate) => void;
  [SOCKET_EVENTS.notificationNew]: (notification: Notification) => void;
  [SOCKET_EVENTS.activityNew]: (activity: Activity) => void;
  [SOCKET_EVENTS.exception]: (error: z.infer<typeof apiErrorSchema>) => void;
};

export type ClientToServerEvents = {
  [SOCKET_EVENTS.messageSend]: (
    payload: SendMessagePayload,
    ack: (result: MessageAck) => void,
  ) => void;
  [SOCKET_EVENTS.messageRead]: (
    payload: MarkReadPayload,
    ack: (result: MarkReadAck) => void,
  ) => void;
  [SOCKET_EVENTS.typing]: (payload: TypingPayload) => void;
};
