/** The subset of opus-recorder 8 this app uses (the package ships no types). */
declare module 'opus-recorder' {
  export type RecorderConfig = {
    /** URL of `encoderWorker.min.js`, loaded as a worker and as an audio worklet module. */
    encoderPath: string;
    /** 2048 voice, 2049 full-band audio, 2051 restricted low delay. */
    encoderApplication: 2048 | 2049 | 2051;
    encoderBitRate: number;
    encoderComplexity: number;
    encoderFrameSize: number;
    encoderSampleRate: 8000 | 12000 | 16000 | 24000 | 48000;
    maxFramesPerPage: number;
    numberOfChannels: 1 | 2;
    resampleQuality: number;
    streamPages: boolean;
    /** The caller's source; it then owns the audio context and the microphone stream. */
    sourceNode: MediaStreamAudioSourceNode;
    mediaTrackConstraints: boolean | MediaTrackConstraints;
    monitorGain: number;
    recordingGain: number;
  };

  export default class Recorder {
    constructor(config?: Partial<RecorderConfig>);
    static isRecordingSupported(): boolean;
    static readonly version: string;
    /** Samples encoded so far, always at 48 kHz. */
    encodedSamplePosition: number;
    state: 'inactive' | 'loading' | 'recording' | 'paused';
    start(): Promise<void>;
    stop(): Promise<void>;
    pause(flush?: boolean): Promise<void>;
    resume(): void;
    close(): Promise<void>;
    ondataavailable: (data: Uint8Array) => void;
    onstart: () => void;
    onstop: () => void;
    onpause: () => void;
    onresume: () => void;
  }
}

declare module 'opus-recorder/dist/encoderWorker.min.js?url' {
  const url: string;
  export default url;
}
