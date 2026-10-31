import { VOICE_LIMITS } from '@beso/shared';
import { useSyncExternalStore } from 'react';

type Snapshot = {
  /** The message whose clip is loaded, or null. */
  id: string | null;
  conversationId: string | null;
  playing: boolean;
  positionMs: number;
  /** The browser could not play the file. */
  failed: boolean;
};

const IDLE: Snapshot = {
  id: null,
  conversationId: null,
  playing: false,
  positionMs: 0,
  failed: false,
};

let snapshot = IDLE;
let element: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();

function update(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

/** The one audio element of the app, made on first use and wired to the snapshot. */
function audio(): HTMLAudioElement {
  if (element) return element;
  const created = document.createElement('audio');
  created.preload = 'auto';
  created.addEventListener('play', () => update({ playing: true, failed: false }));
  created.addEventListener('pause', () => update({ playing: false }));
  created.addEventListener('ended', () => update({ playing: false, positionMs: 0 }));
  created.addEventListener('timeupdate', () =>
    update({ positionMs: Math.round(created.currentTime * 1000) }),
  );
  created.addEventListener('error', () => update({ playing: false, failed: true }));
  element = created;
  return created;
}

function load(id: string, conversationId: string, url: string): HTMLAudioElement {
  const player = audio();
  if (snapshot.id !== id) {
    player.src = url;
    update({ id, conversationId, positionMs: 0, failed: false, playing: false });
  }
  return player;
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = (): Snapshot => snapshot;
const getIdle = (): Snapshot => IDLE;

/**
 * One voice message plays at a time, app-wide (ADR 0009 amendment "voice messages"): starting
 * another stops the current one, and a thread leaving the screen stops what it was playing.
 * Bubbles read their own slice of the state through `useVoicePlayer`.
 */
export const voicePlayer = {
  subscribe,
  getSnapshot,
  /** Plays `id` where it was, or from the start when another clip was loaded. */
  play(id: string, conversationId: string, url: string): void {
    const player = load(id, conversationId, url);
    player.play().catch(() => update({ playing: false, failed: true }));
  },
  pause(): void {
    element?.pause();
  },
  /** Moves within `id`; a clip that was not loaded yet is loaded, paused, at that position. */
  seek(id: string, conversationId: string, url: string, positionMs: number): void {
    const player = load(id, conversationId, url);
    player.currentTime = positionMs / 1000;
    update({ positionMs });
  },
  /** The thread of `conversationId` left the screen. */
  stopConversation(conversationId: string): void {
    if (snapshot.conversationId !== conversationId) return;
    voicePlayer.reset();
  },
  reset(): void {
    if (element) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    snapshot = IDLE;
    for (const listener of listeners) listener();
  },
};

export type VoicePlayback = { playing: boolean; positionMs: number; failed: boolean };

const NOTHING: VoicePlayback = { playing: false, positionMs: 0, failed: false };

/** What one bubble needs to know: whether its clip plays, where it is, whether it failed. */
export function useVoicePlayer(id: string): VoicePlayback {
  const current = useSyncExternalStore(subscribe, getSnapshot, getIdle);
  if (current.id !== id) return NOTHING;
  return { playing: current.playing, positionMs: current.positionMs, failed: current.failed };
}

let playable: boolean | null = null;

/** Whether this browser plays Ogg Opus in an audio element (Safari may not; to be verified). */
export function canPlayVoice(): boolean {
  if (playable === null) {
    playable =
      typeof document !== 'undefined' &&
      document.createElement('audio').canPlayType(VOICE_LIMITS.mimeType) !== '';
  }
  return playable;
}

/** Tests swap browsers' answers. */
export function resetVoicePlayback(): void {
  playable = null;
  voicePlayer.reset();
}
