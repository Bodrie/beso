import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AddMembersInput,
  Conversation,
  ConversationRole,
  RenameGroupInput,
  SetGroupPictureInput,
} from '@beso/shared';
import {
  addMembers,
  createGroup,
  deleteMessage,
  ensureDirectConversation,
  fetchConversation,
  fetchConversations,
  fetchMessages,
  leaveGroup,
  removeGroupPicture,
  removeMember,
  renameGroup,
  setGroupPicture,
  setMemberRole,
} from '@/lib/api/conversations';
import { NO_CURSOR, type Pages, filterItems, flattenPages, mapItems } from '@/lib/infinite';
import { queryKeys } from '@/lib/query-keys';

/** The list cache: pages of conversations, most recent activity first. */
export type ConversationPages = Pages<Conversation>;

export const conversationsQueryOptions = infiniteQueryOptions({
  queryKey: queryKeys.conversations.list,
  queryFn: ({ pageParam, signal }) => fetchConversations({ cursor: pageParam, signal }),
  initialPageParam: NO_CURSOR,
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  // Kept current by socket pushes; the refetch is a safety net.
  staleTime: 60 * 1000,
});

export function useConversations() {
  return useInfiniteQuery(conversationsQueryOptions);
}

/** Unread messages across the loaded conversations, for the navigation badge and the tab title. */
export function useUnreadCount(): number {
  const { data } = useInfiniteQuery({
    ...conversationsQueryOptions,
    select: (pages) => flattenPages(pages).reduce((sum, row) => sum + row.unreadCount, 0),
  });
  return data ?? 0;
}

export const conversationQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.conversations.detail(id),
    queryFn: ({ signal }) => fetchConversation(id, signal),
    staleTime: 60 * 1000,
  });

/** One conversation; starts from the list's copy when that is already loaded. */
export function useConversation(id: string) {
  const queryClient = useQueryClient();
  return useQuery({
    ...conversationQueryOptions(id),
    initialData: () =>
      flattenPages(queryClient.getQueryData<ConversationPages>(queryKeys.conversations.list)).find(
        (row) => row.id === id,
      ),
    initialDataUpdatedAt: () =>
      queryClient.getQueryState(queryKeys.conversations.list)?.dataUpdatedAt,
  });
}

export const messagesQueryOptions = (conversationId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.conversations.messages(conversationId),
    queryFn: ({ pageParam, signal }) =>
      fetchMessages(conversationId, { cursor: pageParam, signal }),
    initialPageParam: NO_CURSOR,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: Infinity,
  });

export function useMessages(conversationId: string) {
  return useInfiniteQuery(messagesQueryOptions(conversationId));
}

type Client = ReturnType<typeof useQueryClient>;

/** Replaces the conversation in the loaded list, or puts it on top when it was not there. */
export function putInList(queryClient: Client, conversation: Conversation): void {
  queryClient.setQueryData<ConversationPages>(queryKeys.conversations.list, (pages) => {
    if (!pages) return pages;
    const exists = flattenPages(pages).some((row) => row.id === conversation.id);
    if (exists) return mapItems(pages, (row) => (row.id === conversation.id ? conversation : row));
    return moveToTop(pages, conversation);
  });
}

/** The row that just saw activity goes first, wherever it was (or was not) before. */
export function moveToTop(pages: ConversationPages, conversation: Conversation): ConversationPages {
  const without = filterItems(pages, (row) => row.id !== conversation.id);
  const [first, ...rest] = without.pages;
  if (!first) {
    return { pages: [{ items: [conversation], nextCursor: null }], pageParams: [NO_CURSOR] };
  }
  return { ...without, pages: [{ ...first, items: [conversation, ...first.items] }, ...rest] };
}

export function useEnsureDirect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ensureDirectConversation,
    onSuccess: (conversation) => {
      queryClient.setQueryData(queryKeys.conversations.detail(conversation.id), conversation);
    },
  });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createGroup,
    onSuccess: (conversation) => {
      queryClient.setQueryData(queryKeys.conversations.detail(conversation.id), conversation);
      putInList(queryClient, conversation);
    },
  });
}

/** Mutations that answer with the conversation: the detail and the list row take the fresh copy. */
function useConversationMutation<Input>(mutationFn: (input: Input) => Promise<Conversation>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (conversation) => {
      queryClient.setQueryData(queryKeys.conversations.detail(conversation.id), conversation);
      putInList(queryClient, conversation);
    },
  });
}

export function useAddMembers(conversationId: string) {
  return useConversationMutation((input: AddMembersInput) => addMembers(conversationId, input));
}

/** Admins only. */
export function useRenameGroup(conversationId: string) {
  return useConversationMutation((input: RenameGroupInput) => renameGroup(conversationId, input));
}

/** Admins only: the picture is an upload of kind `group` made by the caller. */
export function useSetGroupPicture(conversationId: string) {
  return useConversationMutation((input: SetGroupPictureInput) =>
    setGroupPicture(conversationId, input),
  );
}

/** Admins only. */
export function useRemoveGroupPicture(conversationId: string) {
  return useConversationMutation(() => removeGroupPicture(conversationId));
}

/** Admins only. */
export function useSetMemberRole(conversationId: string) {
  return useConversationMutation(({ userId, role }: { userId: string; role: ConversationRole }) =>
    setMemberRole(conversationId, userId, role),
  );
}

/** Admins only; the conversation itself arrives through the `conversation:update` push. */
export function useRemoveMember(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => removeMember(conversationId, userId),
    onSuccess: (_, userId) => {
      const drop = (conversation: Conversation): Conversation => ({
        ...conversation,
        members: conversation.members.filter((member) => member.user.id !== userId),
      });
      queryClient.setQueryData<Conversation>(
        queryKeys.conversations.detail(conversationId),
        (conversation) => conversation && drop(conversation),
      );
      queryClient.setQueryData<ConversationPages>(
        queryKeys.conversations.list,
        (pages) => pages && mapItems(pages, (row) => (row.id === conversationId ? drop(row) : row)),
      );
    },
  });
}

/** The sender takes a message back; the thread shows the server's copy ("Message deleted"). */
export function useDeleteMessage(conversationId: string) {
  return useMutation({
    mutationFn: (messageId: string) => deleteMessage(conversationId, messageId),
  });
}

export function useLeaveGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: leaveGroup,
    onSuccess: (_, conversationId) => forgetConversation(queryClient, conversationId),
  });
}

/** Drops every trace of a conversation the viewer is no longer part of. */
export function forgetConversation(queryClient: Client, conversationId: string): void {
  queryClient.setQueryData<ConversationPages>(
    queryKeys.conversations.list,
    (pages) => pages && filterItems(pages, (row) => row.id !== conversationId),
  );
  queryClient.removeQueries({ queryKey: queryKeys.conversations.detail(conversationId) });
  queryClient.removeQueries({ queryKey: queryKeys.conversations.messages(conversationId) });
}
