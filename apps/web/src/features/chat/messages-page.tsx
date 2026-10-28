import { cn } from 'cn';
import { MessageCircleIcon } from 'lucide-react';
import { Navigate, Outlet, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { flattenPages } from '@/lib/infinite';
import { MD_UP, useMediaQuery } from '@/lib/use-media-query';
import { usePageTitle } from '@/lib/use-page-title';
import { ConversationList } from './conversation-list';
import { NewGroupDialog } from './new-group-dialog';
import { NewMessageDialog } from './new-message-dialog';
import { useConversations } from './use-conversations';

/**
 * Two panes from `md` up; on phones the list and the thread take turns. The panel fills what
 * the header (3.5rem and its 1px border) leaves, to the pixel: one more and the page itself
 * scrolls under the thread. On a phone that is the whole screen, edge to edge (the shell drops
 * its padding for it below `md`); from `md` it is a card inside the shell's padding (2 ×
 * 1.5rem). Short enough for the space above a phone's keyboard, which shrinks the viewport
 * (`interactive-widget` in index.html).
 */
export function MessagesPage() {
  const { conversationId, username } = useParams();
  const threadOpen = Boolean(conversationId ?? username);

  return (
    <div className="bg-card flex h-[calc(100svh-3.5rem-1px)] min-h-60 overflow-hidden md:h-[calc(100svh-6.5rem-1px)] md:rounded-xl md:border md:shadow-sm">
      <aside
        aria-label="Conversations"
        className={cn('w-full shrink-0 border-r md:w-80', threadOpen ? 'hidden md:block' : 'block')}
      >
        <ConversationList />
      </aside>
      <section
        aria-label="Conversation"
        className={cn('min-w-0 flex-1', threadOpen ? 'block' : 'hidden md:block')}
      >
        <Outlet />
      </section>
    </div>
  );
}

/**
 * `/messages` itself. With two panes the newest chat opens by itself, as on Messenger's web
 * app (and is read, as a click would read it); on phones the list is the page and this pane
 * stays hidden. Only without a single conversation does it offer to start one.
 */
export function MessagesIndex() {
  usePageTitle('Messages');
  const wide = useMediaQuery(MD_UP);
  const conversations = useConversations();
  const newest = flattenPages(conversations.data)[0];
  if (wide && newest) return <Navigate to={`/messages/${newest.id}`} replace />;
  // Not the empty state for a moment before the list arrives.
  if (wide && conversations.isPending) return null;
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-full">
        <MessageCircleIcon className="size-6" aria-hidden="true" />
      </div>
      <p className="text-foreground font-semibold">Your messages</p>
      <p className="max-w-xs text-sm">Pick a conversation on the left, or start a new one.</p>
      <div className="flex gap-2">
        <NewMessageDialog>
          <Button variant="outline" size="sm">
            New message
          </Button>
        </NewMessageDialog>
        <NewGroupDialog>
          <Button variant="outline" size="sm">
            New group
          </Button>
        </NewGroupDialog>
      </div>
    </div>
  );
}
