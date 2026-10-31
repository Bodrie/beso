import type { QueryClient } from '@tanstack/react-query';
import type { Conversation, Message, MessageList } from '@beso/shared';
import { isApiClientError } from '@/lib/api/client';
import { fetchMessages } from '@/lib/api/conversations';
import {
  NO_CURSOR,
  type Pages,
  filterItems,
  flattenPages,
  mapItems,
  prependItem,
} from '@/lib/infinite';
import { queryKeys } from '@/lib/query-keys';
import {
  type ConversationPages,
  conversationQueryOptions,
  forgetConversation,
  moveToTop,
  putInList,
} from './use-conversations';

/** A message as the thread shows it; `status` and the keys only exist on optimistic copies. */
export type ThreadMessage = Message & {
  status?: 'sending' | 'failed';
  imageKey?: string;
  voiceKey?: string;
};
type ThreadPages = Pages<ThreadMessage>;

/**
 * Newest first in the cache (like the API); only touches threads that are already loaded.
 * The server pushes my own messages back before the ack resolves, so a push replaces the
 * optimistic copy it confirms instead of sitting next to it.
 */
export function appendToThread(
  queryClient: QueryClient,
  conversationId: string,
  message: ThreadMessage,
): void {
  queryClient.setQueryData<ThreadPages>(
    queryKeys.conversations.messages(conversationId),
    (data) => {
      if (!data) return data;
      const confirmed = message.status
        ? data
        : withoutFirstPending(
            data,
            (item) =>
              item.senderId === message.senderId &&
              item.content === message.content &&
              (item.image === null) === (message.image === null) &&
              (item.voice === null) === (message.voice === null) &&
              (item.sharedPost === null) === (message.sharedPost === null) &&
              (item.replyTo === null) === (message.replyTo === null),
          );
      return prependItem(confirmed, message);
    },
  );
}

function withoutFirstPending(
  data: ThreadPages,
  matches: (item: ThreadMessage) => boolean,
): ThreadPages {
  let dropped = false;
  return filterItems(data, (item) => {
    if (dropped || item.status !== 'sending' || !matches(item)) return true;
    dropped = true;
    return false;
  });
}

/** Swaps an optimistic copy for the persisted message (which may already have arrived by push). */
export function replaceInThread(
  queryClient: QueryClient,
  conversationId: string,
  tempId: string,
  message: Message,
): void {
  queryClient.setQueryData<ThreadPages>(
    queryKeys.conversations.messages(conversationId),
    (data) => {
      if (!data) return data;
      const withoutTemp = filterItems(data, (item) => item.id !== tempId);
      return prependItem(withoutTemp, message);
    },
  );
}

export function markFailedInThread(
  queryClient: QueryClient,
  conversationId: string,
  tempId: string,
): void {
  queryClient.setQueryData<ThreadPages>(
    queryKeys.conversations.messages(conversationId),
    (data) =>
      data && mapItems(data, (item) => (item.id === tempId ? { ...item, status: 'failed' } : item)),
  );
}

export function removeFromThread(
  queryClient: QueryClient,
  conversationId: string,
  id: string,
): void {
  queryClient.setQueryData<ThreadPages>(
    queryKeys.conversations.messages(conversationId),
    (data) => data && filterItems(data, (item) => item.id !== id),
  );
}

/** Applies `patch` to one message of a loaded thread (an optimistic reaction, before the server copy arrives). */
export function patchMessage(
  queryClient: QueryClient,
  conversationId: string,
  messageId: string,
  patch: (message: ThreadMessage) => ThreadMessage,
): void {
  queryClient.setQueryData<ThreadPages>(
    queryKeys.conversations.messages(conversationId),
    (data) => data && mapItems(data, (item) => (item.id === messageId ? patch(item) : item)),
  );
}

/**
 * A message changed on the server (deleted, edited or reacted to): the thread and the list
 * snippet show the new copy. Nothing moves, since the message keeps its place.
 */
export function replaceMessage(queryClient: QueryClient, message: Message): void {
  queryClient.setQueryData<ThreadPages>(
    queryKeys.conversations.messages(message.conversationId),
    (data) => data && mapItems(data, (item) => (item.id === message.id ? message : item)),
  );
  patchConversation(queryClient, message.conversationId, (conversation) =>
    conversation.lastMessage?.id === message.id
      ? { ...conversation, lastMessage: message }
      : conversation,
  );
}

/** Applies the same change to the list row and the detail query of one conversation. */
function patchConversation(
  queryClient: QueryClient,
  conversationId: string,
  patch: (conversation: Conversation) => Conversation,
): void {
  queryClient.setQueryData<ConversationPages>(
    queryKeys.conversations.list,
    (pages) => pages && mapItems(pages, (row) => (row.id === conversationId ? patch(row) : row)),
  );
  queryClient.setQueryData<Conversation>(
    queryKeys.conversations.detail(conversationId),
    (conversation) => conversation && patch(conversation),
  );
}

const withReadMark = (
  conversation: Conversation,
  userId: string,
  readAt: string,
): Conversation => ({
  ...conversation,
  members: conversation.members.map((member) =>
    member.user.id === userId && (member.lastReadAt === null || member.lastReadAt < readAt)
      ? { ...member, lastReadAt: readAt }
      : member,
  ),
});

/** `userId` caught up (a push about someone else, or my own read, which also clears my badge). */
export function setMemberReadAt(
  queryClient: QueryClient,
  conversationId: string,
  userId: string,
  readAt: string,
  options: { clearUnread: boolean },
): void {
  patchConversation(queryClient, conversationId, (conversation) => ({
    ...withReadMark(conversation, userId, readAt),
    unreadCount: options.clearUnread ? 0 : conversation.unreadCount,
  }));
}

/**
 * A message arrived (push or ack): the conversation moves to the top with it as the last
 * message, and the sender's read mark follows it (not for a system line, which the server
 * writes without touching anyone's mark). A conversation the list has never seen is inserted
 * from its detail query when that is loaded, otherwise the list is refetched.
 */
export function upsertConversation(
  queryClient: QueryClient,
  message: Message,
  options: { countUnread: boolean },
): void {
  const pages = queryClient.getQueryData<ConversationPages>(queryKeys.conversations.list);
  if (!pages) return;
  const existing = flattenPages(pages).find((row) => row.id === message.conversationId);
  const bump = (conversation: Conversation): Conversation => ({
    ...(message.kind === 'system'
      ? conversation
      : withReadMark(conversation, message.senderId, message.createdAt)),
    lastMessage: message,
    lastMessageAt: message.createdAt,
  });
  if (!existing) {
    const detail = queryClient.getQueryData<Conversation>(
      queryKeys.conversations.detail(message.conversationId),
    );
    if (detail) {
      putInList(queryClient, { ...bump(detail), unreadCount: options.countUnread ? 1 : 0 });
    } else {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list });
    }
    return;
  }
  if (existing.lastMessage?.id === message.id) return;
  const updated = {
    ...bump(existing),
    unreadCount: existing.unreadCount + (options.countUnread ? 1 : 0),
  };
  queryClient.setQueryData<ConversationPages>(
    queryKeys.conversations.list,
    moveToTop(pages, updated),
  );
  queryClient.setQueryData<Conversation>(
    queryKeys.conversations.detail(message.conversationId),
    (conversation) =>
      conversation && {
        ...bump(conversation),
        unreadCount: conversation.unreadCount + (options.countUnread ? 1 : 0),
      },
  );
}

/** `conversation:update`: fetch the fresh copy; a 404 means I am no longer in it. */
export async function refreshConversation(
  queryClient: QueryClient,
  conversationId: string,
): Promise<void> {
  try {
    const conversation = await queryClient.fetchQuery({
      ...conversationQueryOptions(conversationId),
      staleTime: 0,
    });
    putInList(queryClient, conversation);
  } catch (error) {
    if (isApiClientError(error) && error.status === 404) {
      forgetConversation(queryClient, conversationId);
    }
  }
}

/** The API's order: newest first, ties broken by id. */
function newestFirst(a: ThreadMessage, b: ThreadMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** Ids of the persisted messages in every loaded thread: what was known before a gap. */
export function heldMessageIds(queryClient: QueryClient): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [, data] of queryClient.getQueriesData<ThreadPages>({
    queryKey: queryKeys.conversations.threads,
  })) {
    for (const message of flattenPages(data)) if (!message.status) ids.add(message.id);
  }
  return ids;
}

/**
 * Brings a loaded thread up to date with the newest page from the server. When that page
 * reaches back to a message held before the gap, the missing messages are slotted in and the
 * older pages stay as they are; otherwise more than a page was missed and the thread starts
 * over from that page. Bubbles that only exist here (sending, failed) and pushes newer than
 * the page survive either way.
 */
export function mergeNewestPage(
  data: ThreadPages,
  newest: MessageList,
  heldBefore: ReadonlySet<string>,
): ThreadPages {
  const fresh = new Map(newest.items.map((message) => [message.id, message]));
  // A held message may have been deleted meanwhile: the server's copy wins where it has one.
  const refreshed = mapItems(data, (message) => fresh.get(message.id) ?? message);
  const held = new Set(flattenPages(data).map((message) => message.id));
  const missing = newest.items.filter((message) => !held.has(message.id));
  if (missing.length === 0) return refreshed;

  const oldest = newest.items.at(-1);
  const reachesBack =
    newest.nextCursor === null || (oldest !== undefined && heldBefore.has(oldest.id));
  const [first, ...rest] = refreshed.pages;
  if (reachesBack && first) {
    const items = [...first.items, ...missing].toSorted(newestFirst);
    return { ...refreshed, pages: [{ ...first, items }, ...rest] };
  }

  const newestAt = newest.items[0]?.createdAt ?? '';
  const kept = flattenPages(data).filter(
    (message) => message.status !== undefined || message.createdAt > newestAt,
  );
  return {
    pages: [
      { items: [...kept, ...newest.items].toSorted(newestFirst), nextCursor: newest.nextCursor },
    ],
    pageParams: [NO_CURSOR],
  };
}

/**
 * The socket is back after a gap (dropped connection, refused handshake, server restart):
 * nothing queues pushes for an absent socket, so whatever happened meanwhile is fetched.
 * The list and the conversations refetch; each loaded thread is merged with its newest page
 * (an invalidation would refetch it wholesale and drop the bubbles that only exist here).
 */
export async function resyncConversations(
  queryClient: QueryClient,
  heldBefore: ReadonlySet<string>,
): Promise<void> {
  void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list });
  void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.details });
  const threads = queryClient.getQueriesData<ThreadPages>({
    queryKey: queryKeys.conversations.threads,
  });
  await Promise.all(
    threads.map(async ([queryKey, held]) => {
      const conversationId = queryKey[2];
      // A thread without data is still on its first fetch, which reads the current state.
      if (!held || typeof conversationId !== 'string') return;
      try {
        const newest = await fetchMessages(conversationId, {});
        queryClient.setQueryData<ThreadPages>(
          queryKeys.conversations.messages(conversationId),
          (data) => data && mergeNewestPage(data, newest, heldBefore),
        );
      } catch (error) {
        if (isApiClientError(error) && error.status === 404) {
          forgetConversation(queryClient, conversationId);
        }
      }
    }),
  );
}
