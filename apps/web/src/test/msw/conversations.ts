import {
  addMembersSchema,
  type Conversation,
  createGroupSchema,
  editMessageSchema,
  GROUP_MAX_MEMBERS,
  type Message,
  messageReactionInputSchema,
  renameGroupSchema,
  type Revision,
  sendMessageSchema,
  setGroupPictureSchema,
  setMemberRoleSchema,
  type SystemLine,
} from '@beso/shared';
import { HttpResponse, http } from 'msw/http';
import { makeMessage, summaryOf, testId } from '../fixtures';
import { API, apiError, unauthorized } from './auth';
import { type MockConversation, mockDb, paginate, seedConversation, seedDirect } from './db';

const param = (value: string | readonly string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? '';
const byNewest = (a: Message, b: Message) => b.createdAt.localeCompare(a.createdAt);
const notFound = () => apiError(404, 'NOT_FOUND', 'Conversation not found');
const forbidden = () => apiError(403, 'FORBIDDEN', 'Only group admins can do that');
const isAdmin = (row: MockConversation, userId: string) =>
  row.members.some((m) => m.userId === userId && m.role === 'admin');
const personOf = (userId: string) => ({
  id: userId,
  name: mockDb.users.find((u) => u.id === userId)?.name ?? 'Someone',
});

const messagesOf = (conversationId: string) =>
  mockDb.messages.filter((m) => m.conversationId === conversationId).toSorted(byNewest);

/** The row as `viewerId` sees it: member summaries, newest message, their unread count. */
export function conversationFor(viewerId: string, row: MockConversation): Conversation {
  const messages = messagesOf(row.id);
  const mine = row.members.find((m) => m.userId === viewerId);
  const unreadCount = messages.filter(
    (m) =>
      m.kind === 'user' &&
      m.deletedAt === null &&
      m.senderId !== viewerId &&
      (mine?.lastReadAt === null || m.createdAt > (mine?.lastReadAt ?? '')),
  ).length;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    pictureUrl: row.pictureUrl,
    createdById: row.createdById,
    createdAt: row.createdAt,
    lastMessageAt: messages[0]?.createdAt ?? null,
    members: row.members.flatMap((member) => {
      const user = mockDb.users.find((u) => u.id === member.userId);
      return user
        ? [
            {
              user: summaryOf(user),
              role: member.role,
              joinedAt: member.joinedAt,
              lastReadAt: member.lastReadAt,
            },
          ]
        : [];
    }),
    lastMessage: messages[0] ?? null,
    unreadCount,
  };
}

export function conversationsFor(viewerId: string): Conversation[] {
  return mockDb.conversations
    .filter((row) => row.members.some((m) => m.userId === viewerId))
    .map((row) => conversationFor(viewerId, row))
    .filter((row) => row.kind === 'group' || row.lastMessage !== null)
    .toSorted((a, b) =>
      (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt),
    );
}

const memberRow = (viewerId: string, conversationId: string): MockConversation | undefined =>
  mockDb.conversations.find(
    (row) => row.id === conversationId && row.members.some((m) => m.userId === viewerId),
  );

/** Persists a message the way the API does: it also moves the sender's read mark. */
export function storeMessage(
  conversationId: string,
  senderId: string,
  content: string,
  imageKey?: string,
  postId?: string,
  replyToId?: string,
): Message {
  const url = imageKey ? `http://localhost/api/v1/uploads/${imageKey}` : null;
  const original = replyToId ? mockDb.messages.find((m) => m.id === replyToId) : undefined;
  const message = makeMessage(conversationId, senderId, content, {
    image: url ? { url, width: 64, height: 64 } : null,
    imageUrl: url,
    sharedPost: postId ? { id: postId } : null,
    replyTo: original
      ? {
          id: original.id,
          senderId: original.senderId,
          excerpt: original.content,
          attachment: original.image ? 'picture' : original.sharedPost ? 'post' : null,
          deleted: original.deletedAt !== null,
        }
      : null,
    createdAt: new Date().toISOString(),
  });
  mockDb.messages.push(message);
  const member = mockDb.conversations
    .find((row) => row.id === conversationId)
    ?.members.find((m) => m.userId === senderId);
  if (member) member.lastReadAt = message.createdAt;
  return message;
}

/** A line the "server" writes about a membership change or rename; moves nobody's mark. */
export function storeSystemLine(
  conversationId: string,
  actorId: string,
  line: SystemLine,
): Message {
  const message = makeMessage(conversationId, actorId, '', {
    kind: 'system',
    system: line,
    createdAt: new Date().toISOString(),
  });
  mockDb.messages.push(message);
  return message;
}

/** The longest-standing member becomes admin when none is left (the API's `promoteIfNoAdminSql`). */
function promoteIfNoAdmin(row: MockConversation): void {
  if (row.members.some((m) => m.role === 'admin')) return;
  const oldest = row.members.toSorted(
    (a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId),
  )[0];
  if (oldest) oldest.role = 'admin';
}

/** Moves the viewer's read mark to now when something is unread; returns the mark either way. */
export function markConversationRead(viewerId: string, row: MockConversation): string {
  const member = row.members.find((m) => m.userId === viewerId);
  const latest = messagesOf(row.id)[0];
  if (!member) return new Date().toISOString();
  if (latest && (member.lastReadAt === null || member.lastReadAt < latest.createdAt)) {
    member.lastReadAt = new Date().toISOString();
  }
  return member.lastReadAt ?? new Date().toISOString();
}

export const conversationHandlers = [
  http.get(`${API}/conversations`, ({ request }) => {
    if (!mockDb.user) return unauthorized();
    return HttpResponse.json(paginate(conversationsFor(mockDb.user.id), new URL(request.url)));
  }),

  http.post(`${API}/conversations`, async ({ request }) => {
    if (!mockDb.user) return unauthorized();
    const me = mockDb.user.id;
    const body = createGroupSchema.parse(await request.json());
    const memberIds = [...new Set(body.memberIds)].filter((id) => id !== me);
    if (memberIds.length === 0) {
      return apiError(400, 'BAD_REQUEST', 'Pick at least one other person', {
        memberIds: 'Pick at least one other person',
      });
    }
    if (memberIds.some((id) => !mockDb.users.some((u) => u.id === id))) {
      return apiError(400, 'BAD_REQUEST', 'Unknown member', {
        memberIds: 'Someone on the list does not exist',
      });
    }
    if (memberIds.length + 1 > GROUP_MAX_MEMBERS) {
      return apiError(400, 'BAD_REQUEST', `A group can have at most ${GROUP_MAX_MEMBERS} members`, {
        memberIds: `At most ${GROUP_MAX_MEMBERS} members`,
      });
    }
    const row = seedConversation('group', [me, ...memberIds], {
      title: body.title,
      createdById: me,
      createdAt: new Date().toISOString(),
    });
    storeSystemLine(row.id, me, {
      type: 'group_created',
      actor: personOf(me),
      users: [],
      title: body.title,
    });
    return HttpResponse.json(conversationFor(me, row), { status: 201 });
  }),

  http.put(`${API}/conversations/direct/:userId`, ({ params }) => {
    if (!mockDb.user) return unauthorized();
    const me = mockDb.user.id;
    const userId = param(params.userId);
    if (userId === me) return apiError(400, 'BAD_REQUEST', 'You cannot message yourself');
    if (!mockDb.users.some((u) => u.id === userId)) {
      return apiError(404, 'NOT_FOUND', 'User not found');
    }
    return HttpResponse.json(conversationFor(me, seedDirect(me, userId)));
  }),

  http.get(`${API}/conversations/:id`, ({ params }) => {
    if (!mockDb.user) return unauthorized();
    const row = memberRow(mockDb.user.id, param(params.id));
    return row ? HttpResponse.json(conversationFor(mockDb.user.id, row)) : notFound();
  }),

  http.patch(`${API}/conversations/:id`, async ({ request, params }) => {
    if (!mockDb.user) return unauthorized();
    const me = mockDb.user.id;
    const row = memberRow(me, param(params.id));
    if (!row) return notFound();
    if (row.kind !== 'group') return apiError(400, 'BAD_REQUEST', 'Only groups have a member list');
    if (!isAdmin(row, me)) return forbidden();
    const body = renameGroupSchema.parse(await request.json());
    if (row.title !== body.title) {
      row.title = body.title;
      storeSystemLine(row.id, me, {
        type: 'renamed',
        actor: personOf(me),
        users: [],
        title: body.title,
      });
    }
    return HttpResponse.json(conversationFor(me, row));
  }),

  http.put(`${API}/conversations/:id/picture`, async ({ request, params }) => {
    if (!mockDb.user) return unauthorized();
    const me = mockDb.user.id;
    const row = memberRow(me, param(params.id));
    if (!row) return notFound();
    if (row.kind !== 'group') return apiError(400, 'BAD_REQUEST', 'Only groups have a member list');
    if (!isAdmin(row, me)) return forbidden();
    const body = setGroupPictureSchema.parse(await request.json());
    const url = `http://localhost/api/v1/uploads/${body.pictureKey}`;
    if (row.pictureUrl !== url) {
      row.pictureUrl = url;
      storeSystemLine(row.id, me, {
        type: 'picture_changed',
        actor: personOf(me),
        users: [],
        title: null,
      });
    }
    return HttpResponse.json(conversationFor(me, row));
  }),

  http.delete(`${API}/conversations/:id/picture`, ({ params }) => {
    if (!mockDb.user) return unauthorized();
    const me = mockDb.user.id;
    const row = memberRow(me, param(params.id));
    if (!row) return notFound();
    if (row.kind !== 'group') return apiError(400, 'BAD_REQUEST', 'Only groups have a member list');
    if (!isAdmin(row, me)) return forbidden();
    if (row.pictureUrl !== null) {
      row.pictureUrl = null;
      storeSystemLine(row.id, me, {
        type: 'picture_removed',
        actor: personOf(me),
        users: [],
        title: null,
      });
    }
    return HttpResponse.json(conversationFor(me, row));
  }),

  http.delete(`${API}/conversations/:id/messages/:messageId`, ({ params }) => {
    if (!mockDb.user) return unauthorized();
    const row = memberRow(mockDb.user.id, param(params.id));
    if (!row) return notFound();
    const message = mockDb.messages.find(
      (m) => m.id === param(params.messageId) && m.conversationId === row.id,
    );
    if (!message) return apiError(404, 'NOT_FOUND', 'Message not found');
    if (message.senderId !== mockDb.user.id) {
      return apiError(403, 'FORBIDDEN', 'Only the sender can delete a message');
    }
    if (message.deletedAt === null) {
      message.deletedAt = new Date().toISOString();
      message.content = '';
      message.image = null;
      message.imageUrl = null;
      message.sharedPost = null;
      message.replyTo = null;
    }
    return HttpResponse.json(message);
  }),

  http.get(`${API}/conversations/:id/messages`, ({ request, params }) => {
    if (!mockDb.user) return unauthorized();
    const row = memberRow(mockDb.user.id, param(params.id));
    if (!row) return notFound();
    return HttpResponse.json(paginate(messagesOf(row.id), new URL(request.url)));
  }),

  http.post(`${API}/conversations/:id/messages`, async ({ request, params }) => {
    if (!mockDb.user) return unauthorized();
    const row = memberRow(mockDb.user.id, param(params.id));
    if (!row) return notFound();
    const body = sendMessageSchema.parse(await request.json());
    const message = storeMessage(
      row.id,
      mockDb.user.id,
      body.content,
      body.imageKey,
      body.postId,
      body.replyToId,
    );
    return HttpResponse.json(message, { status: 201 });
  }),

  http.post(`${API}/conversations/:id/read`, ({ params }) => {
    if (!mockDb.user) return unauthorized();
    const row = memberRow(mockDb.user.id, param(params.id));
    if (!row) return notFound();
    return HttpResponse.json({ readAt: markConversationRead(mockDb.user.id, row) });
  }),

  http.post(`${API}/conversations/:id/members`, async ({ request, params }) => {
    if (!mockDb.user) return unauthorized();
    const row = memberRow(mockDb.user.id, param(params.id));
    if (!row) return notFound();
    if (row.kind !== 'group') return apiError(400, 'BAD_REQUEST', 'Only groups have a member list');
    const body = addMembersSchema.parse(await request.json());
    const wanted = [...new Set(body.userIds)].filter(
      (userId) => !row.members.some((m) => m.userId === userId),
    );
    if (wanted.some((userId) => !mockDb.users.some((u) => u.id === userId))) {
      return apiError(400, 'BAD_REQUEST', 'Unknown member', {
        userIds: 'Someone on the list does not exist',
      });
    }
    if (row.members.length + wanted.length > GROUP_MAX_MEMBERS) {
      return apiError(400, 'BAD_REQUEST', `A group can have at most ${GROUP_MAX_MEMBERS} members`, {
        userIds: `At most ${GROUP_MAX_MEMBERS} members`,
      });
    }
    const joinedAt = new Date().toISOString();
    for (const userId of wanted) {
      row.members.push({ userId, role: 'member', joinedAt, lastReadAt: null });
    }
    if (wanted.length > 0) {
      storeSystemLine(row.id, mockDb.user.id, {
        type: 'members_added',
        actor: personOf(mockDb.user.id),
        users: wanted.map(personOf),
        title: null,
      });
    }
    return HttpResponse.json(conversationFor(mockDb.user.id, row));
  }),

  http.delete(`${API}/conversations/:id/members/me`, ({ params }) => {
    if (!mockDb.user) return unauthorized();
    const me = mockDb.user.id;
    const row = memberRow(me, param(params.id));
    if (!row) return notFound();
    if (row.kind !== 'group') return apiError(400, 'BAD_REQUEST', 'Only groups have a member list');
    row.members = row.members.filter((m) => m.userId !== me);
    if (row.members.length === 0) {
      mockDb.conversations = mockDb.conversations.filter((c) => c.id !== row.id);
      mockDb.messages = mockDb.messages.filter((m) => m.conversationId !== row.id);
    } else {
      promoteIfNoAdmin(row);
      storeSystemLine(row.id, me, {
        type: 'member_left',
        actor: personOf(me),
        users: [],
        title: null,
      });
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete(`${API}/conversations/:id/members/:userId`, ({ params }) => {
    if (!mockDb.user) return unauthorized();
    const me = mockDb.user.id;
    const row = memberRow(me, param(params.id));
    if (!row) return notFound();
    if (row.kind !== 'group') return apiError(400, 'BAD_REQUEST', 'Only groups have a member list');
    if (!isAdmin(row, me)) return forbidden();
    const userId = param(params.userId);
    if (!row.members.some((m) => m.userId === userId)) {
      return apiError(404, 'NOT_FOUND', 'That person is not in the group');
    }
    row.members = row.members.filter((m) => m.userId !== userId);
    promoteIfNoAdmin(row);
    storeSystemLine(row.id, me, {
      type: 'member_removed',
      actor: personOf(me),
      users: [personOf(userId)],
      title: null,
    });
    return new HttpResponse(null, { status: 204 });
  }),

  http.put(`${API}/conversations/:id/members/:userId/role`, async ({ request, params }) => {
    if (!mockDb.user) return unauthorized();
    const me = mockDb.user.id;
    const row = memberRow(me, param(params.id));
    if (!row) return notFound();
    if (!isAdmin(row, me)) return forbidden();
    const member = row.members.find((m) => m.userId === param(params.userId));
    if (!member) return apiError(404, 'NOT_FOUND', 'That person is not in the group');
    const body = setMemberRoleSchema.parse(await request.json());
    const admins = row.members.filter((m) => m.role === 'admin').length;
    if (body.role === 'member' && member.role === 'admin' && admins <= 1) {
      return apiError(400, 'BAD_REQUEST', 'A group needs at least one admin', {
        role: 'Make someone else an admin first',
      });
    }
    if (member.role !== body.role) {
      member.role = body.role;
      storeSystemLine(row.id, me, {
        type: body.role === 'admin' ? 'admin_added' : 'admin_removed',
        actor: personOf(me),
        users: [personOf(member.userId)],
        title: null,
      });
    }
    return HttpResponse.json(conversationFor(me, row));
  }),

  http.patch(`${API}/conversations/:id/messages/:messageId`, async ({ request, params }) => {
    if (!mockDb.user) return unauthorized();
    const row = memberRow(mockDb.user.id, param(params.id));
    if (!row) return notFound();
    const message = changeableMessage(row.id, param(params.messageId));
    if (message instanceof HttpResponse) return message;
    if (message.senderId !== mockDb.user.id) {
      return apiError(403, 'FORBIDDEN', 'Only the sender can edit a message');
    }
    const body = editMessageSchema.parse(await request.json());
    if (body.content !== message.content) {
      const revisions = mockDb.messageRevisions.get(message.id) ?? [];
      revisionSeq += 1;
      revisions.unshift({
        id: testId('message', 900 + revisionSeq),
        content: message.content,
        editedAt: new Date().toISOString(),
      });
      mockDb.messageRevisions.set(message.id, revisions);
      message.content = body.content;
      message.editedAt = new Date().toISOString();
    }
    return HttpResponse.json(message);
  }),

  http.get(`${API}/conversations/:id/messages/:messageId/revisions`, ({ request, params }) => {
    if (!mockDb.user) return unauthorized();
    const row = memberRow(mockDb.user.id, param(params.id));
    if (!row) return notFound();
    const revisions: Revision[] = mockDb.messageRevisions.get(param(params.messageId)) ?? [];
    return HttpResponse.json(paginate(revisions, new URL(request.url)));
  }),

  http.put(`${API}/conversations/:id/messages/:messageId/reaction`, async ({ request, params }) => {
    if (!mockDb.user) return unauthorized();
    const me = mockDb.user.id;
    const row = memberRow(me, param(params.id));
    if (!row) return notFound();
    const message = changeableMessage(row.id, param(params.messageId));
    if (message instanceof HttpResponse) return message;
    const body = messageReactionInputSchema.parse(await request.json());
    message.reactions = [
      ...message.reactions.filter((reaction) => reaction.userId !== me),
      { userId: me, type: body.type },
    ];
    return HttpResponse.json(message);
  }),

  http.delete(`${API}/conversations/:id/messages/:messageId/reaction`, ({ params }) => {
    if (!mockDb.user) return unauthorized();
    const me = mockDb.user.id;
    const row = memberRow(me, param(params.id));
    if (!row) return notFound();
    const message = changeableMessage(row.id, param(params.messageId));
    if (message instanceof HttpResponse) return message;
    message.reactions = message.reactions.filter((reaction) => reaction.userId !== me);
    return HttpResponse.json(message);
  }),
];

let revisionSeq = 0;

/** A user's message of the conversation that is not deleted, or the error the API would give. */
function changeableMessage(
  conversationId: string,
  messageId: string,
): Message | ReturnType<typeof apiError> {
  const message = mockDb.messages.find(
    (m) => m.id === messageId && m.conversationId === conversationId,
  );
  if (!message) return apiError(404, 'NOT_FOUND', 'Message not found');
  if (message.kind === 'system') {
    return apiError(400, 'BAD_REQUEST', 'System lines cannot be changed');
  }
  if (message.deletedAt) return apiError(400, 'BAD_REQUEST', 'A deleted message cannot be changed');
  return message;
}
