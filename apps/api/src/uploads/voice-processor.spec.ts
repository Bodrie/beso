import { HttpException } from '@nestjs/common';
import { VOICE_LIMITS } from '@beso/shared';
import { fakeOpusFile, oggPage, opusHead } from '../../test/setup/ogg.js';
import { VoiceProcessor, inspectOggOpus } from './voice-processor.js';

const fieldsOf = (error: unknown) =>
  error instanceof HttpException
    ? (error.getResponse() as { fields?: Record<string, string> }).fields
    : undefined;

describe('inspectOggOpus', () => {
  it('reads the channels, the pre-skip and the length from the page framing', () => {
    expect(inspectOggOpus(fakeOpusFile(3000))).toEqual({
      channels: 1,
      preSkip: 312,
      durationMs: 3000,
    });
    expect(inspectOggOpus(fakeOpusFile(29_999, { channels: 2, preSkip: 0 }))).toEqual({
      channels: 2,
      preSkip: 0,
      durationMs: 29_999,
    });
  });

  it('refuses what is not one Ogg Opus stream from start to end', () => {
    expect(inspectOggOpus(Buffer.from('not audio at all, just text'))).toBeNull();
    expect(inspectOggOpus(Buffer.alloc(0))).toBeNull();
    // Trailing bytes, a truncated page, a stream that is not Opus, a header page alone.
    expect(inspectOggOpus(Buffer.concat([fakeOpusFile(1000), Buffer.from('x')]))).toBeNull();
    expect(inspectOggOpus(fakeOpusFile(1000).subarray(0, -3))).toBeNull();
    const vorbis = Buffer.from(opusHead());
    vorbis.write('vorbis!!', 0, 'ascii');
    expect(
      inspectOggOpus(oggPage({ headerType: 0x02, granule: 0n, sequence: 0, packets: [vorbis] })),
    ).toBeNull();
    expect(
      inspectOggOpus(
        oggPage({ headerType: 0x06, granule: 0n, sequence: 0, packets: [opusHead()] }),
      ),
    ).toBeNull();
  });
});

describe('VoiceProcessor', () => {
  const processor = new VoiceProcessor();

  it('passes a clip within the limits through unchanged', () => {
    const file = fakeOpusFile(VOICE_LIMITS.maxDurationMs);
    const result = processor.process(file);
    expect(result.data).toBe(file);
    expect(result.durationMs).toBe(VOICE_LIMITS.maxDurationMs);
    expect(result.contentType).toBe('audio/ogg');
  });

  it('refuses a clip that is too long, too large or not Opus, on the file field', () => {
    expect(() => processor.process(fakeOpusFile(VOICE_LIMITS.maxDurationMs + 1))).toThrow(
      'Voice message is too long',
    );
    try {
      processor.process(fakeOpusFile(VOICE_LIMITS.maxDurationMs + 1));
    } catch (error) {
      expect(fieldsOf(error)).toEqual({ file: expect.stringContaining('30 seconds') });
    }
    expect(() =>
      processor.process(fakeOpusFile(1000, { packetBytes: VOICE_LIMITS.maxBytes / 4 })),
    ).toThrow('Voice message is too large');
    expect(() => processor.process(Buffer.from('RIFF....WAVEfmt '))).toThrow('Unsupported audio');
    expect(() => processor.process(fakeOpusFile(1000, { channels: 6 }))).toThrow(
      'Unsupported audio',
    );
  });
});
