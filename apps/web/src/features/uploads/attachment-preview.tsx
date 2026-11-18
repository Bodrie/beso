import { cn } from 'cn';
import { Loader2Icon, RotateCwIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ImageUploadState } from './use-image-upload';

type AttachmentPreviewProps = {
  state: Exclude<ImageUploadState, { status: 'idle' }>;
  onRetry: () => void;
  onRemove: () => void;
  /** Numbers the preview and its buttons when a composer holds several (1-based). */
  position?: number;
  /** A thumbnail in a strip: a failure shows as a retry button over it, the reason as its title. */
  compact?: boolean;
  className?: string;
  imageClassName?: string;
};

/** The picture a composer is about to send: local preview, upload progress, failure with retry. */
export function AttachmentPreview({
  state,
  onRetry,
  onRemove,
  position,
  compact = false,
  className,
  imageClassName,
}: AttachmentPreviewProps) {
  const suffix = position === undefined ? '' : ` ${position}`;
  return (
    <div className={cn('relative overflow-hidden rounded-lg border', className)}>
      <img
        src={state.previewUrl}
        alt={`Attachment preview${suffix}`}
        className={cn(
          'max-h-80 w-full object-cover',
          state.status === 'uploading' && 'opacity-60',
          imageClassName,
        )}
      />
      {state.status === 'uploading' ? (
        <div className="bg-background/40 absolute inset-0 flex items-center justify-center">
          <Loader2Icon
            className={cn('animate-spin', compact ? 'size-5' : 'size-6')}
            aria-hidden="true"
          />
          <span className="sr-only">Uploading image{suffix}</span>
        </div>
      ) : null}
      {state.status === 'error' && compact ? (
        <div className="bg-background/70 absolute inset-0 flex items-end justify-center pb-1.5">
          <Button
            type="button"
            size="xs"
            variant="destructive"
            title={state.message}
            onClick={onRetry}
          >
            <RotateCwIcon />
            Retry<span className="sr-only">{suffix}</span>
          </Button>
          <span className="sr-only">{state.message}</span>
        </div>
      ) : null}
      {state.status === 'error' && !compact ? (
        <div className="bg-destructive absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 px-3 py-2 text-sm text-white">
          <span>{state.message}</span>
          <Button type="button" size="xs" variant="secondary" onClick={onRetry}>
            Retry<span className="sr-only">{suffix}</span>
          </Button>
        </div>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        size="icon-xs"
        className={cn('absolute rounded-full shadow', compact ? 'top-1 right-1' : 'top-2 right-2')}
        aria-label={`Remove image${suffix}`}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </div>
  );
}
