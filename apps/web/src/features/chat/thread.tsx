import { useQueryClient } from '@tanstack/react-query';
import {
  type Conversation,
  MESSAGE_MAX_LENGTH,
  type ReactionType,
  type ReplyRef,
  type StoredImage,
  emojiCount,
  isEmojiOnly,
} from '@beso/shared';
import { cn } from 'cn';
import dayjs from 'dayjs';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  DownloadIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  ReplyIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';
import { type UIEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { EditedMarker } from '@/components/edited-marker';
import { ErrorState } from '@/components/empty-state';
import { InlineEditor } from '@/components/inline-editor';
import { Lightbox } from '@/components/lightbox';
import { LongPressArea } from '@/components/long-press-area';
import { RichText } from '@/components/rich-text';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/features/auth/current-user';
import { type PressAction, ReactionBar, ReactionPicker } from '@/features/comments/reaction-bar';
import { isApiClientError } from '@/lib/api/client';
import { fetchMessageRevisions } from '@/lib/api/conversations';
import { savePicture } from '@/lib/download';
import { formatDateTime, formatDayLabel, formatTime } from '@/lib/format';
import { flattenPages } from '@/lib/infinite';
import { firstName } from '@/lib/names';
import { queryKeys } from '@/lib/query-keys';
import { useChat } from './chat-context';
import { SharedPostCard } from './shared-post-card';
import { ConversationAvatar } from './conversation-avatar';
import {
  attachmentWord,
  conversationName,
  directPeer,
  isAdmin,
  memberById,
  quoteOf,
  reactionSummaryOf,
  replyQuoteText,
  seenText,
  systemLineText,
  typingText,
} from './conversation-display';
import { GroupMembersDialog } from './group-members-dialog';
import { GroupTitleEditor } from './group-title-editor';
import {
  type ThreadMessage,
  appendToThread,
  markFailedInThread,
  removeFromThread,
  replaceInThread,
  replaceMessage,
  upsertConversation,
} from './message-cache';
import { MessageComposer, type OutgoingMessage } from './message-composer';
import { PresenceDot } from './presence-dot';
import { TypingIndicator } from './typing-indicator';
import { useDeleteMessage, useMessages } from './use-conversations';
import { useEditMessage, useReactToMessage } from './use-message-actions';
import { VoiceNote } from './voice/voice-note';
import { voicePlayer } from './voice/voice-player';

const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 80;
const LOAD_OLDER_PX = 200;

type ThreadProps = {
  conversation: Conversation;
  /** Inside a chat window, which brings its own header. */
  embedded?: boolean;
  className?: string;
};

export function Thread({ conversation, embedded = false, className }: ThreadProps) {
  const me = useCurrentUser();
  const chat = useChat();
  const queryClient = useQueryClient();
  const thread = useMessages(conversation.id);
  const messages = useMemo(() => flattenPages(thread.data).toReversed(), [thread.data]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // While an older page loads: a message on screen and how far below the top of the view it
  // sits, so the view can be put back once the page is in above it.
  const anchor = useRef<{ element: Element; offset: number } | null>(null);
  // Messages from others that arrived while the viewer was scrolled up, offered as a pill.
  const [newBelow, setNewBelow] = useState(0);
  const [renaming, setRenaming] = useState(false);
  // The message the composer answers ("Reply" on a bubble), until it is sent or cancelled.
  const [replyTo, setReplyTo] = useState<ThreadMessage | null>(null);
  const { activateConversation, markRead, setTyping } = chat;

  const peer = directPeer(conversation, me.id);
  const name = conversationName(conversation, me.id);
  const admin = conversation.kind === 'group' && isAdmin(conversation, me.id);
  const online = peer ? chat.isOnline(peer.id) : false;
  const typingNames = chat
    .typingIn(conversation.id)
    .map((userId) => memberById(conversation, userId)?.user.name ?? 'Someone');
  const typing = typingText(typingNames);

  useEffect(() => activateConversation(conversation.id), [activateConversation, conversation.id]);
  // A voice message playing in this thread stops when the thread leaves the screen.
  useEffect(() => () => voicePlayer.stopConversation(conversation.id), [conversation.id]);

  // Whatever is still unread gets marked once the thread is on screen.
  const hasUnread = conversation.unreadCount > 0;
  useEffect(() => {
    if (!hasUnread) return undefined;
    const readIfVisible = () => {
      if (document.visibilityState === 'visible') void markRead(conversation.id);
    };
    readIfVisible();
    document.addEventListener('visibilitychange', readIfVisible);
    return () => document.removeEventListener('visibilitychange', readIfVisible);
  }, [hasUnread, markRead, conversation.id]);

  // One announcement per message from somebody else, and none for the history that was
  // already there (or is loaded on scroll-up).
  const [announcement, setAnnouncement] = useState('');
  const newestSeenAt = useRef<string | null>(null);
  useEffect(() => {
    if (thread.isPending) return;
    const latest = messages.at(-1)?.createdAt ?? null;
    if (newestSeenAt.current === null) {
      newestSeenAt.current = latest ?? '';
      return;
    }
    const since = newestSeenAt.current;
    const arrived = messages.filter(
      (message) => message.senderId !== me.id && message.createdAt > since,
    );
    const fresh = arrived.at(-1);
    if (latest && latest > since) newestSeenAt.current = latest;
    if (!fresh) return;
    if (fresh.kind === 'system') {
      if (fresh.system) setAnnouncement(systemLineText(fresh.system, conversation, me.id));
    } else {
      const sender = firstName(memberById(conversation, fresh.senderId)?.user.name ?? 'Someone');
      setAnnouncement(
        `${sender}: ${fresh.content || `sent a ${attachmentWord(fresh).toLowerCase()}`}`,
      );
    }
    // Scrolled up through the history: the new messages wait below, behind a pill.
    const unseen = arrived.filter((message) => message.kind === 'user').length;
    if (!stickToBottom.current && unseen > 0) setNewBelow((count) => count + unseen);
  }, [messages, me.id, conversation, thread.isPending]);

  // Stay pinned to the newest message (or the typing dots) unless the viewer scrolled up.
  const messageCount = messages.length;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if ((messageCount > 0 || typing) && element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messageCount, typing]);

  // ...and through whatever changes a height after the render: a picture whose file arrives,
  // a reaction, the keyboard or a taller composer shrinking the view.
  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return undefined;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  /** Remembers the first message on screen and its distance from the top of the view. */
  const rememberAnchor = () => {
    const element = scrollRef.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const first = Array.from(element.querySelectorAll('ol > li')).find(
      (item) => item.getBoundingClientRect().bottom > top,
    );
    anchor.current = first
      ? { element: first, offset: first.getBoundingClientRect().top - top }
      : null;
  };

  // The older page is in (it lands in the render that ends the fetch) or the attempt is over:
  // the remembered message goes back to where it was on screen. A browser that keeps it there
  // by itself (scroll anchoring) leaves nothing to correct; adding the page's height on top of
  // that used to throw the view a page down.
  const fetchingOlder = thread.isFetchingNextPage;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const kept = anchor.current;
    if (fetchingOlder || !element || !kept) return;
    anchor.current = null;
    if (stickToBottom.current || !kept.element.isConnected) return;
    const top = element.getBoundingClientRect().top;
    element.scrollTop += kept.element.getBoundingClientRect().top - top - kept.offset;
  }, [fetchingOlder]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    stickToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (stickToBottom.current) setNewBelow((count) => (count === 0 ? count : 0));
    if (thread.isFetchingNextPage) {
      // Scrolling on while the page loads: keep what is on screen now, not what was.
      if (anchor.current) rememberAnchor();
    } else if (element.scrollTop < LOAD_OLDER_PX && thread.hasNextPage) {
      rememberAnchor();
      void thread.fetchNextPage();
    }
  };

  const jumpToNewest = () => {
    const element = scrollRef.current;
    stickToBottom.current = true;
    setNewBelow(0);
    if (element) element.scrollTop = element.scrollHeight;
  };

  const send = async (outgoing: OutgoingMessage, retryOf?: string) => {
    if (retryOf) removeFromThread(queryClient, conversation.id, retryOf);
    const temp: ThreadMessage = {
      id: `pending-${crypto.randomUUID()}`,
      conversationId: conversation.id,
      senderId: me.id,
      kind: 'user',
      content: outgoing.content,
      image: outgoing.previewUrl
        ? {
            url: outgoing.previewUrl,
            width: outgoing.previewSize?.width ?? null,
            height: outgoing.previewSize?.height ?? null,
          }
        : null,
      imageUrl: outgoing.previewUrl ?? null,
      imageKey: outgoing.imageKey,
      voice: outgoing.voice ?? null,
      voiceKey: outgoing.voiceKey,
      sharedPost: null,
      replyTo: outgoing.replyTo ?? null,
      editedAt: null,
      deletedAt: null,
      system: null,
      reactions: [],
      createdAt: new Date().toISOString(),
      status: 'sending',
    };
    stickToBottom.current = true;
    appendToThread(queryClient, conversation.id, temp);
    try {
      const message = await chat.sendMessage(conversation.id, {
        content: outgoing.content,
        imageKey: outgoing.imageKey,
        voiceKey: outgoing.voiceKey,
        voicePeaks: outgoing.voice?.peaks,
        replyToId: outgoing.replyTo?.id,
      });
      replaceInThread(queryClient, conversation.id, temp.id, message);
      upsertConversation(queryClient, message, { countUnread: false });
      // The bubble shows the server's copy now. A failed one keeps the preview for "Retry".
      if (outgoing.previewUrl) URL.revokeObjectURL(outgoing.previewUrl);
      if (outgoing.voice) URL.revokeObjectURL(outgoing.voice.url);
    } catch (error) {
      markFailedInThread(queryClient, conversation.id, temp.id);
      toast.error(isApiClientError(error) ? error.message : 'Could not send the message');
    }
  };

  const subtitle = typing
    ? conversation.kind === 'direct'
      ? 'typing…'
      : typing
    : peer
      ? online
        ? 'Online'
        : `@${peer.username}`
      : `${conversation.members.length} members`;

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {embedded ? null : (
        <header className="flex items-center gap-3 border-b px-3 py-2.5">
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Back to conversations"
          >
            <Link to="/messages">
              <ArrowLeftIcon />
            </Link>
          </Button>
          {peer ? (
            <Link
              to={`/u/${peer.username}`}
              className="relative shrink-0"
              aria-hidden="true"
              tabIndex={-1}
            >
              <ConversationAvatar conversation={conversation} meId={me.id} />
              <PresenceDot online={online} />
            </Link>
          ) : (
            <ConversationAvatar conversation={conversation} meId={me.id} />
          )}
          <div className="min-w-0 flex-1">
            {renaming ? (
              <GroupTitleEditor conversation={conversation} onDone={() => setRenaming(false)} />
            ) : (
              <>
                <h2 className="truncate font-semibold">
                  {peer ? (
                    <Link to={`/u/${peer.username}`} className="hover:underline">
                      {name}
                    </Link>
                  ) : (
                    name
                  )}
                </h2>
                <p
                  className={cn(
                    'truncate text-xs',
                    typing ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  {subtitle}
                </p>
              </>
            )}
          </div>
          {admin && !renaming ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Rename group"
              onClick={() => setRenaming(true)}
            >
              <PencilIcon />
            </Button>
          ) : null}
          {conversation.kind === 'group' ? (
            <GroupMembersDialog conversation={conversation}>
              <Button variant="ghost" size="icon-sm" aria-label="Group members">
                <UsersIcon />
              </Button>
            </GroupMembersDialog>
          ) : null}
        </header>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          // `overscroll-contain`: the end of the history does not hand the swipe on to the page
          // (which would move the whole layout, or pull to refresh on a phone).
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
          tabIndex={0}
          role="log"
          aria-label={peer ? `Conversation with ${name}` : `Group ${name}`}
          // Off: with the default "polite" every page of history, every optimistic bubble and
          // every "Sending…"/"Seen" swap would be read out. New messages from others are
          // announced once, through the status line below the log.
          aria-live="off"
        >
          <div ref={contentRef}>
            {thread.isPending ? (
              <ThreadSkeleton />
            ) : thread.isError ? (
              <ErrorState
                message="Could not load this conversation."
                onRetry={() => void thread.refetch()}
              />
            ) : (
              <>
                {messages.length === 0 ? (
                  <p className="text-muted-foreground py-10 text-center text-sm">
                    {peer
                      ? `This is the beginning of your conversation with ${name}.`
                      : `This is the beginning of ${name}. Say hi to everyone.`}
                  </p>
                ) : (
                  <MessageList
                    messages={messages}
                    meId={me.id}
                    conversation={conversation}
                    onReply={setReplyTo}
                    onRetry={(message) =>
                      void send(
                        {
                          content: message.content,
                          imageKey: message.imageKey,
                          previewUrl: message.image?.url,
                          previewSize: message.image ?? undefined,
                          voiceKey: message.voiceKey,
                          voice: message.voice ?? undefined,
                          replyTo:
                            message.replyTo && 'id' in message.replyTo
                              ? message.replyTo
                              : undefined,
                        },
                        message.id,
                      )
                    }
                  />
                )}
                {typing ? <TypingIndicator text={typing} className="mt-1" /> : null}
              </>
            )}
          </div>
        </div>
        {thread.isFetchingNextPage ? (
          // Over the history rather than in it, so nothing on screen moves while it loads.
          <div className="bg-card text-muted-foreground absolute top-2 left-1/2 flex -translate-x-1/2 rounded-full border p-1.5 shadow-sm">
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            <span className="sr-only">Loading older messages</span>
          </div>
        ) : null}
        {newBelow > 0 ? (
          <Button
            type="button"
            size="sm"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
            aria-label={`${newBelow} new ${newBelow === 1 ? 'message' : 'messages'}, scroll to ${newBelow === 1 ? 'it' : 'them'}`}
            onClick={jumpToNewest}
          >
            <ArrowDownIcon /> {newBelow} new {newBelow === 1 ? 'message' : 'messages'}
          </Button>
        ) : null}
      </div>

      <output aria-live="polite" className="sr-only block">
        {announcement}
      </output>

      <MessageComposer
        recipientName={name}
        onSend={(outgoing) => {
          void send({ ...outgoing, replyTo: replyTo ? quoteOf(replyTo) : undefined });
          setReplyTo(null);
        }}
        onTyping={(isTyping) => setTyping(conversation.id, isTyping)}
        replyingTo={
          replyTo
            ? {
                id: replyTo.id,
                name:
                  replyTo.senderId === me.id
                    ? 'yourself'
                    : (memberById(conversation, replyTo.senderId)?.user.name ?? 'a former member'),
                text: replyQuoteText(quoteOf(replyTo), replyTo),
              }
            : null
        }
        onCancelReply={() => setReplyTo(null)}
      />
    </div>
  );
}

type MessageListProps = {
  messages: ThreadMessage[];
  meId: string;
  conversation: Conversation;
  onRetry: (message: ThreadMessage) => void;
  onReply: (message: ThreadMessage) => void;
};

const isSystem = (message: ThreadMessage | undefined): boolean => message?.kind === 'system';

/** Up to this many emoji, a message of emoji only goes without its bubble. */
const BARE_EMOJI_MAX = 3;

function MessageList({ messages, meId, conversation, onRetry, onReply }: MessageListProps) {
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLOListElement>(null);
  // The original a quote was pressed on, ringed for a moment once it is scrolled to.
  const [flashed, setFlashed] = useState<string | null>(null);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const jumpTo = (id: string) => {
    const target = listRef.current?.querySelector(`[data-message-id="${id}"]`);
    if (!target) {
      toast('That message is further up: scroll to load it');
      return;
    }
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    setFlashed(id);
    window.setTimeout(() => setFlashed((current) => (current === id ? null : current)), 1600);
  };
  const deleteMessage = useDeleteMessage(conversation.id);
  const editMessage = useEditMessage(conversation.id);
  const react = useReactToMessage(conversation.id);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // A press-and-hold on a bubble opens the reaction picker over it, as native apps do.
  const [pressed, setPressed] = useState<{ id: string; element: HTMLElement } | null>(null);
  // The viewer pages through every picture of the loaded thread, oldest first; it follows the
  // message on screen, so history loading in above does not swap the picture.
  const [viewing, setViewing] = useState<string | null>(null);
  const pictures = useMemo(
    () =>
      messages.flatMap((m) =>
        m.image ? [{ id: m.id, senderId: m.senderId, image: m.image }] : [],
      ),
    [messages],
  );
  const pictureImages = useMemo<StoredImage[]>(() => pictures.map((p) => p.image), [pictures]);
  const viewingIndex = pictures.findIndex((p) => p.id === viewing);
  const lastMine = messages.findLast(
    (m) => m.senderId === meId && !m.status && m.kind === 'user' && m.deletedAt === null,
  );
  const seen = lastMine ? seenText(conversation, meId, lastMine.createdAt) : null;
  const showSeenOn = seen ? lastMine?.id : undefined;
  const isGroup = conversation.kind === 'group';
  const senderName = (userId: string) =>
    memberById(conversation, userId)?.user.name ?? 'A former member';
  const sentByOf = (userId: string) => (userId === meId ? 'you' : senderName(userId));

  const confirmDelete = () => {
    if (!deleting) return;
    deleteMessage.mutate(deleting, {
      onSuccess: (message) => replaceMessage(queryClient, message),
      onError: (error) =>
        toast.error(isApiClientError(error) ? error.message : 'Could not delete the message'),
    });
    setDeleting(null);
  };

  const saveEdit = (messageId: string, content: string) =>
    editMessage.mutate(
      { messageId, content },
      {
        onSuccess: () => setEditing(null),
        onError: (error) =>
          toast.error(isApiClientError(error) ? error.message : 'Could not save the message'),
      },
    );

  return (
    <ol ref={listRef} className="flex flex-col gap-0.5">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const next = messages[index + 1];
        const mine = message.senderId === meId;
        const sentBy = sentByOf(message.senderId);
        const newDay = !previous || !dayjs(previous.createdAt).isSame(message.createdAt, 'day');
        if (message.kind === 'system') {
          return (
            <li key={message.id} className="flex flex-col items-center">
              {newDay ? (
                <div className="text-muted-foreground my-3 w-full text-center text-xs font-medium">
                  {formatDayLabel(message.createdAt)}
                </div>
              ) : null}
              <p
                className="text-muted-foreground my-1.5 max-w-[85%] text-center text-xs"
                title={formatDateTime(message.createdAt)}
              >
                {message.system ? systemLineText(message.system, conversation, meId) : null}
              </p>
            </li>
          );
        }
        // System lines break a run of messages from one person, like a day does.
        const startOfRun = newDay || isSystem(previous) || previous?.senderId !== message.senderId;
        const endOfGroup =
          !next ||
          isSystem(next) ||
          next.senderId !== message.senderId ||
          dayjs(next.createdAt).diff(message.createdAt) > GROUP_GAP_MS;
        const deleted = message.deletedAt !== null;
        // Persisted and still there: anyone may react to it; its sender may edit or delete it.
        const settled = !deleted && !message.status;
        const canManage = mine && settled;
        const isEditing = editing === message.id;
        const reactions = settled ? reactionSummaryOf(message.reactions, meId) : null;
        const onReact = (type: ReactionType | null) => react.mutate({ message, type });
        const picture = settled ? message.image : null;
        // Text under a picture or a post is a caption, inset like the attachment above it.
        const captioned = message.image !== null || message.sharedPost !== null;
        // A few emoji and nothing else stand on their own, large and without the bubble, as in
        // other chat apps; a reply (its quote needs the frame) or a failed send keeps it.
        const emoji =
          !deleted &&
          !isEditing &&
          !captioned &&
          message.replyTo === null &&
          message.status !== 'failed' &&
          isEmojiOnly(message.content)
            ? emojiCount(message.content)
            : 0;
        const bare = emoji > 0 && emoji <= BARE_EMOJI_MAX;
        // Under the emojis of a press-and-hold: what the hover toolbar and its menu offer.
        const reply = message.replyTo;
        const pressActions: PressAction[] = [
          ...(settled
            ? [{ label: 'Reply', icon: <ReplyIcon />, onSelect: () => onReply(message) }]
            : []),
          ...(picture
            ? [
                {
                  label: 'Download picture',
                  icon: <DownloadIcon />,
                  onSelect: () => void savePicture(picture.url),
                },
              ]
            : []),
          ...(canManage && !message.voice
            ? [
                {
                  label: 'Edit message',
                  icon: <PencilIcon />,
                  onSelect: () => setEditing(message.id),
                },
              ]
            : []),
          ...(canManage
            ? [
                {
                  label: 'Delete message',
                  icon: <Trash2Icon />,
                  destructive: true,
                  onSelect: () => setDeleting(message.id),
                },
              ]
            : []),
        ];
        return (
          <li
            key={message.id}
            data-message-id={message.id}
            className={cn('group flex flex-col', mine ? 'items-end' : 'items-start')}
          >
            <span className="sr-only">{mine ? 'You' : senderName(message.senderId)}: </span>
            {newDay ? (
              <div className="text-muted-foreground my-3 w-full text-center text-xs font-medium">
                {formatDayLabel(message.createdAt)}
              </div>
            ) : null}
            {isGroup && !mine && startOfRun ? (
              <p className="text-muted-foreground mb-0.5 ml-1 text-xs">
                {firstName(senderName(message.senderId))}
              </p>
            ) : null}
            {/* The full width, not shrink-wrapped: the bubble's 78% is of the thread. Around a
                bubble without a toolbar beside it (touch screens, a message on its way) the row
                was the bubble's own width, and short messages became a column of letters. */}
            <div className={cn('flex w-full items-center gap-1', mine && 'flex-row-reverse')}>
              <LongPressArea
                title={formatDateTime(message.createdAt)}
                data-emoji-only={bare ? '' : undefined}
                onLongPress={(element) => {
                  if (settled) setPressed({ id: message.id, element });
                }}
                className={cn(
                  'max-w-[78%] rounded-2xl break-words whitespace-pre-wrap',
                  bare
                    ? cn('px-0.5', emoji === 1 ? 'text-5xl/tight' : 'text-4xl/tight')
                    : cn(
                        'text-[15px]/5',
                        message.image || message.sharedPost
                          ? 'p-1'
                          : message.voice
                            ? 'px-2 py-1.5'
                            : 'px-3.5 py-2',
                        deleted
                          ? 'text-muted-foreground border border-dashed bg-transparent italic'
                          : mine
                            ? 'bg-primary text-primary-foreground rounded-br-md'
                            : 'bg-muted rounded-bl-md',
                      ),
                  isEditing && 'w-[78%]',
                  message.status === 'sending' && 'opacity-70',
                  message.status === 'failed' && 'bg-destructive/15 text-foreground',
                  flashed === message.id && 'ring-primary ring-2 ring-offset-2 ring-offset-card',
                )}
              >
                {deleted ? <span className="block">Message deleted</span> : null}
                {reply && !deleted ? (
                  <ReplyQuote
                    reply={reply}
                    loaded={'id' in reply ? byId.get(reply.id) : undefined}
                    senderName={(id) => (id === meId ? 'You' : senderName(id))}
                    mine={mine}
                    inset={captioned}
                    onJump={jumpTo}
                  />
                ) : null}
                {message.image ? (
                  <button
                    type="button"
                    aria-label={`Open picture sent by ${sentBy}`}
                    aria-haspopup="dialog"
                    // A tap opens it; a hold is the message's (reactions, download).
                    data-long-press=""
                    className="block cursor-zoom-in overflow-hidden rounded-xl focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    onClick={() => setViewing(message.id)}
                  >
                    <img
                      src={message.image.url}
                      // The size reserves the bubble's shape before the file arrives (D2).
                      width={message.image.width ?? undefined}
                      height={message.image.height ?? undefined}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="max-h-72 w-auto max-w-full object-cover"
                    />
                  </button>
                ) : null}
                {message.sharedPost ? <SharedPostCard post={message.sharedPost} /> : null}
                {message.voice && !deleted ? (
                  <VoiceNote
                    id={message.id}
                    conversationId={conversation.id}
                    voice={message.voice}
                    disabled={message.status === 'sending'}
                  />
                ) : null}
                {isEditing ? (
                  <div className={cn('text-foreground', captioned && 'px-2.5 pt-1.5 pb-1')}>
                    <InlineEditor
                      initial={message.content}
                      maxLength={MESSAGE_MAX_LENGTH}
                      label="Edit message"
                      pending={
                        editMessage.isPending && editMessage.variables?.messageId === message.id
                      }
                      submitOnEnter
                      onSave={(content) => saveEdit(message.id, content)}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                ) : message.content ? (
                  <RichText
                    as="span"
                    text={message.content}
                    className={cn('block', captioned && 'px-2.5 pt-1.5 pb-1')}
                    linkClassName={mine ? 'text-primary-foreground underline' : undefined}
                  />
                ) : null}
              </LongPressArea>
              {settled ? (
                // Fine pointers: shown while the row is hovered, holds keyboard focus or has a
                // menu open. Touch screens: not there at all, the press-and-hold is the way in.
                <div className="pointer-coarse:hidden flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 has-[[data-state=open]]:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Reply"
                    className="text-muted-foreground hover:text-foreground rounded-full"
                    onClick={() => onReply(message)}
                  >
                    <ReplyIcon />
                  </Button>
                  <ReactionPicker
                    mine={reactions?.mine ?? null}
                    onReact={onReact}
                    align={mine ? 'end' : 'start'}
                    pressedOn={pressed?.id === message.id ? pressed.element : null}
                    onClose={() => setPressed(null)}
                    actions={pressActions}
                  />
                  {picture ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Download picture"
                      className="text-muted-foreground hover:text-foreground rounded-full"
                      onClick={() => void savePicture(picture.url)}
                    >
                      <DownloadIcon />
                    </Button>
                  ) : null}
                  {canManage ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Message options"
                          className="text-muted-foreground"
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align={mine ? 'end' : 'start'}>
                        {message.voice ? null : (
                          <DropdownMenuItem onSelect={() => setEditing(message.id)}>
                            <PencilIcon /> Edit message
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeleting(message.id)}
                        >
                          <Trash2Icon /> Delete message
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              ) : null}
            </div>
            {reactions && reactions.total > 0 ? (
              <ReactionBar
                summary={reactions}
                onReact={onReact}
                picker={false}
                className={cn('mt-0.5', mine ? 'mr-1 justify-end' : 'ml-1')}
              />
            ) : null}
            {message.status === 'failed' ? (
              <p className="text-destructive mt-0.5 text-xs">
                Not sent.{' '}
                <button type="button" className="underline" onClick={() => onRetry(message)}>
                  Retry
                </button>
              </p>
            ) : endOfGroup || message.id === showSeenOn || message.editedAt ? (
              <p className="text-muted-foreground mt-0.5 text-xs">
                {message.status === 'sending' ? 'Sending…' : formatTime(message.createdAt)}
                {message.editedAt ? (
                  <>
                    {' · '}
                    <EditedMarker
                      editedAt={message.editedAt}
                      queryKey={queryKeys.revisions.message(message.id)}
                      fetchRevisions={(options) =>
                        fetchMessageRevisions(conversation.id, message.id, options)
                      }
                    />
                  </>
                ) : null}
                {message.id === showSeenOn ? ` · ${seen}` : ''}
              </p>
            ) : null}
          </li>
        );
      })}
      <AlertDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this message?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed for everyone in the conversation. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deleteMessage.isPending}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Lightbox
        images={pictureImages}
        index={viewingIndex === -1 ? null : viewingIndex}
        onIndexChange={(next) => setViewing(next === null ? null : (pictures[next]?.id ?? null))}
        title="Pictures in this conversation"
        alt={(index) => `Sent by ${sentByOf(pictures[index]?.senderId ?? '')}`}
      />
    </ol>
  );
}

type ReplyQuoteProps = {
  reply: ReplyRef;
  /** The original as the thread has it loaded, which wins over the server's quote. */
  loaded: ThreadMessage | undefined;
  senderName: (userId: string) => string;
  mine: boolean;
  /** Above a picture or a post, inside the bubble's narrow padding. */
  inset: boolean;
  onJump: (messageId: string) => void;
};

/** The answered message above a reply; pressing it scrolls to the original and rings it. */
function ReplyQuote({ reply, loaded, senderName, mine, inset, onJump }: ReplyQuoteProps) {
  const frame = cn(
    'mb-1 block w-full rounded-lg border-l-4 px-2.5 py-1 text-left text-xs',
    mine
      ? 'bg-primary-foreground/15 border-primary-foreground/60'
      : 'bg-background/70 border-primary/60',
    inset && 'mx-1 mt-1 w-[calc(100%-0.5rem)]',
  );
  if (!('id' in reply)) {
    return <span className={cn(frame, 'italic opacity-80')}>Original message unavailable</span>;
  }
  const who = senderName(reply.senderId);
  const text = replyQuoteText(reply, loaded);
  return (
    <button
      type="button"
      // A tap jumps to the original; a hold is the reply's own (reactions, options).
      data-long-press=""
      // The visible words are the name ("Reply to" read before them): the spaces between the
      // parts are for that name and collapse between the blocks on screen.
      className={cn(
        frame,
        'whitespace-normal',
        'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
      )}
      onClick={() => onJump(reply.id)}
    >
      <span className="sr-only">Reply to</span> <span className="block font-semibold">{who}</span>{' '}
      <span className="line-clamp-2 block opacity-90">{text}</span>
    </button>
  );
}

function ThreadSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <Skeleton className="h-9 w-2/5 rounded-2xl" />
      <Skeleton className="ml-auto h-9 w-1/2 rounded-2xl" />
      <Skeleton className="h-14 w-3/5 rounded-2xl" />
      <Skeleton className="ml-auto h-9 w-1/3 rounded-2xl" />
    </div>
  );
}
