import { MESSAGE_MAX_LENGTH, type ReplyRef, UPLOAD_LIMITS } from '@beso/shared';
import { ImageIcon, ReplyIcon, SendIcon, XIcon } from 'lucide-react';
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { CharacterCounter } from '@/components/character-counter';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { EmojiPickerButton } from '@/features/emoji/emoji-picker-button';
import { insertText } from '@/features/posts/insert-text';
import { AttachmentPreview } from '@/features/uploads/attachment-preview';
import { useImageUpload } from '@/features/uploads/use-image-upload';
import { focusLater } from '@/lib/focus';
import { useTypingSignal } from './use-typing-signal';

/** What the composer hands over: text, an uploaded picture, or both. */
export type OutgoingMessage = {
  content: string;
  imageKey?: string;
  /** Local object URL of the picture, for the optimistic bubble; the receiver revokes it. */
  previewUrl?: string;
  /** The uploaded picture's size, so the optimistic bubble already has its final shape. */
  previewSize?: { width: number | null; height: number | null };
  /** The message answered, as the optimistic bubble quotes it (the server sends its own). */
  replyTo?: Extract<ReplyRef, { id: string }>;
};

/** The message being answered, as the bar above the field names it. */
export type ReplyingTo = { id: string; name: string; text: string };

type MessageComposerProps = {
  /** Who or what the message goes to, for the field's accessible name. */
  recipientName: string;
  disabled?: boolean;
  onSend: (message: OutgoingMessage) => void;
  onTyping?: (typing: boolean) => void;
  replyingTo?: ReplyingTo | null;
  onCancelReply?: () => void;
};

export function MessageComposer({
  recipientName,
  disabled,
  onSend,
  onTyping,
  replyingTo = null,
  onCancelReply,
}: MessageComposerProps) {
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const replyBarId = useId();
  const replyingToId = replyingTo?.id;
  // "Reply" on a bubble hands the typing to the field; after the bubble's menu has closed, which
  // gives the focus back to its own trigger first.
  useEffect(() => {
    if (replyingToId) focusLater(textareaRef);
  }, [replyingToId]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const image = useImageUpload('message');
  const typing = useTypingSignal((isTyping) => onTyping?.(isTyping));

  const trimmed = content.trim();
  const remaining = MESSAGE_MAX_LENGTH - content.length;
  const pictureReady = image.state.status === 'ready';
  const pictureBusy = image.state.status === 'uploading' || image.state.status === 'error';
  const canSend =
    (trimmed.length > 0 || pictureReady) && remaining >= 0 && !pictureBusy && !disabled;

  const send = () => {
    if (!canSend) return;
    typing.stop();
    if (image.state.status === 'ready') {
      onSend({
        content: trimmed,
        imageKey: image.state.upload.key,
        previewUrl: image.state.previewUrl,
        previewSize: { width: image.state.upload.width, height: image.state.upload.height },
      });
      // The thread's optimistic bubble shows the preview from here on and revokes it once the
      // message is confirmed; revoking it now would break the bubble before it renders.
      image.handOver();
    } else {
      onSend({ content: trimmed });
    }
    setContent('');
    textareaRef.current?.focus();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setContent(event.target.value);
    if (event.target.value.trim().length > 0) typing.typed();
    else typing.stop();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape' && replyingTo) {
      // Inside a chat window Escape would close the window too; the reply goes first.
      event.preventDefault();
      event.stopPropagation();
      onCancelReply?.();
    }
  };

  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = image.select(file);
    if (problem) toast.error(problem);
  };

  const insertEmoji = (emoji: string) => {
    const element = textareaRef.current;
    const next = insertText(
      content,
      element?.selectionStart ?? content.length,
      element?.selectionEnd ?? content.length,
      emoji,
    );
    setContent(next.value);
    typing.typed();
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <form onSubmit={onSubmit} className="border-t p-3">
      {replyingTo ? (
        <div className="bg-muted border-primary/60 mb-2 flex items-start gap-2 rounded-lg border-l-4 px-3 py-1.5 text-xs">
          <ReplyIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <p id={replyBarId} className="min-w-0 flex-1">
            <span className="block font-semibold">Replying to {replyingTo.name}</span>
            <span className="text-muted-foreground block truncate">{replyingTo.text}</span>
          </p>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Cancel reply"
            onClick={() => {
              onCancelReply?.();
              textareaRef.current?.focus();
            }}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      {image.state.status !== 'idle' ? (
        <AttachmentPreview
          state={image.state}
          onRetry={image.retry}
          onRemove={image.clear}
          className="mb-2 w-fit max-w-full"
          imageClassName="max-h-40 w-auto max-w-full"
        />
      ) : null}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOAD_LIMITS.acceptedTypes.join(',')}
          className="sr-only"
          aria-label="Attach a picture"
          tabIndex={-1}
          onChange={pickFile}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Add picture"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImageIcon />
        </Button>
        <EmojiPickerButton onPick={insertEmoji} />
        <Textarea
          ref={textareaRef}
          aria-label={`Message ${recipientName}`}
          aria-describedby={replyingTo ? replyBarId : undefined}
          placeholder="Write a message…"
          rows={1}
          value={content}
          onChange={onChange}
          onKeyDown={onKeyDown}
          className="max-h-40 min-h-9 flex-1 resize-none py-1.5 text-sm"
        />
        {remaining <= 100 ? <CharacterCounter remaining={remaining} className="pb-2" /> : null}
        <Button type="submit" size="icon-sm" aria-label="Send" disabled={!canSend}>
          <SendIcon />
        </Button>
      </div>
    </form>
  );
}
