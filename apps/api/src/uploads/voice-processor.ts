import { Injectable } from '@nestjs/common';
import { VOICE_LIMITS } from '@beso/shared';
import { badRequest, unsupportedMedia } from '../common/errors.js';

export type OpusInfo = { channels: number; preSkip: number; durationMs: number };

export type ProcessedVoice = { data: Buffer; durationMs: number; contentType: 'audio/ogg' };

/** Opus granule positions count samples at 48 kHz whatever the recording rate (RFC 7845 §4). */
const OPUS_RATE = 48_000n;
const PAGE_HEADER = 27;
const OPUS_HEAD_LENGTH = 19;

/**
 * Reads what the API needs from an Ogg Opus file without decoding it: the identification
 * header on the first page (channels, pre-skip) and the granule position of the last page,
 * which is the clip's length in samples. Null when the bytes are not one Ogg Opus stream
 * from start to end. Page checksums are not verified: a damaged file plays badly, it does not
 * get in anywhere.
 */
export function inspectOggOpus(data: Buffer): OpusInfo | null {
  let offset = 0;
  let pages = 0;
  let channels = 0;
  let preSkip = 0;
  let lastGranule = -1n;
  while (offset + PAGE_HEADER <= data.length) {
    if (data.toString('ascii', offset, offset + 4) !== 'OggS' || data[offset + 4] !== 0) {
      return null;
    }
    const granule = data.readBigInt64LE(offset + 6);
    const segments = data[offset + 26] ?? 0;
    const tableEnd = offset + PAGE_HEADER + segments;
    if (tableEnd > data.length) return null;
    let bodyLength = 0;
    for (let index = offset + PAGE_HEADER; index < tableEnd; index += 1) {
      bodyLength += data[index] ?? 0;
    }
    const bodyEnd = tableEnd + bodyLength;
    if (bodyEnd > data.length) return null;
    if (pages === 0) {
      const head = data.toString('ascii', tableEnd, tableEnd + 8);
      if (bodyLength < OPUS_HEAD_LENGTH || head !== 'OpusHead') return null;
      channels = data[tableEnd + 9] ?? 0;
      preSkip = data.readUInt16LE(tableEnd + 10);
    }
    // -1 marks a page that completes no packet; the last real position is the length.
    if (granule >= 0n) lastGranule = granule;
    pages += 1;
    offset = bodyEnd;
  }
  if (pages < 2 || offset !== data.length || lastGranule < 0n) return null;
  const samples = lastGranule - BigInt(preSkip);
  if (samples <= 0n) return null;
  return { channels, preSkip, durationMs: Number((samples * 1000n) / OPUS_RATE) };
}

/**
 * Checks a voice message the browser encoded (ADR 0009 amendment "voice messages"): Ogg
 * Opus, mono or stereo, within the byte and duration limits. The bytes are stored as they
 * came; the API never re-encodes audio.
 */
@Injectable()
export class VoiceProcessor {
  process(input: Buffer): ProcessedVoice {
    if (input.length > VOICE_LIMITS.maxBytes) {
      throw badRequest('Voice message is too large', {
        file: `Voice messages must be below ${Math.round(VOICE_LIMITS.maxBytes / 1024)} kB`,
      });
    }
    const info = inspectOggOpus(input);
    if (!info || info.channels < 1 || info.channels > 2) {
      throw unsupportedMedia('Unsupported audio', { file: 'Send an Ogg Opus voice message' });
    }
    if (info.durationMs > VOICE_LIMITS.maxDurationMs) {
      throw badRequest('Voice message is too long', {
        file: `At most ${VOICE_LIMITS.maxDurationMs / 1000} seconds`,
      });
    }
    return { data: input, durationMs: Math.max(1, info.durationMs), contentType: 'audio/ogg' };
  }
}
