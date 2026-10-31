import { VOICE_LIMITS } from '@beso/shared';
import type Recorder from 'opus-recorder';

export type RecordingClip = { blob: Blob; durationMs: number; peaks: number[] };
export type RecorderTick = { elapsedMs: number; level: number };

/** How often the meter and the timer move. */
const TICK_MS = 50;
/** One waveform value per slice of a full-length clip. */
const SLICE_MS = VOICE_LIMITS.maxDurationMs / VOICE_LIMITS.maxPeaks;
const OPUS_RATE = 48_000;

/** Whether this browser can record: a microphone API, Web Audio and WebAssembly for the encoder. */
export function canRecordVoice(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof AudioContext !== 'undefined' &&
    typeof WebAssembly !== 'undefined'
  );
}

/** What to tell the member when recording could not start. */
export function describeRecordingProblem(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone access was refused. Allow it in the browser to record.';
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return 'No microphone was found.';
    }
    if (error.name === 'NotReadableError') return 'The microphone is in use by another app.';
  }
  return 'Could not start recording.';
}

/** Loudest slice at 1, two decimals; a sparse list (a slice no tick fell in) becomes dense. */
function normalizePeaks(slices: readonly (number | undefined)[]): number[] {
  const values = Array.from(slices, (value) => value ?? 0);
  const loudest = Math.max(0, ...values);
  if (loudest === 0) return values.map(() => 0);
  return values.map((value) => Math.round((value / loudest) * 100) / 100);
}

/**
 * One voice message, recorded as Opus in the browser (ADR 0009 amendment "voice messages"):
 * the microphone stream goes to libopus in WebAssembly (opus-recorder, loaded on first use)
 * and, beside it, to an analyser that measures loudness for the meter and the waveform. The
 * audio context is created the moment `start` is called, inside the member's tap, as phones
 * require; everything after that may await.
 */
export class VoiceRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private recorder: Recorder | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private readonly slices: (number | undefined)[] = [];
  private encoded: Promise<Uint8Array> | null = null;
  private limitReached = false;
  private readonly onTick: (tick: RecorderTick) => void;
  private readonly onLimit: () => void;

  constructor(onTick: (tick: RecorderTick) => void, onLimit: () => void) {
    this.onTick = onTick;
    this.onLimit = onLimit;
  }

  async start(): Promise<void> {
    const context = new AudioContext();
    this.context = context;
    try {
      const [{ default: Recorder }, { default: encoderPath }, stream] = await Promise.all([
        import('opus-recorder'),
        import('opus-recorder/dist/encoderWorker.min.js?url'),
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
      ]);
      this.stream = stream;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      this.analyser = analyser;
      this.samples = new Float32Array(analyser.fftSize);
      const recorder = new Recorder({
        encoderPath,
        sourceNode: source,
        encoderApplication: 2048,
        encoderBitRate: 32_000,
        encoderSampleRate: OPUS_RATE,
        numberOfChannels: 1,
        streamPages: false,
      });
      this.encoded = new Promise((resolve) => {
        recorder.ondataavailable = (data) => resolve(data);
      });
      this.recorder = recorder;
      await recorder.start();
      this.startedAt = performance.now();
      this.timer = setInterval(() => this.tick(), TICK_MS);
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  /** Ends the recording and hands the clip over; the microphone is released either way. */
  async stop(): Promise<RecordingClip> {
    const { recorder, encoded } = this;
    this.stopTimer();
    const elapsedMs = performance.now() - this.startedAt;
    if (!recorder || !encoded) {
      await this.release();
      throw new Error('Not recording');
    }
    try {
      await recorder.stop();
      const data = await encoded;
      const encodedMs =
        recorder.encodedSamplePosition > 0
          ? (recorder.encodedSamplePosition * 1000) / OPUS_RATE
          : elapsedMs;
      const durationMs = Math.max(1, Math.round(Math.min(encodedMs, VOICE_LIMITS.maxDurationMs)));
      return {
        // A copy into a plain ArrayBuffer: the encoder's view may sit on shared memory.
        blob: new Blob([new Uint8Array(data)], { type: VOICE_LIMITS.mimeType }),
        durationMs,
        peaks: normalizePeaks(this.slices),
      };
    } finally {
      await this.release();
    }
  }

  /** Throws the recording away and releases the microphone. */
  async cancel(): Promise<void> {
    this.stopTimer();
    try {
      await this.recorder?.stop();
    } catch {
      // The clip is not wanted; nothing to do about a failure to finish it.
    }
    await this.release();
  }

  private tick(): void {
    const elapsedMs = performance.now() - this.startedAt;
    const level = this.measure();
    const slice = Math.min(VOICE_LIMITS.maxPeaks - 1, Math.floor(elapsedMs / SLICE_MS));
    this.slices[slice] = Math.max(this.slices[slice] ?? 0, level);
    this.onTick({ elapsedMs, level });
    if (elapsedMs >= VOICE_LIMITS.maxDurationMs && !this.limitReached) {
      this.limitReached = true;
      this.onLimit();
    }
  }

  /** The loudness of the last frames, 0 to 1 (root mean square of the samples). */
  private measure(): number {
    if (!this.analyser || !this.samples) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    return Math.min(1, Math.sqrt(sum / this.samples.length));
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async release(): Promise<void> {
    this.stopTimer();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.analyser?.disconnect();
    this.analyser = null;
    const { recorder, context } = this;
    this.recorder = null;
    this.context = null;
    try {
      // With our own source node the library leaves the context to us.
      await recorder?.close();
    } catch {
      // Already closed, or never fully opened.
    }
    try {
      if (context && context.state !== 'closed') await context.close();
    } catch {
      // Same.
    }
  }
}
