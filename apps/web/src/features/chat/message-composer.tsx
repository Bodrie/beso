import {
  MESSAGE_MAX_IMAGES,
  MESSAGE_MAX_LENGTH,
  type ReplyRef,
  UPLOAD_LIMITS,
  type VoiceNote,
} from '@beso/shared';
import { ImageIcon, MicIcon, ReplyIcon, SendIcon, XIcon } from 'lucide-react';
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
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
import { useImageUploads } from '@/features/uploads/use-image-uploads';
import { focusLater } from '@/lib/focus';
import { useTypingSignal } from './use-typing-signal';
import { useVoiceRecorder } from './voice/use-voice-recorder';
import { RecordingBar, VoicePreview } from './voice/voice-composer';
import { canRecordVoice } from './voice/voice-recorder';

/** An uploaded picture on its way out, with what the optimistic bubble shows meanwhile. */
export type OutgoingPicture = {
  key: string;
  /** Local object URL of the picture; the receiver revokes it. */
  previewUrl: string;
  /** The uploaded picture's size, so the optimistic bubble already has its final shape. */
  width: number | null;
  height: number | null;
};

/** What the composer hands over: text, uploaded pictures, or both; or a voice message alone. */
export type OutgoingMessage = {
  content: string;
  /** In the order they were chosen, at most `MESSAGE_MAX_IMAGES`. */
  images?: OutgoingPicture[];
  /** An uploaded voice message (no text, no picture with it). */
  voiceKey?: string;
  /** The clip as the optimistic bubble plays it: a local object URL the receiver revokes. */
  voice?: VoiceNote;
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
  const pictures = useImageUploads('message', MESSAGE_MAX_IMAGES, 'message');
  const voice = useVoiceRecorder();
  const canRecord = useMemo(() => canRecordVoice(), []);
  const typing = useTypingSignal((isTyping) => onTyping?.(isTyping));

  const trimmed = content.trim();
  const remaining = MESSAGE_MAX_LENGTH - content.length;
  const attached = pictures.items.length;
  const ready = pictures.items.flatMap((item): OutgoingPicture[] =>
    item.status === 'ready'
      ? [
          {
            key: item.upload.key,
            previewUrl: item.previewUrl,
            width: item.upload.width,
            height: item.upload.height,
          },
        ]
      : [],
  );
  // One still uploading or failed holds the message back: it goes with all of them or after
  // the failed one was retried or removed.
  const picturesBusy = ready.length < attached;
  const voiceState = voice.state;
  const voiceReady = voiceState.status === 'ready';
  const canSend = voiceReady
    ? !disabled
    : voiceState.status === 'idle' &&
      (trimmed.length > 0 || attached > 0) &&
      remaining >= 0 &&
      !picturesBusy &&
      !disabled;

  const send = () => {
    if (!canSend) return;
    typing.stop();
    if (voiceState.status === 'ready') {
      // A voice message goes alone; whatever is typed waits for the next message.
      onSend({
        content: '',
        voiceKey: voiceState.upload.key,
        voice: {
          url: voiceState.url,
          durationMs: voiceState.upload.durationMs,
          peaks: voiceState.clip.peaks,
        },
      });
      voice.handOver();
      return;
    }
    if (ready.length > 0) {
      onSend({ content: trimmed, images: ready });
      // The thread's optimistic bubble shows the previews from here on and revokes them once
      // the message is confirmed; revoking them now would break the bubble before it renders.
      pictures.handOver();
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

  const pickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length === 0) return;
    const problem = pictures.add(files);
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
      {pictures.items.length === 1 ? (
        pictures.items.map((item) => (
          <AttachmentPreview
            key={item.id}
            state={item}
            onRetry={() => pictures.retry(item.id)}
            onRemove={() => pictures.remove(item.id)}
            className="mb-2 w-fit max-w-full"
            imageClassName="max-h-40 w-auto max-w-full"
          />
        ))
      ) : attached > 1 ? (
        // Several: a strip of thumbnails in the order they go out, scrolled sideways when the
        // row is too narrow for them (the remove buttons take the keyboard along).
        <ul
          aria-label={`${attached} pictures to send`}
          className="mb-2 flex gap-2 overflow-x-auto overscroll-x-contain pb-1"
        >
          {pictures.items.map((item, index) => (
            <li key={item.id} className="shrink-0">
              <AttachmentPreview
                state={item}
                position={index + 1}
                compact
                onRetry={() => pictures.retry(item.id)}
                onRemove={() => pictures.remove(item.id)}
                className="size-20"
                imageClassName="size-full max-h-none"
              />
            </li>
          ))}
        </ul>
      ) : null}
      {voiceState.status === 'starting' ||
      voiceState.status === 'recording' ||
      voiceState.status === 'stopping' ? (
        <RecordingBar state={voiceState} onCancel={voice.cancel} onStop={() => void voice.stop()} />
      ) : voiceState.status !== 'idle' ? (
        <VoicePreview
          state={voiceState}
          canSend={canSend}
          onDiscard={voice.discard}
          onRetry={voice.retry}
        />
      ) : (
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={UPLOAD_LIMITS.acceptedTypes.join(',')}
            className="sr-only"
            aria-label="Attach pictures"
            tabIndex={-1}
            onChange={pickFiles}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={attached > 0 ? 'Add more pictures' : 'Add pictures'}
            disabled={disabled}
            onClick={() =>
              attached >= MESSAGE_MAX_IMAGES
                ? toast.error(`At most ${MESSAGE_MAX_IMAGES} pictures per message.`)
                : fileInputRef.current?.click()
            }
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
          {canRecord ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Record a voice message"
              // A voice message goes alone, so not while pictures are attached.
              disabled={disabled || attached > 0}
              onClick={() => void voice.start()}
            >
              <MicIcon />
            </Button>
          ) : null}
          <Button type="submit" size="icon-sm" aria-label="Send" disabled={!canSend}>
            <SendIcon />
          </Button>
        </div>
      )}
    </form>
  );
}
