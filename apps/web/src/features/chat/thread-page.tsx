import { hashKey, useQueryClient } from '@tanstack/react-query';
import { MessageSquareOffIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, ErrorState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/features/auth/current-user';
import { isApiClientError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';
import { usePageTitle } from '@/lib/use-page-title';
import { conversationName } from './conversation-display';
import { Thread } from './thread';
import { useConversation } from './use-conversations';

/**
 * Removed from the conversation while reading it (`conversation:removed` forgets its cache):
 * leave for the list at once, instead of a 404 on the next send (review L10). A sign-out drops
 * the same queries, but with no viewer left, and is not this.
 */
function useLeaveWhenForgotten(conversationId: string): void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    const hash = hashKey(queryKeys.conversations.detail(conversationId));
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'removed' || event.query.queryHash !== hash) return;
      if (!queryClient.getQueryData(queryKeys.me)) return;
      toast.info('You are no longer part of this conversation');
      void navigate('/messages', { replace: true });
    });
  }, [conversationId, navigate, queryClient]);
}

/** Loads the conversation in the address, then shows the thread. */
export function ThreadPage() {
  const { conversationId = '' } = useParams();
  const me = useCurrentUser();
  const conversation = useConversation(conversationId);
  useLeaveWhenForgotten(conversationId);
  usePageTitle(
    conversation.data ? `${conversationName(conversation.data, me.id)} · Messages` : 'Messages',
  );

  if (conversation.isPending) {
    return (
      <div className="space-y-3 p-4" aria-hidden="true">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-9 w-2/5 rounded-2xl" />
        <Skeleton className="ml-auto h-9 w-1/2 rounded-2xl" />
      </div>
    );
  }
  if (conversation.isError) {
    const status = isApiClientError(conversation.error) ? conversation.error.status : 0;
    if (status === 404 || status === 400) {
      return (
        <EmptyState
          icon={MessageSquareOffIcon}
          title="This conversation doesn't exist"
          description="It may have been deleted, or you are no longer part of it."
          className="m-4"
          action={
            <Button asChild variant="outline">
              <Link to="/messages">Back to messages</Link>
            </Button>
          }
        />
      );
    }
    return (
      <ErrorState
        className="m-4"
        message="Could not open this conversation."
        onRetry={() => void conversation.refetch()}
      />
    );
  }
  // Keyed by conversation: the rename field, a reply in progress, the draft and the "new
  // messages" pill belong to one thread and must not follow the viewer into the next one.
  return <Thread key={conversation.data.id} conversation={conversation.data} />;
}
