import { VOICE_LIMITS } from '@beso/shared';
import { cn } from 'cn';
import { Loader2Icon, SendIcon, SquareIcon, Trash2Icon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDuration } from '@/lib/format';
import type { useVoiceRecorder } from './use-voice-recorder';
import { VoiceNote } from './voice-note';

type Recorder = ReturnType<typeof useVoiceRecorder>;

type RecordingBarProps = {
  state: Extract<Recorder['state'], { status: 'starting' | 'recording' | 'stopping' }>;
  onCancel: () => void;
  onStop: () => void;
};

/** Five bars that follow the microphone's loudness while recording. */
function LevelMeter({ level }: { level: number }) {
  const heights = [0.5, 0.8, 1, 0.8, 0.5].map((weight) => 0.2 + Math.min(1, level * 4) * weight);
  return (
    <span className="flex h-6 items-center gap-0.5" aria-hidden="true">
      {heights.map((height, index) => (
        <span
          // Fixed positions in the meter.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className="bg-primary w-1 rounded-full"
          style={{ height: `${Math.round(height * 100)}%` }}
        />
      ))}
    </span>
  );
}

/** The composer's row while a voice message is being recorded: cancel, the timer, the meter, stop. */
export function RecordingBar({ state, onCancel, onStop }: RecordingBarProps) {
  const recording = state.status === 'recording';
  const elapsed = recording ? state.elapsedMs : 0;
  return (
    <fieldset
      className="m-0 flex min-w-0 items-center gap-2 border-0 p-0"
      aria-label="Recording a voice message"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Cancel recording"
        onClick={onCancel}
      >
        <XIcon />
      </Button>
      <span
        className={cn(
          'bg-destructive size-2.5 shrink-0 rounded-full',
          recording && 'motion-safe:animate-pulse',
        )}
        aria-hidden="true"
      />
      <output className="min-w-0 flex-1 text-sm tabular-nums" aria-live="off">
        {state.status === 'starting' ? (
          'Starting…'
        ) : state.status === 'stopping' ? (
          'Finishing…'
        ) : (
          <>
            <span className="sr-only">Recording, </span>
            {formatDuration(elapsed)}
            <span className="text-muted-foreground">
              {' '}
              / {formatDuration(VOICE_LIMITS.maxDurationMs)}
            </span>
          </>
        )}
      </output>
      {recording ? <LevelMeter level={state.level} /> : null}
      <Button
        type="button"
        size="icon-sm"
        aria-label="Stop recording"
        disabled={!recording}
        onClick={onStop}
      >
        <SquareIcon className="fill-current" />
      </Button>
    </fieldset>
  );
}

type VoicePreviewProps = {
  state: Extract<Recorder['state'], { status: 'uploading' | 'ready' | 'error' }>;
  /** Whether the form may send right now (the parent's rule). */
  canSend: boolean;
  onDiscard: () => void;
  onRetry: () => void;
};

/** The recorded clip before it goes: listen to it, throw it away or send it. */
export function VoicePreview({ state, canSend, onDiscard, onRetry }: VoicePreviewProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Discard voice message"
          onClick={onDiscard}
        >
          <Trash2Icon />
        </Button>
        <div className="bg-muted min-w-0 flex-1 rounded-2xl px-2 py-1">
          <VoiceNote
            id="voice-preview"
            conversationId="composer"
            voice={{ url: state.url, durationMs: state.clip.durationMs, peaks: state.clip.peaks }}
            className="w-full"
          />
        </div>
        {state.status === 'uploading' ? (
          <span className="flex size-8 items-center justify-center">
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            <span className="sr-only">Uploading the voice message</span>
          </span>
        ) : (
          <Button type="submit" size="icon-sm" aria-label="Send" disabled={!canSend}>
            <SendIcon />
          </Button>
        )}
      </div>
      {state.status === 'error' ? (
        <p className="text-destructive text-xs">
          {state.message}{' '}
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onRetry}>
            Retry
          </Button>
        </p>
      ) : null}
    </div>
  );
}
