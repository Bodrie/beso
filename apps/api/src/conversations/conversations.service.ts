import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  type AddMembersInput,
  type Conversation,
  type ConversationRole,
  type CreateGroupInput,
  type CursorQuery,
  type EditMessageData,
  GROUP_MAX_MEMBERS,
  type MarkReadResult,
  type Message,
  type Paginated,
  type ReactionType,
  type RenameGroupInput,
  type Revision,
  type SendMessageData,
  type SetGroupPictureInput,
  type SystemLine,
} from '@beso/shared';
import { AssetsService } from '../assets/assets.service.js';
import { badRequest, forbidden, notFound } from '../common/errors.js';
import {
  decodeCursor,
  encodeCursor,
  keysetAfter,
  paginate,
  paginateBy,
  paginateWith,
} from '../common/pagination.js';
import { revisionKey, revisionsAfter, toRevision } from '../common/revisions.js';
import {
  ConversationLeftEvent,
  ConversationReadEvent,
  ConversationUpdatedEvent,
  GroupCreatedEvent,
  MessageDeletedEvent,
  MessageSentEvent,
  MessageUpdatedEvent,
} from '../events/conversation.events.js';
import { Prisma } from '../generated/prisma/client.js';
import { VisibilityService } from '../moderation/visibility.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { UsersService } from '../users/users.service.js';
import {
  type ConversationRow,
  type MessageRow,
  conversationSelect,
  directKeyOf,
  isAdminOf,
  memberIdsOf,
  messageSelect,
  toConversation,
  toMessage,
} from './conversations.mapper.js';
import { promoteIfNoAdminSql } from './roles.js';

type UnreadRow = { conversation_id: string; unread: number };
type ActivityRow = { id: string; activity_at: Date };
type PersonRef = { id: string; name: string };
type Tx = Prisma.TransactionClient;

/**
 * Direct conversations exist once per pair and appear in the list only once something was
 * said; groups are created on purpose and show up right away. Every read goes through a
 * membership check, and non-members get a 404 so the existence of a group never leaks.
 * Group admins (the creator at first) rename, set the picture, remove people and hand the
 * role on; the server writes a system line into the thread for every membership change,
 * rename and picture change.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly events: EventEmitter2,
    private readonly assets: AssetsService,
    private readonly uploads: UploadsService,
    private readonly visibility: VisibilityService,
  ) {}

  /** The one direct conversation between the caller and `userId`, created on first use. */
  async ensureDirect(meId: string, userId: string): Promise<Conversation> {
    if (meId === userId) throw badRequest('You cannot message yourself');
    await this.users.assertExists(userId);
    await this.visibility.assertNotBlocked(meId, userId);
    const directKey = directKeyOf(meId, userId);
    const existing = await this.prisma.conversation.findUnique({
      where: { directKey },
      select: conversationSelect,
    });
    if (existing) return this.withUnreadOne(existing, meId);
    try {
      const created = await this.prisma.conversation.create({
        data: { kind: 'direct', directKey, members: { create: [{ userId: meId }, { userId }] } },
        select: conversationSelect,
      });
      return toConversation(created, 0, this.assets.base);
    } catch (error) {
      // Two tabs opened the same thread at once: the other one won, use its row.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const row = await this.prisma.conversation.findUniqueOrThrow({
          where: { directKey },
          select: conversationSelect,
        });
        return this.withUnreadOne(row, meId);
      }
      throw error;
    }
  }

  /** The creator is the first admin; the thread opens on a line saying who created the group. */
  async createGroup(meId: string, input: CreateGroupInput): Promise<Conversation> {
    const members = await this.resolveMembers(meId, input.memberIds, 'memberIds');
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: {
          kind: 'group',
          title: input.title,
          createdById: meId,
          members: {
            create: [
              { userId: meId, role: 'admin' },
              ...members.map((member) => ({ userId: member.id })),
            ],
          },
        },
        select: conversationSelect,
      });
      await this.writeSystemLine(tx, created.id, meId, {
        type: 'group_created',
        actor: this.personOf(created, meId),
        users: [],
        title: input.title,
      });
      return tx.conversation.findUniqueOrThrow({
        where: { id: created.id },
        select: conversationSelect,
      });
    });
    await this.events.emitAsync(
      ConversationUpdatedEvent.EVENT,
      new ConversationUpdatedEvent(row.id, memberIdsOf(row)),
    );
    await this.events.emitAsync(GroupCreatedEvent.EVENT, new GroupCreatedEvent(row.id, meId));
    return toConversation(row, 0, this.assets.base);
  }

  /**
   * Most recent activity first: the newest message, or the creation for a group that has none
   * yet. Keyset on that stamp and the id (the stamp is a `COALESCE`, so the page's ids come
   * from SQL and are hydrated afterwards). Direct threads need a message to show.
   */
  async list(meId: string, query: CursorQuery): Promise<Paginated<Conversation>> {
    const cursor = decodeCursor(query.cursor);
    const blocked = await this.visibility.blockedIds(meId);
    const page = await this.prisma.$queryRaw<ActivityRow[]>(Prisma.sql`
      SELECT c.id, COALESCE(c.last_message_at, c.created_at) AS activity_at
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ${meId}::uuid
      WHERE (c.kind = 'group' OR c.last_message_at IS NOT NULL)
        AND NOT (c.kind = 'direct' AND EXISTS (
          SELECT 1 FROM conversation_members o
          WHERE o.conversation_id = c.id AND o.user_id = ANY(${blocked}::uuid[])))
        ${
          cursor
            ? Prisma.sql`AND (COALESCE(c.last_message_at, c.created_at), c.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : Prisma.empty
        }
      ORDER BY activity_at DESC, c.id DESC
      LIMIT ${query.limit + 1}
    `);
    const rows = await this.prisma.conversation.findMany({
      where: { id: { in: page.map((row) => row.id) } },
      select: conversationSelect,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = page.flatMap((entry) => {
      const row = byId.get(entry.id);
      return row ? [{ ...entry, row }] : [];
    });
    const conversations = await this.withUnread(
      ordered.map((entry) => entry.row),
      meId,
    );
    const unreadById = new Map(
      conversations.map((conversation) => [conversation.id, conversation]),
    );
    return paginateWith(
      ordered,
      query.limit,
      (entry) => encodeCursor({ createdAt: entry.activity_at, id: entry.id }),
      (entry) => unreadById.get(entry.id) ?? toConversation(entry.row, 0, this.assets.base),
    );
  }

  async get(meId: string, id: string): Promise<Conversation> {
    return this.withUnreadOne(await this.rowForMember(meId, id), meId);
  }

  /** Messages in the conversation, newest first (deleted ones and system lines included). */
  async history(meId: string, id: string, query: CursorQuery): Promise<Paginated<Message>> {
    await this.rowForMember(meId, id);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.message.findMany({
      where: {
        AND: [
          { conversationId: id },
          cursor ? keysetAfter(cursor, (messageId) => ({ id: { lt: messageId } })) : {},
        ],
      },
      select: messageSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return paginate(rows, query.limit, this.toMessage);
  }

  async send(meId: string, id: string, input: SendMessageData): Promise<Message> {
    const row = await this.rowForMember(meId, id);
    if (input.imageKey !== undefined) {
      await this.uploads.assertOwned(input.imageKey, {
        ownerId: meId,
        kind: 'message',
        field: 'imageKey',
      });
    }
    if (input.voiceKey !== undefined) {
      await this.uploads.assertOwned(input.voiceKey, {
        ownerId: meId,
        kind: 'voice',
        field: 'voiceKey',
      });
    }
    if (input.postId !== undefined) await this.assertShareable(meId, input.postId);
    if (input.replyToId !== undefined) await this.assertAnswerable(id, input.replyToId);
    const created = await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: id,
          senderId: meId,
          content: input.content,
          imageKey: input.imageKey ?? null,
          voiceKey: input.voiceKey ?? null,
          voicePeaks: input.voiceKey === undefined ? [] : (input.voicePeaks ?? []),
          sharedPostId: input.postId ?? null,
          sharesPost: input.postId !== undefined,
          replyToId: input.replyToId ?? null,
          isReply: input.replyToId !== undefined,
        },
        select: messageSelect,
      });
      await this.bumpActivity(tx, id, message.createdAt);
      // Writing counts as having read everything before it.
      await tx.conversationMember.update({
        where: { conversationId_userId: { conversationId: id, userId: meId } },
        data: { lastReadAt: message.createdAt },
      });
      return message;
    });
    const message = this.toMessage(created);
    await this.events.emitAsync(
      MessageSentEvent.EVENT,
      new MessageSentEvent(message, memberIdsOf(row)),
    );
    return message;
  }

  /**
   * A post goes to a chat on the rules of a quote (ADR 0017): it must exist, and nobody sends
   * what a block between them and its author keeps from them. The members each load it through
   * `GET /posts/:id`, so their own blocks apply when they look (ADR 0009 amendment 4).
   */
  private async assertShareable(meId: string, postId: string): Promise<void> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true },
    });
    if (!post) throw badRequest('Unknown post', { postId: 'Unknown post' });
    await this.visibility.assertNotBlocked(meId, post.authorId);
  }

  /** A reply answers a member's message of this conversation that is still there. */
  private async assertAnswerable(conversationId: string, messageId: string): Promise<void> {
    const original = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { kind: true, deletedAt: true },
    });
    const problem =
      !original || original.kind === 'system'
        ? 'Not a message of this conversation'
        : original.deletedAt
          ? 'That message was deleted'
          : null;
    if (problem) throw badRequest(problem, { replyToId: problem });
  }

  /**
   * The sender takes a message back, however old: the row stays (ordering, read marks), its
   * text, picture, voice and post go, and everyone sees "Message deleted". Idempotent.
   */
  async deleteMessage(meId: string, id: string, messageId: string): Promise<Message> {
    const row = await this.rowForMember(meId, id);
    const existing = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId: id },
      select: messageSelect,
    });
    if (!existing) throw notFound('Message not found');
    if (existing.kind === 'system') throw badRequest('System lines cannot be deleted');
    if (existing.senderId !== meId) throw forbidden('Only the sender can delete a message');
    if (existing.deletedAt) return this.toMessage(existing);
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: {
        deletedAt: new Date(),
        content: '',
        imageKey: null,
        voiceKey: null,
        voicePeaks: [],
        sharedPostId: null,
        sharesPost: false,
        replyToId: null,
        isReply: false,
      },
      select: messageSelect,
    });
    await this.uploads.discard(existing.imageKey);
    await this.uploads.discard(existing.voiceKey);
    const message = this.toMessage(updated);
    await this.events.emitAsync(
      MessageDeletedEvent.EVENT,
      new MessageDeletedEvent(message, memberIdsOf(row)),
    );
    return message;
  }

  /**
   * The sender changes the text of a message (the picture stays): the previous text is kept as
   * a revision, `editedAt` is stamped and everyone gets the new copy. An unchanged text is a
   * no-op. Deleted messages and system lines cannot be edited.
   */
  async editMessage(
    meId: string,
    id: string,
    messageId: string,
    input: EditMessageData,
  ): Promise<Message> {
    const row = await this.rowForMember(meId, id);
    const existing = await this.userMessage(id, messageId);
    if (existing.senderId !== meId) throw forbidden('Only the sender can edit a message');
    if (existing.voiceKey !== null) throw badRequest('A voice message has no text to edit');
    if (existing.content === input.content) return this.toMessage(existing);
    const [, updated] = await this.prisma.$transaction([
      this.prisma.messageRevision.create({ data: { messageId, content: existing.content } }),
      this.prisma.message.update({
        where: { id: messageId },
        data: { content: input.content, editedAt: new Date() },
        select: messageSelect,
      }),
    ]);
    return this.announceUpdate(updated, row, meId);
  }

  /** Previous texts of a message, most recently replaced first; members only. */
  async messageRevisions(
    meId: string,
    id: string,
    messageId: string,
    query: CursorQuery,
  ): Promise<Paginated<Revision>> {
    await this.rowForMember(meId, id);
    await this.userMessage(id, messageId);
    const rows = await this.prisma.messageRevision.findMany({
      where: { messageId, ...revisionsAfter(decodeCursor(query.cursor)) },
      orderBy: [{ editedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return paginateBy(rows, query.limit, revisionKey, toRevision);
  }

  /** Sets or switches the caller's reaction; everyone gets the message with its reactions. */
  async react(meId: string, id: string, messageId: string, type: ReactionType): Promise<Message> {
    const row = await this.rowForMember(meId, id);
    await this.userMessage(id, messageId);
    await this.prisma.messageReaction.upsert({
      where: { messageId_userId: { messageId, userId: meId } },
      create: { messageId, userId: meId, type },
      update: { type },
    });
    return this.announceUpdate(await this.messageRow(messageId), row, meId);
  }

  /** Removes the caller's reaction, if any. */
  async unreact(meId: string, id: string, messageId: string): Promise<Message> {
    const row = await this.rowForMember(meId, id);
    await this.userMessage(id, messageId);
    await this.prisma.messageReaction.deleteMany({ where: { messageId, userId: meId } });
    return this.announceUpdate(await this.messageRow(messageId), row, meId);
  }

  /** Moves the caller's read mark to now; the others hear about it only when it actually moved. */
  async markRead(meId: string, id: string): Promise<MarkReadResult> {
    const row = await this.rowForMember(meId, id);
    const mine = row.members.find((member) => member.user.id === meId);
    // The newest message itself, not the denormalised stamp: under concurrent sends the two
    // can briefly disagree, and a mark "caught up" with the stamp would leave unread counts
    // behind (review L15).
    const newest = row.messages[0]?.createdAt ?? row.lastMessageAt;
    const caughtUp =
      newest === null ||
      (mine?.lastReadAt !== null && mine?.lastReadAt !== undefined && mine.lastReadAt >= newest);
    if (caughtUp) return { readAt: (mine?.lastReadAt ?? new Date()).toISOString() };

    const readAt = new Date();
    await this.prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: id, userId: meId } },
      data: { lastReadAt: readAt },
    });
    // Everyone, the reader included: their other tabs lower their badge on it (review L9).
    await this.events.emitAsync(
      ConversationReadEvent.EVENT,
      new ConversationReadEvent(id, meId, readAt, memberIdsOf(row)),
    );
    return { readAt: readAt.toISOString() };
  }

  /** Any member can bring people into a group. */
  async addMembers(meId: string, id: string, input: AddMembersInput): Promise<Conversation> {
    const row = await this.groupForMember(meId, id);
    const wanted = await this.resolveMembers(meId, input.userIds, 'userIds');
    // The cap is checked and the rows are written under a lock on the group, so two
    // concurrent additions cannot both pass the count (review L16).
    const { added, line } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${id}::uuid FOR UPDATE`;
      const members = await tx.conversationMember.findMany({
        where: { conversationId: id },
        select: { userId: true },
      });
      const current = new Set(members.map((member) => member.userId));
      const toAdd = wanted.filter((person) => !current.has(person.id));
      if (current.size + toAdd.length > GROUP_MAX_MEMBERS) {
        throw badRequest(`A group can have at most ${GROUP_MAX_MEMBERS} members`, {
          userIds: `At most ${GROUP_MAX_MEMBERS} members`,
        });
      }
      if (toAdd.length === 0) return { added: 0, line: null };
      await tx.conversationMember.createMany({
        data: toAdd.map((person) => ({ conversationId: id, userId: person.id })),
        skipDuplicates: true,
      });
      const written = await this.writeSystemLine(tx, id, meId, {
        type: 'members_added',
        actor: this.personOf(row, meId),
        users: toAdd,
        title: null,
      });
      return { added: toAdd.length, line: written };
    });
    if (added === 0 || !line) return this.withUnreadOne(row, meId);
    const updated = await this.rowForMember(meId, id);
    await this.events.emitAsync(
      ConversationUpdatedEvent.EVENT,
      new ConversationUpdatedEvent(id, memberIdsOf(updated)),
    );
    await this.events.emitAsync(
      MessageSentEvent.EVENT,
      new MessageSentEvent(line, memberIdsOf(updated)),
    );
    return this.withUnreadOne(updated, meId);
  }

  /** Leaving the last seat deletes the group and its messages; the last admin out hands the role on. */
  async leave(meId: string, id: string): Promise<void> {
    const row = await this.groupForMember(meId, id);
    const remaining = memberIdsOf(row).filter((userId) => userId !== meId);
    if (remaining.length === 0) {
      await this.prisma.conversation.delete({ where: { id } });
      await this.uploads.discard(row.pictureKey);
      await this.events.emitAsync(
        ConversationLeftEvent.EVENT,
        new ConversationLeftEvent(id, meId, remaining),
      );
      return;
    }
    const line = await this.prisma.$transaction(async (tx) => {
      await tx.conversationMember.delete({
        where: { conversationId_userId: { conversationId: id, userId: meId } },
      });
      await tx.$executeRaw(promoteIfNoAdminSql(id));
      return this.writeSystemLine(tx, id, meId, {
        type: 'member_left',
        actor: this.personOf(row, meId),
        users: [],
        title: null,
      });
    });
    await this.events.emitAsync(
      ConversationLeftEvent.EVENT,
      new ConversationLeftEvent(id, meId, remaining),
    );
    await this.events.emitAsync(MessageSentEvent.EVENT, new MessageSentEvent(line, remaining));
  }

  /** Admins only. The removed person hears `conversation:removed`, the rest a system line. */
  async removeMember(meId: string, id: string, userId: string): Promise<void> {
    const row = await this.groupForAdmin(meId, id);
    if (userId === meId) throw badRequest('Leave the group instead of removing yourself');
    const target = row.members.find((member) => member.user.id === userId);
    if (!target) throw notFound('That person is not in the group');
    const remaining = memberIdsOf(row).filter((memberId) => memberId !== userId);
    const line = await this.prisma.$transaction(async (tx) => {
      await tx.conversationMember.delete({
        where: { conversationId_userId: { conversationId: id, userId } },
      });
      await tx.$executeRaw(promoteIfNoAdminSql(id));
      return this.writeSystemLine(tx, id, meId, {
        type: 'member_removed',
        actor: this.personOf(row, meId),
        users: [{ id: target.user.id, name: target.user.name }],
        title: null,
      });
    });
    await this.events.emitAsync(
      ConversationLeftEvent.EVENT,
      new ConversationLeftEvent(id, userId, remaining),
    );
    await this.events.emitAsync(MessageSentEvent.EVENT, new MessageSentEvent(line, remaining));
  }

  /** Admins only; an unchanged title is a no-op. */
  async rename(meId: string, id: string, input: RenameGroupInput): Promise<Conversation> {
    const row = await this.groupForAdmin(meId, id);
    if (row.title === input.title) return this.withUnreadOne(row, meId);
    const line = await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({ where: { id }, data: { title: input.title } });
      return this.writeSystemLine(tx, id, meId, {
        type: 'renamed',
        actor: this.personOf(row, meId),
        users: [],
        title: input.title,
      });
    });
    return this.announceChange(meId, id, line);
  }

  /**
   * Admins only: the group's picture, an upload of kind `group` made by the caller. The
   * previous file is discarded; the same key again is a no-op.
   */
  async setPicture(meId: string, id: string, input: SetGroupPictureInput): Promise<Conversation> {
    const row = await this.groupForAdmin(meId, id);
    await this.uploads.assertOwned(input.pictureKey, {
      ownerId: meId,
      kind: 'group',
      field: 'pictureKey',
    });
    if (row.pictureKey === input.pictureKey) return this.withUnreadOne(row, meId);
    const line = await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({ where: { id }, data: { pictureKey: input.pictureKey } });
      return this.writeSystemLine(tx, id, meId, {
        type: 'picture_changed',
        actor: this.personOf(row, meId),
        users: [],
        title: null,
      });
    });
    await this.uploads.discard(row.pictureKey);
    return this.announceChange(meId, id, line);
  }

  /** Admins only; a group without a picture is a no-op. */
  async removePicture(meId: string, id: string): Promise<Conversation> {
    const row = await this.groupForAdmin(meId, id);
    if (row.pictureKey === null) return this.withUnreadOne(row, meId);
    const line = await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({ where: { id }, data: { pictureKey: null } });
      return this.writeSystemLine(tx, id, meId, {
        type: 'picture_removed',
        actor: this.personOf(row, meId),
        users: [],
        title: null,
      });
    });
    await this.uploads.discard(row.pictureKey);
    return this.announceChange(meId, id, line);
  }

  /** Admins only. Demoting the last admin is refused so a group never ends up without one. */
  async setRole(
    meId: string,
    id: string,
    userId: string,
    role: ConversationRole,
  ): Promise<Conversation> {
    const row = await this.groupForAdmin(meId, id);
    const target = row.members.find((member) => member.user.id === userId);
    if (!target) throw notFound('That person is not in the group');
    if (target.role === role) return this.withUnreadOne(row, meId);
    const admins = row.members.filter((member) => member.role === 'admin').length;
    if (role === 'member' && admins <= 1) {
      throw badRequest('A group needs at least one admin', {
        role: 'Make someone else an admin first',
      });
    }
    const line = await this.prisma.$transaction(async (tx) => {
      await tx.conversationMember.update({
        where: { conversationId_userId: { conversationId: id, userId } },
        data: { role },
      });
      return this.writeSystemLine(tx, id, meId, {
        type: role === 'admin' ? 'admin_added' : 'admin_removed',
        actor: this.personOf(row, meId),
        users: [{ id: target.user.id, name: target.user.name }],
        title: null,
      });
    });
    return this.announceChange(meId, id, line);
  }

  /**
   * After a change to the group itself (its title, picture or roles): every member refetches
   * the conversation and gets the system line; the caller gets the fresh row.
   */
  private async announceChange(meId: string, id: string, line: Message): Promise<Conversation> {
    const updated = await this.rowForMember(meId, id);
    const memberIds = memberIdsOf(updated);
    await this.events.emitAsync(
      ConversationUpdatedEvent.EVENT,
      new ConversationUpdatedEvent(id, memberIds),
    );
    await this.events.emitAsync(MessageSentEvent.EVENT, new MessageSentEvent(line, memberIds));
    return this.withUnreadOne(updated, meId);
  }

  /** The other members, or nobody when the caller is not one: for relays that must not throw. */
  async otherMemberIds(meId: string, id: string): Promise<string[]> {
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId: id },
      select: { userId: true },
    });
    const ids = members.map((member) => member.userId);
    return ids.includes(meId) ? ids.filter((userId) => userId !== meId) : [];
  }

  /**
   * Non-members get a 404, and so does either side of a block for the direct thread between
   * them: it is hidden from the list and closed to both while the block stands (ADR 0016).
   */
  private async rowForMember(meId: string, id: string): Promise<ConversationRow> {
    const row = await this.prisma.conversation.findFirst({
      where: { id, members: { some: { userId: meId } } },
      select: conversationSelect,
    });
    if (!row) throw notFound('Conversation not found');
    if (row.kind === 'direct') {
      const other = row.members.find((member) => member.user.id !== meId);
      if (other && (await this.visibility.isBlockedBetween(meId, other.user.id))) {
        throw notFound('Conversation not found');
      }
    }
    return row;
  }

  private async groupForMember(meId: string, id: string): Promise<ConversationRow> {
    const row = await this.rowForMember(meId, id);
    if (row.kind !== 'group') throw badRequest('Only groups have a member list');
    return row;
  }

  private async groupForAdmin(meId: string, id: string): Promise<ConversationRow> {
    const row = await this.groupForMember(meId, id);
    if (!isAdminOf(row, meId)) throw forbidden('Only group admins can do that');
    return row;
  }

  /** Deduplicated, without the caller, every id a real person; names for the system line. */
  private async resolveMembers(
    meId: string,
    ids: readonly string[],
    field: string,
  ): Promise<PersonRef[]> {
    const unique = [...new Set(ids)].filter((userId) => userId !== meId);
    if (unique.length === 0) {
      throw badRequest('Pick at least one other person', {
        [field]: 'Pick at least one other person',
      });
    }
    const found = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    if (found.length !== unique.length) {
      throw badRequest('Unknown member', { [field]: 'Someone on the list does not exist' });
    }
    return found;
  }

  /** A message of the conversation that can still be edited or reacted to: a user's, not deleted. */
  private async userMessage(conversationId: string, messageId: string): Promise<MessageRow> {
    const existing = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: messageSelect,
    });
    if (!existing) throw notFound('Message not found');
    if (existing.kind === 'system') throw badRequest('System lines cannot be changed');
    if (existing.deletedAt) throw badRequest('A deleted message cannot be changed');
    return existing;
  }

  private messageRow(messageId: string): Promise<MessageRow> {
    return this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      select: messageSelect,
    });
  }

  /** Every member, the actor's own tabs included, gets the message as it is now. */
  private async announceUpdate(
    updated: MessageRow,
    row: ConversationRow,
    actorId: string,
  ): Promise<Message> {
    const message = this.toMessage(updated);
    await this.events.emitAsync(
      MessageUpdatedEvent.EVENT,
      new MessageUpdatedEvent(message, memberIdsOf(row), actorId),
    );
    return message;
  }

  private personOf(row: ConversationRow, userId: string): PersonRef {
    const member = row.members.find((candidate) => candidate.user.id === userId);
    return { id: userId, name: member?.user.name ?? 'Someone' };
  }

  /** Every message, a system line included, moves the conversation up the list. */
  private async bumpActivity(tx: Tx, id: string, at: Date): Promise<void> {
    // Two concurrent writes commit in any order; the stamp keeps the newest (review L15).
    await tx.$executeRaw`
      UPDATE conversations
      SET last_message_at = GREATEST(COALESCE(last_message_at, ${at}), ${at})
      WHERE id = ${id}::uuid`;
  }

  /** A line the server writes into the thread; counts for nobody as unread, moves no read mark. */
  private async writeSystemLine(
    tx: Tx,
    conversationId: string,
    actorId: string,
    line: SystemLine,
  ): Promise<Message> {
    const created = await tx.message.create({
      data: { conversationId, senderId: actorId, kind: 'system', content: '', systemMeta: line },
      select: messageSelect,
    });
    await this.bumpActivity(tx, conversationId, created.createdAt);
    return this.toMessage(created);
  }

  private async withUnreadOne(row: ConversationRow, meId: string): Promise<Conversation> {
    const [conversation] = await this.withUnread([row], meId);
    if (!conversation) throw notFound('Conversation not found');
    return conversation;
  }

  /** Messages from others newer than the viewer's read mark, one query for the whole page. */
  private async withUnread(rows: ConversationRow[], meId: string): Promise<Conversation[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => Prisma.sql`${row.id}::uuid`);
    const counts = await this.prisma.$queryRaw<UnreadRow[]>(Prisma.sql`
      SELECT m.conversation_id, COUNT(*)::int AS unread
      FROM "messages" m
      JOIN "conversation_members" cm
        ON cm.conversation_id = m.conversation_id AND cm.user_id = ${meId}::uuid
      WHERE m.conversation_id IN (${Prisma.join(ids)})
        AND m.sender_id <> ${meId}::uuid
        AND m.kind = 'user'
        AND m.deleted_at IS NULL
        AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
      GROUP BY m.conversation_id
    `);
    const unreadById = new Map(counts.map((row) => [row.conversation_id, row.unread]));
    return rows.map((row) => toConversation(row, unreadById.get(row.id) ?? 0, this.assets.base));
  }

  private readonly toMessage = (row: MessageRow): Message => toMessage(row, this.assets.base);
}
