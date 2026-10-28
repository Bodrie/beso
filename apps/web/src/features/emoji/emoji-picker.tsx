import { cn } from 'cn';
import {
  EmojiPicker,
  type EmojiPickerListCategoryHeaderProps,
  type EmojiPickerListEmojiProps,
  type EmojiPickerListRowProps,
} from 'frimousse';
import { useState } from 'react';
import { resolveEmojiData } from './emoji-data';
import { type RecentEmoji, recentEmoji, rememberEmoji } from './recent-emoji';

type EmojiPickerPanelProps = { onPick: (emoji: string) => void };

const COLUMNS = 9;
const CELL =
  'flex size-8 shrink-0 items-center justify-center rounded-md text-xl hover:bg-accent focus-visible:bg-accent focus-visible:outline-none data-active:bg-accent';
const EMOJI_FONT = { fontFamily: 'var(--frimousse-emoji-font)' };

function CategoryHeader({ category, className, ...props }: EmojiPickerListCategoryHeaderProps) {
  return (
    <div
      {...props}
      className={cn(
        'bg-popover text-muted-foreground px-3 pt-3 pb-1.5 text-xs font-medium',
        className,
      )}
    >
      {category.label}
    </div>
  );
}

function Row({ className, ...props }: EmojiPickerListRowProps) {
  return <div {...props} className={cn('scroll-my-1.5 px-1.5', className)} />;
}

function Emoji({ emoji, className, ...props }: EmojiPickerListEmojiProps) {
  return (
    <button type="button" {...props} className={cn(CELL, className)}>
      {emoji.emoji}
    </button>
  );
}

/**
 * Loaded lazily (see EmojiPickerButton): frimousse and the emoji data reach the browser once
 * someone opens it. Headless, so the tokens dress it in both themes; the rows are virtualised,
 * so opening it costs the rows on screen, not the whole set. Native glyphs: no image CDN.
 */
export default function EmojiPickerPanel({ onPick }: EmojiPickerPanelProps) {
  const [recent, setRecent] = useState(recentEmoji);
  const pick = ({ emoji, label }: RecentEmoji) => {
    setRecent(rememberEmoji({ emoji, label }));
    onPick(emoji);
  };
  return (
    <EmojiPicker.Root
      onEmojiSelect={pick}
      resolveEmojiData={resolveEmojiData}
      columns={COLUMNS}
      className="flex h-90 w-80 max-w-[calc(100vw-2rem)] flex-col"
    >
      <div className="border-b p-2">
        <EmojiPicker.Search
          aria-label="Search emoji"
          placeholder="Search emoji"
          className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none focus-visible:ring-[3px] dark:bg-input/30"
        />
      </div>
      {recent.length > 0 ? (
        <fieldset className="border-b px-1.5 pt-2 pb-1.5">
          <legend className="text-muted-foreground px-1.5 pb-1 text-xs font-medium">
            Recently used
          </legend>
          <div className="flex flex-wrap">
            {recent.map((item) => (
              <button
                key={item.emoji}
                type="button"
                aria-label={item.label}
                className={CELL}
                style={EMOJI_FONT}
                onClick={() => pick(item)}
              >
                {item.emoji}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      <EmojiPicker.Viewport className="relative flex-1 outline-none">
        <EmojiPicker.Loading className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
          Loading…
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
          {({ search }) => `No emoji for “${search}”`}
        </EmojiPicker.Empty>
        <EmojiPicker.List
          className="pb-1.5 select-none"
          components={{ CategoryHeader, Row, Emoji }}
        />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}
