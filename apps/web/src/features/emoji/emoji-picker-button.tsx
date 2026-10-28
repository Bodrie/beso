import { cn } from 'cn';
import { SmileIcon } from 'lucide-react';
import { Suspense, lazy, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';

const EmojiPickerPanel = lazy(() => import('./emoji-picker'));

type EmojiPickerButtonProps = { onPick: (emoji: string) => void; className?: string };

/**
 * "Add emoji" with the picker in a popover: one pick closes it and leaves the focus where the
 * composer puts it (the caret after the emoji), not back on this button. Fine pointers only:
 * a phone's keyboard has an emoji panel that swaps in place, whereas a popover would first
 * close the keyboard and then slide over the composer.
 */
export function EmojiPickerButton({ onPick, className }: EmojiPickerButtonProps) {
  const [open, setOpen] = useState(false);
  const picked = useRef(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Add emoji"
          className={cn('pointer-coarse:hidden', className)}
        >
          <SmileIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto overflow-hidden p-0"
        onCloseAutoFocus={(event) => {
          if (!picked.current) return;
          picked.current = false;
          event.preventDefault();
        }}
      >
        <Suspense fallback={<Skeleton className="h-90 w-80 rounded-none" />}>
          <EmojiPickerPanel
            onPick={(emoji) => {
              picked.current = true;
              setOpen(false);
              onPick(emoji);
            }}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
