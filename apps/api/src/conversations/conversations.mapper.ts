import {
  type Conversation,
  type Message,
  REPLY_EXCERPT_LENGTH,
  type SystemLine,
  systemLineSchema,
} from '@beso/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { storedImageSelect, toStoredImage } from '../uploads/uploads.mapper.js';
import { toUserSummary, userSummarySelect } from '../users/users.mapper.js';

export const messageSelect = {
  id: true,
  conversationId: true,
  senderId: true,
  kind: true,
  content: true,
  imageKey: true,
  image: { select: storedImageSelect },
  sharedPostId: true,
  sharesPost: true,
  isReply: true,
  // The original as it is now: a reply read after an edit or a deletion quotes that.
  replyTo: {
    select: {
      id: true,
      senderId: true,
      content: true,
      imageKey: true,
      sharesPost: true,
      deletedAt: true,
    },
  },
  editedAt: true,
  deletedAt: true,
  systemMeta: true,
  reactions: { select: { userId: true, type: true }, orderBy: { createdAt: 'asc' } },
  createdAt: true,
} satisfies Prisma.MessageSelect;

export type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

function quoted(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > REPLY_EXCERPT_LENGTH ? `${flat.slice(0, REPLY_EXCERPT_LENGTH - 1)}…` : flat;
}

function replyOf(row: MessageRow): Message['replyTo'] {
  const original = row.replyTo;
  if (!original) return row.isReply ? { unavailable: true } : null;
  return {
    id: original.id,
    senderId: original.senderId,
    excerpt: quoted(original.content),
    attachment: original.imageKey ? 'picture' : original.sharesPost ? 'post' : null,
    deleted: original.deletedAt !== null,
  };
}

/** A system line whose stored subject no longer parses is shown as nothing rather than crashing a thread. */
function systemLineOf(row: MessageRow): SystemLine | null {
  if (row.kind !== 'system') return null;
  const parsed = systemLineSchema.safeParse(row.systemMeta);
  return parsed.success ? parsed.data : null;
}

export function toMessage(row: MessageRow, assetsBase: string): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    kind: row.kind,
    content: row.content,
    image: row.image ? toStoredImage(row.image, assetsBase) : null,
    imageUrl: row.image ? `${assetsBase}/${row.image.key}` : null,
    sharedPost: row.sharedPostId
      ? { id: row.sharedPostId }
      : row.sharesPost
        ? { unavailable: true }
        : null,
    replyTo: replyOf(row),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    system: systemLineOf(row),
    reactions: row.reactions.map((reaction) => ({ userId: reaction.userId, type: reaction.type })),
    createdAt: row.createdAt.toISOString(),
  };
}

/** A conversation with its members and newest message; the unread count is added per viewer. */
export const conversationSelect = {
  id: true,
  kind: true,
  title: true,
  pictureKey: true,
  createdById: true,
  createdAt: true,
  lastMessageAt: true,
  members: {
    select: { role: true, joinedAt: true, lastReadAt: true, user: { select: userSummarySelect } },
    orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
  },
  messages: {
    select: messageSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
  },
} satisfies Prisma.ConversationSelect;

export type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof conversationSelect }>;

export const memberIdsOf = (row: ConversationRow): string[] =>
  row.members.map((member) => member.user.id);

export const isAdminOf = (row: ConversationRow, userId: string): boolean =>
  row.members.some((member) => member.user.id === userId && member.role === 'admin');

export function toConversation(
  row: ConversationRow,
  unreadCount: number,
  assetsBase: string,
): Conversation {
  const latest = row.messages[0];
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    pictureUrl: row.pictureKey ? `${assetsBase}/${row.pictureKey}` : null,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    members: row.members.map((member) => ({
      user: toUserSummary(member.user, assetsBase),
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
      lastReadAt: member.lastReadAt ? member.lastReadAt.toISOString() : null,
    })),
    lastMessage: latest ? toMessage(latest, assetsBase) : null,
    unreadCount,
  };
}

/** The unique key of the direct conversation between two people, whichever order they come in. */
export const directKeyOf = (a: string, b: string): string => [a, b].toSorted().join(':');
