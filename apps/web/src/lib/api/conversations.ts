import {
  type AddMembersInput,
  type Conversation,
  type ConversationList,
  type ConversationRole,
  type CreateGroupInput,
  type EditMessageInput,
  type MarkReadResult,
  type Message,
  type MessageList,
  type ReactionType,
  type RenameGroupInput,
  type RevisionList,
  type SendMessageInput,
  type SetGroupPictureInput,
  conversationListSchema,
  conversationSchema,
  markReadResultSchema,
  messageListSchema,
  messageSchema,
  revisionListSchema,
} from '@beso/shared';
import { api } from './client';
import { type PageOptions, queryString } from './query';

/** Newest activity first, a page at a time. */
export const fetchConversations = ({
  cursor,
  signal,
}: PageOptions = {}): Promise<ConversationList> =>
  api.get(`/conversations${queryString({ cursor })}`, conversationListSchema, { signal });

export const fetchConversation = (id: string, signal?: AbortSignal): Promise<Conversation> =>
  api.get(`/conversations/${id}`, conversationSchema, { signal });

/** The direct thread with someone, created the first time it is opened. */
export const ensureDirectConversation = (userId: string): Promise<Conversation> =>
  api.put(`/conversations/direct/${userId}`, undefined, { schema: conversationSchema });

export const createGroup = (input: CreateGroupInput): Promise<Conversation> =>
  api.post('/conversations', input, { schema: conversationSchema });

export const addMembers = (id: string, input: AddMembersInput): Promise<Conversation> =>
  api.post(`/conversations/${id}/members`, input, { schema: conversationSchema });

export const leaveGroup = (id: string): Promise<void> =>
  api.delete(`/conversations/${id}/members/me`);

/** Admins only. */
export const renameGroup = (id: string, input: RenameGroupInput): Promise<Conversation> =>
  api.patch(`/conversations/${id}`, input, { schema: conversationSchema });

/** Admins only: the group's picture, an upload made with kind `group`. */
export const setGroupPicture = (id: string, input: SetGroupPictureInput): Promise<Conversation> =>
  api.put(`/conversations/${id}/picture`, input, { schema: conversationSchema });

/** Admins only. */
export const removeGroupPicture = (id: string): Promise<Conversation> =>
  api.delete(`/conversations/${id}/picture`, { schema: conversationSchema });

/** Admins only. */
export const removeMember = (id: string, userId: string): Promise<void> =>
  api.delete(`/conversations/${id}/members/${userId}`);

/** Admins only. */
export const setMemberRole = (
  id: string,
  userId: string,
  role: ConversationRole,
): Promise<Conversation> =>
  api.put(`/conversations/${id}/members/${userId}/role`, { role }, { schema: conversationSchema });

/** The sender takes a message back; the answer is the message as everyone sees it now. */
export const deleteMessage = (id: string, messageId: string): Promise<Message> =>
  api.delete(`/conversations/${id}/messages/${messageId}`, { schema: messageSchema });

/** The sender changes the text; the answer is the message as everyone sees it now. */
export const editMessage = (
  id: string,
  messageId: string,
  input: EditMessageInput,
): Promise<Message> =>
  api.patch(`/conversations/${id}/messages/${messageId}`, input, { schema: messageSchema });

export const fetchMessageRevisions = (
  id: string,
  messageId: string,
  { cursor, signal }: PageOptions,
): Promise<RevisionList> =>
  api.get(
    `/conversations/${id}/messages/${messageId}/revisions${queryString({ cursor })}`,
    revisionListSchema,
    { signal },
  );

/** Sets or switches my reaction; the answer is the message with everyone's reactions. */
export const setMessageReaction = (
  id: string,
  messageId: string,
  type: ReactionType,
): Promise<Message> =>
  api.put(
    `/conversations/${id}/messages/${messageId}/reaction`,
    { type },
    { schema: messageSchema },
  );

export const clearMessageReaction = (id: string, messageId: string): Promise<Message> =>
  api.delete(`/conversations/${id}/messages/${messageId}/reaction`, { schema: messageSchema });

export const fetchMessages = (id: string, { cursor, signal }: PageOptions): Promise<MessageList> =>
  api.get(`/conversations/${id}/messages${queryString({ cursor })}`, messageListSchema, {
    signal,
  });

/** HTTP fallbacks for when the socket is not connected. */
export const sendMessageHttp = (id: string, input: SendMessageInput): Promise<Message> =>
  api.post(`/conversations/${id}/messages`, input, { schema: messageSchema });

export const markReadHttp = (id: string): Promise<MarkReadResult> =>
  api.post(`/conversations/${id}/read`, undefined, { schema: markReadResultSchema });
