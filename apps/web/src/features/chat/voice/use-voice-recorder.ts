import type { VoiceUploadResponse } from '@beso/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isApiClientError } from '@/lib/api/client';
import { uploadVoice } from '@/lib/api/uploads';
import { type RecordingClip, VoiceRecorder, describeRecordingProblem } from './voice-recorder';

/** Anything shorter is a slip of the finger, not a message. */
const MIN_CLIP_MS = 500;

type Clip = { clip: RecordingClip; url: string };

export type VoiceRecorderState =
  | { status: 'idle' }
  /** The microphone and the encoder are being set up. */
  | { status: 'starting' }
  | { status: 'recording'; elapsedMs: number; level: number }
  /** The encoder finishes the clip. */
  | { status: 'stopping' }
  | ({ status: 'uploading' } & Clip)
  | ({ status: 'ready'; upload: VoiceUploadResponse } & Clip)
  | ({ status: 'error'; message: string } & Clip);

/**
 * Records a voice message and uploads it as soon as the recording stops, keeping a local
 * object URL for the preview and the optimistic bubble (as `useImageUpload` does for pictures).
 * The caller sends `state.upload.key` once the status is `ready`.
 */
export function useVoiceRecorder() {
  const [state, setState] = useState<VoiceRecorderState>({ status: 'idle' });
  const recorder = useRef<VoiceRecorder | null>(null);
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const stopRef = useRef<() => void>(() => undefined);

  const releaseUrl = useCallback(() => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }, []);

  const upload = useCallback((clip: RecordingClip, url: string) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState({ status: 'uploading', clip, url });
    void (async () => {
      try {
        const result = await uploadVoice(clip.blob, abort.signal);
        if (!abort.signal.aborted) setState({ status: 'ready', clip, url, upload: result });
      } catch (error) {
        if (abort.signal.aborted) return;
        const message = isApiClientError(error)
          ? (error.fields.file ?? error.message)
          : 'The upload failed. Please try again.';
        setState({ status: 'error', clip, url, message });
      }
    })();
  }, []);

  const stop = useCallback(async () => {
    const instance = recorder.current;
    if (!instance) return;
    recorder.current = null;
    setState({ status: 'stopping' });
    try {
      const clip = await instance.stop();
      if (clip.durationMs < MIN_CLIP_MS) {
        toast('Hold the button a little longer to record a message.');
        setState({ status: 'idle' });
        return;
      }
      const url = URL.createObjectURL(clip.blob);
      objectUrl.current = url;
      upload(clip, url);
    } catch {
      toast.error('Could not finish the recording.');
      setState({ status: 'idle' });
    }
  }, [upload]);

  useEffect(() => {
    stopRef.current = () => void stop();
  }, [stop]);

  /** Call from the tap itself (phones need the audio context created inside the gesture). */
  const start = useCallback(async () => {
    if (recorder.current) return;
    const instance = new VoiceRecorder(
      (tick) =>
        setState((current) =>
          current.status === 'recording' || current.status === 'starting'
            ? { status: 'recording', ...tick }
            : current,
        ),
      () => stopRef.current(),
    );
    recorder.current = instance;
    setState({ status: 'starting' });
    try {
      await instance.start();
      setState((current) =>
        current.status === 'starting' ? { status: 'recording', elapsedMs: 0, level: 0 } : current,
      );
    } catch (error) {
      if (recorder.current === instance) recorder.current = null;
      setState({ status: 'idle' });
      toast.error(describeRecordingProblem(error));
    }
  }, []);

  /** While recording: throw it away. */
  const cancel = useCallback(() => {
    const instance = recorder.current;
    recorder.current = null;
    void instance?.cancel();
    setState({ status: 'idle' });
  }, []);

  /** After recording: forget the clip (the upload, if any, stays for the orphan job). */
  const discard = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    releaseUrl();
    setState({ status: 'idle' });
  }, [releaseUrl]);

  const retry = useCallback(() => {
    if (state.status === 'error') upload(state.clip, state.url);
  }, [state, upload]);

  /** Back to idle without revoking the URL: the thread's optimistic bubble owns it now. */
  const handOver = useCallback(() => {
    controller.current = null;
    objectUrl.current = null;
    setState({ status: 'idle' });
  }, []);

  useEffect(
    () => () => {
      void recorder.current?.cancel();
      controller.current?.abort();
      releaseUrl();
    },
    [releaseUrl],
  );

  return { state, start, stop, cancel, discard, retry, handOver };
}
