import type { VoiceNote as VoiceNoteData } from '@beso/shared';
import { cn } from 'cn';
import { DownloadIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { formatDuration } from '@/lib/format';
import { canPlayVoice, useVoicePlayer, voicePlayer } from './voice-player';

type VoiceNoteProps = {
  /** The message's id: what the shared player is keyed by. */
  id: string;
  conversationId: string;
  voice: VoiceNoteData;
  /** Not playable yet (a clip on its way to the server). */
  disabled?: boolean;
  className?: string;
};

/** Bars shown for a clip whose recorder measured nothing (an old browser, a muted mic). */
const FLAT_BARS = Array.from({ length: 32 }, () => 0.2);
const STEP_MS = 1000;
const BIG_STEP_MS = 5000;

const spoken = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
};

/**
 * A voice message in a bubble (ADR 0009 amendment "voice messages"): play or pause, the
 * waveform that fills as it plays and takes a click or the arrow keys to seek, and the time
 * left. One clip plays at a time across the app (`voicePlayer`).
 */
export function VoiceNote({
  id,
  conversationId,
  voice,
  disabled = false,
  className,
}: VoiceNoteProps) {
  const { playing, positionMs, failed } = useVoicePlayer(id);
  const playable = useMemo(() => canPlayVoice(), []);
  const durationMs = voice.durationMs;
  const shownMs = playing || positionMs > 0 ? Math.max(0, durationMs - positionMs) : durationMs;

  if (!playable) {
    return (
      <div className={cn('flex items-center gap-2 text-sm', className)}>
        <span>Voice message · {formatDuration(durationMs)}</span>
        <a
          href={voice.url}
          download
          className="inline-flex items-center gap-1 underline"
          aria-label="Download voice message"
        >
          <DownloadIcon className="size-4" aria-hidden="true" />
        </a>
        <span className="sr-only">Your browser cannot play voice messages yet.</span>
      </div>
    );
  }

  return (
    <div className={cn('flex w-56 max-w-full items-center gap-1.5', className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0 rounded-full hover:bg-current/15"
        aria-label={playing ? 'Pause voice message' : `Play voice message, ${spoken(durationMs)}`}
        disabled={disabled}
        onClick={() => {
          if (playing) voicePlayer.pause();
          else voicePlayer.play(id, conversationId, voice.url);
        }}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <Waveform
        peaks={voice.peaks.length > 0 ? voice.peaks : FLAT_BARS}
        durationMs={durationMs}
        positionMs={positionMs}
        disabled={disabled}
        onSeek={(ms) => voicePlayer.seek(id, conversationId, voice.url, ms)}
      />
      <span className="w-9 shrink-0 text-right text-xs tabular-nums" aria-hidden="true">
        {formatDuration(shownMs)}
      </span>
      {failed ? <span className="sr-only">The voice message could not be played.</span> : null}
    </div>
  );
}

type WaveformProps = {
  peaks: readonly number[];
  durationMs: number;
  positionMs: number;
  disabled: boolean;
  onSeek: (positionMs: number) => void;
};

/** The bars, and a slider for assistive technology and the keyboard over them. */
function Waveform({ peaks, durationMs, positionMs, disabled, onSeek }: WaveformProps) {
  const ref = useRef<HTMLDivElement>(null);
  const fraction = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const clamp = (ms: number) => Math.max(0, Math.min(durationMs, ms));

  const seekTo = (event: PointerEvent<HTMLDivElement>) => {
    const element = ref.current;
    if (disabled || !element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0) return;
    const at = (event.clientX - rect.left) / rect.width;
    onSeek(Math.round(clamp(at * durationMs)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = event.shiftKey ? BIG_STEP_MS : STEP_MS;
    const moves: Record<string, number | undefined> = {
      ArrowLeft: positionMs - step,
      ArrowDown: positionMs - step,
      ArrowRight: positionMs + step,
      ArrowUp: positionMs + step,
      Home: 0,
      End: durationMs,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onSeek(Math.round(clamp(next)));
  };

  // A range input cannot draw the waveform; this carries the whole slider contract instead
  // (value, text, the arrow keys, Home and End), and the bars are presentation.
  /* oxlint-disable jsx-a11y/prefer-tag-over-role */
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Position in voice message"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs / 1000)}
      aria-valuenow={Math.round(positionMs / 1000)}
      aria-valuetext={`${formatDuration(positionMs)} of ${formatDuration(durationMs)}`}
      aria-disabled={disabled || undefined}
      aria-orientation="horizontal"
      className={cn(
        'flex h-8 min-w-0 flex-1 touch-none items-center gap-px rounded outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50',
        disabled ? 'cursor-default' : 'cursor-pointer',
      )}
      onPointerDown={seekTo}
      onKeyDown={onKeyDown}
    >
      {peaks.map((peak, index) => (
        <span
          // The bars are positional; a clip's peaks never reorder.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          aria-hidden="true"
          className="min-w-px flex-1 rounded-full bg-current"
          style={{
            height: `${Math.max(12, Math.round(peak * 100))}%`,
            opacity: (index + 1) / peaks.length <= fraction ? 1 : 0.35,
          }}
        />
      ))}
    </div>
  );
}
/* oxlint-enable jsx-a11y/prefer-tag-over-role */
