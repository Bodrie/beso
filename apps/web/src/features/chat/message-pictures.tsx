import type { StoredImage } from '@beso/shared';
import { cn } from 'cn';
import { ImagesIcon } from 'lucide-react';

type MessagePicturesProps = {
  /** In the sender's order; the caller renders nothing for a message without any. */
  images: readonly StoredImage[];
  /** "you" or the sender's name, which ends the button's name. */
  sentBy: string;
  /** Opens the viewer on the picture at that place in the message. */
  onOpen: (index: number) => void;
};

const focusRing =
  'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none cursor-zoom-in';

/**
 * How the cards of a pile lie, the top one first: it is straight, the two under it lean out to
 * either side, a little further while the pile is pointed at. Their frame leaves the room the
 * leaning takes, so nothing reaches past the bubble.
 */
const PILE = [
  '',
  'rotate-6 translate-x-[5%] group-hover/pile:rotate-[8deg] group-hover/pile:translate-x-[7%]',
  '-rotate-6 -translate-x-[5%] group-hover/pile:-rotate-[8deg] group-hover/pile:-translate-x-[7%]',
] as const;

/**
 * The pictures of a chat message (ADR 0009 amendment "several pictures"). One shows in its own
 * proportions; several lie as a pile, the first on top with the next two behind it and their
 * number on a tag, and a press opens the viewer on the first, which pages through the rest.
 */
export function MessagePictures({ images, sentBy, onOpen }: MessagePicturesProps) {
  const [first] = images;
  if (!first) return null;
  if (images.length === 1) {
    return (
      <button
        type="button"
        aria-label={`Open picture sent by ${sentBy}`}
        aria-haspopup="dialog"
        // A tap opens it; a hold is the message's (reactions, download).
        data-long-press=""
        className={cn('block overflow-hidden rounded-xl', focusRing)}
        onClick={() => onOpen(0)}
      >
        <img
          src={first.url}
          // The size reserves the bubble's shape before the file arrives (D2).
          width={first.width ?? undefined}
          height={first.height ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          className="max-h-72 w-auto max-w-full object-cover"
        />
      </button>
    );
  }
  // Drawn from the bottom of the pile up, so the first picture is painted last, on top.
  const cards = images.slice(0, PILE.length).map((image, index) => ({ image, index }));
  return (
    <button
      type="button"
      aria-label={`Open ${images.length} pictures sent by ${sentBy}`}
      aria-haspopup="dialog"
      data-long-press=""
      data-picture-pile=""
      className={cn(
        'group/pile relative block aspect-square w-60 max-w-full rounded-xl',
        focusRing,
      )}
      onClick={() => onOpen(0)}
    >
      {cards.toReversed().map(({ image, index }) => (
        <span
          key={image.url}
          className={cn(
            'border-background bg-muted absolute inset-x-[11%] inset-y-[7%] overflow-hidden rounded-xl border-2 shadow-md',
            'transition-transform duration-200 motion-reduce:transition-none',
            PILE[index],
          )}
        >
          <img
            src={image.url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className="size-full object-cover"
          />
        </span>
      ))}
      <span className="bg-scrim text-scrim-foreground absolute right-[15%] bottom-[11%] flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
        <ImagesIcon className="size-3.5" aria-hidden="true" />
        {images.length}
      </span>
    </button>
  );
}
