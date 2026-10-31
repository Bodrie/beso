import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { alice, bob, makeMessage } from '@/test/fixtures';
import { seedDirect, seedReadMark } from '@/test/msw/db';
import { mockDb, signedInAs } from '@/test/msw/handlers';
import { renderApp } from '@/test/render';
import { resetVoicePlayback } from './voice/voice-player';

/** Stands in for the Opus encoder: three seconds of "audio" come out of every recording. */
vi.mock('opus-recorder', () => {
  class FakeRecorder {
    static isRecordingSupported() {
      return true;
    }
    encodedSamplePosition = 0;
    ondataavailable: (data: Uint8Array) => void = () => undefined;
    onstop: () => void = () => undefined;
    async start() {
      this.encodedSamplePosition = 0;
    }
    async stop() {
      this.encodedSamplePosition = 48_000 * 3;
      this.ondataavailable(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
      this.onstop();
    }
    async close() {}
  }
  return { default: FakeRecorder };
});
vi.mock('opus-recorder/dist/encoderWorker.min.js?url', () => ({ default: '/encoderWorker.js' }));

const VOICE_URL = (n: number) =>
  `http://localhost/api/v1/uploads/voice/0f0f0f0f-0000-7000-8000-00000000000${n}.ogg`;
const voiceOf = (n: number, durationMs: number) => ({
  url: VOICE_URL(n),
  durationMs,
  peaks: [0.2, 0.9, 0.5],
});

class FakeAudioContext {
  state = 'running';
  sampleRate = 48_000;
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createAnalyser() {
    return {
      fftSize: 1024,
      connect: () => undefined,
      disconnect: () => undefined,
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.2),
    };
  }
  async resume() {}
  async close() {
    this.state = 'closed';
  }
}

/** jsdom has no microphone, no Web Audio and no media playback; the app needs their shapes only. */
function stubMedia({ playable = true } = {}) {
  const stop = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) },
  });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  const media = HTMLMediaElement.prototype;
  vi.spyOn(media, 'canPlayType').mockReturnValue(playable ? 'probably' : '');
  vi.spyOn(media, 'play').mockImplementation(function play(this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(media, 'pause').mockImplementation(function pause(this: HTMLMediaElement) {
    this.dispatchEvent(new Event('pause'));
  });
  vi.spyOn(media, 'load').mockImplementation(() => undefined);
  return { stop };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetVoicePlayback();
});

describe('voice messages', () => {
  it('records, uploads, previews and sends a clip, which arrives as a player without an edit option', async () => {
    const { stop } = stubMedia();
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    const hi = makeMessage(withBob.id, bob.id, 'Say something');
    mockDb.messages.push(hi);
    seedReadMark(withBob.id, alice.id, hi.createdAt);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });

    await user.click(screen.getByRole('button', { name: 'Record a voice message' }));
    const bar = await screen.findByRole('group', { name: 'Recording a voice message' });
    expect(within(bar).getByText(/0:0\d/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message Bob Brown' })).toBeNull();
    await user.click(within(bar).getByRole('button', { name: 'Stop recording' }));

    // The clip is uploaded at once and can be listened to before it goes.
    await waitFor(() => expect(mockDb.uploads).toBe(1));
    expect(mockDb.lastUpload).toMatchObject({ name: 'voice.ogg', type: 'audio/ogg; codecs=opus' });
    expect(stop).toHaveBeenCalled();
    const preview = await screen.findByRole('button', { name: 'Play voice message, 3 seconds' });
    expect(preview).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard voice message' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const play = await within(log).findByRole('button', { name: 'Play voice message, 3 seconds' });
    await waitFor(() => expect(within(log).queryByText('Sending…')).toBeNull());
    const sent = mockDb.messages.at(-1);
    expect(sent).toMatchObject({ senderId: alice.id, content: '' });
    expect(sent?.voice).toMatchObject({ durationMs: 3000 });
    expect(sent?.voice?.peaks.length).toBeGreaterThan(0);
    // The composer is back to text; the list row names the clip.
    expect(screen.getByRole('textbox', { name: 'Message Bob Brown' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Conversations' })).toHaveTextContent('Voice message');

    // A voice message has no text, so its menu offers no edit.
    await user.click(play);
    expect(await within(log).findByRole('button', { name: 'Pause voice message' })).toBeVisible();
    await user.click(within(log).getByRole('button', { name: 'Message options' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Edit message' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Delete message' })).toBeInTheDocument();
  });

  it('plays one voice message at a time and seeks with the keyboard', async () => {
    stubMedia();
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    const first = makeMessage(withBob.id, bob.id, '', { voice: voiceOf(1, 4000) });
    const second = makeMessage(withBob.id, bob.id, '', { voice: voiceOf(2, 12_000) });
    mockDb.messages.push(first, second);
    seedReadMark(withBob.id, alice.id, second.createdAt);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });

    const playFirst = await within(log).findByRole('button', {
      name: 'Play voice message, 4 seconds',
    });
    await user.click(playFirst);
    expect(within(log).getByRole('button', { name: 'Pause voice message' })).toBeInTheDocument();
    expect(
      within(log).getByRole('button', { name: 'Play voice message, 12 seconds' }),
    ).toBeInTheDocument();

    // Starting the second stops the first.
    await user.click(within(log).getByRole('button', { name: 'Play voice message, 12 seconds' }));
    expect(within(log).getAllByRole('button', { name: 'Pause voice message' })).toHaveLength(1);
    expect(
      within(log).getByRole('button', { name: 'Play voice message, 4 seconds' }),
    ).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Pause voice message' }));
    expect(within(log).queryByRole('button', { name: 'Pause voice message' })).toBeNull();

    // The waveform is a slider: arrows move a second, Shift five.
    const sliders = within(log).getAllByRole('slider', { name: 'Position in voice message' });
    const slider = sliders[1];
    if (!slider) throw new Error('no slider');
    expect(slider).toHaveAttribute('aria-valuetext', '0:00 of 0:12');
    slider.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{/Shift}');
    expect(slider).toHaveAttribute('aria-valuetext', '0:07 of 0:12');
    await user.keyboard('{Home}');
    expect(slider).toHaveAttribute('aria-valuetext', '0:00 of 0:12');
  });

  it('offers the file when the browser cannot play Opus, and no recorder without a microphone', async () => {
    stubMedia({ playable: false });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    const clip = makeMessage(withBob.id, bob.id, '', {
      voice: { url: VOICE_URL(1), durationMs: 5000, peaks: [] },
    });
    mockDb.messages.push(clip);
    seedReadMark(withBob.id, alice.id, clip.createdAt);
    renderApp(`/messages/${withBob.id}`);
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });

    expect(await within(log).findByText('Voice message · 0:05')).toBeInTheDocument();
    expect(within(log).getByRole('link', { name: 'Download voice message' })).toHaveAttribute(
      'href',
      VOICE_URL(1),
    );
    expect(within(log).queryByRole('button', { name: /Play voice message/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
  });
});
