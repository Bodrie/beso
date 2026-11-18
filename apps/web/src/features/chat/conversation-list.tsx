import type { Conversation } from '@beso/shared';
import { cn } from 'cn';
import { ImageIcon, Loader2Icon, MessageSquarePlusIcon, UsersIcon } from 'lucide-react';
import { NavLink, useParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/features/auth/current-user';
import { formatRelativeTime } from '@/lib/format';
import { flattenPages } from '@/lib/infinite';
import { firstName } from '@/lib/names';
import { useInfiniteScroll } from '@/lib/use-infinite-scroll';
import { useChat } from './chat-context';
import { ConversationAvatar } from './conversation-avatar';
import {
  conversationName,
  directPeer,
  memberById,
  messagePreview,
  typingText,
} from './conversation-display';
import { NewGroupDialog } from './new-group-dialog';
import { NewMessageDialog } from './new-message-dialog';
import { PresenceDot } from './presence-dot';
import { useConversations } from './use-conversations';

export function ConversationList() {
  const conversations = useConversations();
  const rows = flattenPages(conversations.data);
  const sentinelRef = useInfiniteScroll({
    enabled: conversations.hasNextPage && !conversations.isFetchingNextPage,
    onReachEnd: () => void conversations.fetchNextPage(),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h1 className="text-lg font-bold">Messages</h1>
        <div className="flex items-center gap-1">
          <NewGroupDialog>
            <Button size="icon-sm" variant="ghost" aria-label="New group">
              <UsersIcon />
            </Button>
          </NewGroupDialog>
          <NewMessageDialog>
            <Button size="icon-sm" variant="ghost" aria-label="New message">
              <MessageSquarePlusIcon />
            </Button>
          </NewMessageDialog>
        </div>
      </div>
      {conversations.isPending ? (
        <ConversationListSkeleton />
      ) : conversations.isError ? (
        <p className="text-destructive px-4 py-6 text-sm">
          Could not load your conversations.{' '}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => void conversations.refetch()}
          >
            Try again
          </Button>
        </p>
      ) : rows.length === 0 ? (
        <div className="text-muted-foreground px-4 py-10 text-center text-sm">
          <p>No conversations yet.</p>
          <p className="mt-1">Pick someone from the people page or the online list and say hi.</p>
        </div>
      ) : (
        <ul
          aria-label="Conversations"
          tabIndex={0}
          className="min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          {rows.map((conversation) => (
            <ConversationItem key={conversation.id} conversation={conversation} />
          ))}
          {conversations.hasNextPage ? (
            <li ref={sentinelRef} className="text-muted-foreground flex justify-center py-3">
              {conversations.isFetchingNextPage ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                  <span className="sr-only">Loading more conversations</span>
                </>
              ) : null}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function ConversationItem({ conversation }: { conversation: Conversation }) {
  const me = useCurrentUser();
  const { isOnline, typingIn } = useChat();
  const { conversationId } = useParams();
  const { lastMessage, unreadCount } = conversation;
  const peer = directPeer(conversation, me.id);
  const name = conversationName(conversation, me.id);
  const active = conversationId === conversation.id;
  const typing = typingText(
    typingIn(conversation.id).map((userId) => {
      const member = memberById(conversation, userId);
      return member ? firstName(member.user.name) : 'Someone';
    }),
  );
  // A system line reads as a sentence of its own; a deleted message says so without a picture.
  const senderPrefix =
    lastMessage === null || lastMessage.kind === 'system'
      ? ''
      : lastMessage.senderId === me.id
        ? 'You: '
        : conversation.kind === 'group'
          ? `${firstName(memberById(conversation, lastMessage.senderId)?.user.name ?? 'Someone')}: `
          : '';

  return (
    <li>
      <NavLink
        to={`/messages/${conversation.id}`}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-3 px-4 py-3 transition-colors',
          active ? 'bg-accent/60' : 'hover:bg-muted',
        )}
      >
        <span className="relative shrink-0">
          <ConversationAvatar conversation={conversation} meId={me.id} size="lg" />
          {peer ? <PresenceDot online={isOnline(peer.id)} /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={cn('truncate text-sm', unreadCount > 0 ? 'font-bold' : 'font-semibold')}
            >
              {name}
            </span>
            {lastMessage ? (
              <time
                dateTime={lastMessage.createdAt}
                className="text-muted-foreground shrink-0 text-xs"
              >
                {formatRelativeTime(lastMessage.createdAt)}
              </time>
            ) : null}
          </span>
          <span className="flex items-center justify-between gap-2">
            {typing ? (
              <span className="text-primary truncate text-sm">
                {conversation.kind === 'direct' ? 'typing…' : typing}
              </span>
            ) : lastMessage ? (
              <span
                className={cn(
                  'flex min-w-0 items-center gap-1 text-sm',
                  unreadCount > 0 ? 'text-foreground font-medium' : 'text-muted-foreground',
                )}
              >
                <span className="shrink-0">{senderPrefix}</span>
                {lastMessage.images.length > 0 ? (
                  <ImageIcon className="size-3.5 shrink-0" aria-hidden="true" />
                ) : null}
                <span className={cn('truncate', lastMessage.deletedAt && 'italic')}>
                  {messagePreview(lastMessage, conversation, me.id)}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground truncate text-sm">
                {conversation.members.length} members · no messages yet
              </span>
            )}
            {unreadCount > 0 ? (
              <Badge className="h-5 min-w-5 shrink-0 rounded-full px-1.5 tabular-nums">
                <span className="sr-only">Unread: </span>
                {unreadCount}
              </Badge>
            ) : null}
          </span>
        </span>
      </NavLink>
    </li>
  );
}

function ConversationListSkeleton() {
  return (
    <div className="divide-y" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
      ))}
    </div>
  );
}
