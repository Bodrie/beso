import { POST_MAX_IMAGES, POST_MAX_LENGTH, UPLOAD_LIMITS, createPollSchema } from '@beso/shared';
import { cn } from 'cn';
import { ChartBarIcon, ImageIcon } from 'lucide-react';
import { type ChangeEvent, type FormEvent, Suspense, lazy, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CharacterCounter } from '@/components/character-counter';
import { MentionTextarea } from '@/components/mention-textarea';
import { UserAvatar } from '@/components/user-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useCurrentUser } from '@/features/auth/current-user';
import { AttachmentPreview } from '@/features/uploads/attachment-preview';
import { useImageUploads } from '@/features/uploads/use-image-uploads';
import { isApiClientError } from '@/lib/api/client';
import { firstName } from '@/lib/names';
import { EmojiPickerButton } from '@/features/emoji/emoji-picker-button';
import { insertText } from './insert-text';
import type { PollDraft } from './poll-editor';
import { useCreatePost } from './use-post-mutations';

const COUNTER_THRESHOLD = 50;
const BOTH = 'A post has pictures or a poll, not both.';
const NEW_POLL: PollDraft = { options: ['', ''], duration: '1d' };

// Most posts ask nothing: the editor loads when "Poll" is pressed (F3).
const PollEditor = lazy(async () => ({ default: (await import('./poll-editor')).PollEditor }));

export function PostComposer() {
  const me = useCurrentUser();
  const createPost = useCreatePost();
  const images = useImageUploads('post', POST_MAX_IMAGES);
  const [content, setContent] = useState('');
  const [poll, setPoll] = useState<PollDraft | null>(null);
  const [pollProblem, setPollProblem] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollButtonRef = useRef<HTMLButtonElement>(null);

  const trimmed = content.trim();
  const remaining = POST_MAX_LENGTH - content.length;
  const imageKeys = images.items.flatMap((item) =>
    item.status === 'ready' ? [item.upload.key] : [],
  );
  const imagesBusy = imageKeys.length < images.items.length;
  const full = images.items.length >= POST_MAX_IMAGES;
  const canSubmit = trimmed.length > 0 && remaining >= 0 && !imagesBusy && !createPost.isPending;

  const changePoll = (next: PollDraft) => {
    setPoll(next);
    setPollProblem(null);
  };
  const removePoll = () => {
    setPoll(null);
    setPollProblem(null);
    pollButtonRef.current?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const checked = poll ? createPollSchema.safeParse(poll) : null;
    if (checked && !checked.success) {
      setPollProblem(checked.error.issues[0]?.message ?? 'Check the poll');
      return;
    }
    createPost.mutate(
      {
        content: trimmed,
        imageKeys: imageKeys.length > 0 ? imageKeys : undefined,
        poll: checked?.data,
      },
      {
        onSuccess: () => {
          setContent('');
          images.clear();
          setPoll(null);
          toast.success('Posted');
        },
        onError: (error) =>
          toast.error(isApiClientError(error) ? error.message : 'Could not publish the post'),
      },
    );
  };

  const pickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length === 0) return;
    const problem = images.add(files);
    if (problem) toast.error(problem);
  };

  const insertEmoji = (emoji: string) => {
    const element = textareaRef.current;
    const start = element?.selectionStart ?? content.length;
    const end = element?.selectionEnd ?? content.length;
    const next = insertText(content, start, end, emoji);
    setContent(next.value);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <Card className="py-4">
      <form onSubmit={submit}>
        <CardContent className="flex gap-3 px-4">
          <UserAvatar user={me} className="mt-1" />
          <div className="min-w-0 flex-1 space-y-3">
            <MentionTextarea
              ref={textareaRef}
              aria-label="New post"
              placeholder={poll ? 'Ask something…' : `What's on your mind, ${firstName(me.name)}?`}
              value={content}
              onValueChange={setContent}
              className="min-h-14 resize-none border-0 bg-transparent px-0 py-2 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
            />

            {poll ? (
              <Suspense fallback={null}>
                <PollEditor
                  value={poll}
                  onChange={changePoll}
                  onRemove={removePoll}
                  problem={pollProblem}
                />
              </Suspense>
            ) : null}

            {images.items.length > 0 ? (
              <div className={cn(images.items.length > 1 && 'grid grid-cols-2 gap-2')}>
                {images.items.map((item, index) => (
                  <AttachmentPreview
                    key={item.id}
                    state={item}
                    position={images.items.length > 1 ? index + 1 : undefined}
                    onRetry={() => images.retry(item.id)}
                    onRemove={() => images.remove(item.id)}
                    imageClassName={images.items.length > 1 ? 'aspect-video max-h-none' : undefined}
                  />
                ))}
              </div>
            ) : null}

            <div className="flex items-center gap-1 border-t pt-3">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={UPLOAD_LIMITS.acceptedTypes.join(',')}
                className="sr-only"
                aria-label="Attach an image"
                tabIndex={-1}
                onChange={pickFiles}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Add image"
                // Stays enabled when full: disabling the focused button would drop the focus.
                onClick={() =>
                  poll
                    ? toast.error(BOTH)
                    : full
                      ? toast.error(`At most ${POST_MAX_IMAGES} pictures per post.`)
                      : fileInputRef.current?.click()
                }
              >
                <ImageIcon />
              </Button>
              <Button
                ref={pollButtonRef}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Poll"
                aria-pressed={poll !== null}
                className={cn(poll && 'text-primary hover:text-primary')}
                onClick={() =>
                  poll
                    ? removePoll()
                    : images.items.length > 0
                      ? toast.error(BOTH)
                      : changePoll(NEW_POLL)
                }
              >
                <ChartBarIcon />
              </Button>
              <EmojiPickerButton onPick={insertEmoji} />
              <span className="flex-1" />
              {remaining <= COUNTER_THRESHOLD ? <CharacterCounter remaining={remaining} /> : null}
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {createPost.isPending ? 'Posting…' : 'Post'}
              </Button>
            </div>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
