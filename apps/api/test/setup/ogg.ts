/**
 * Ogg Opus files for tests, built without an encoder: real page framing and real Opus headers
 * around filler audio packets. The API reads durations from the framing, never the audio, so
 * these are all it needs; a decoder would reject the packets, which no test plays.
 */
const OPUS_RATE = 48_000;
const DEFAULT_PRE_SKIP = 312;

function lacing(length: number): number[] {
  const values: number[] = [];
  let left = length;
  while (left >= 255) {
    values.push(255);
    left -= 255;
  }
  values.push(left);
  return values;
}

type PageOptions = {
  /** 0x02 begins the stream, 0x04 ends it, 0 for the pages between. */
  headerType: number;
  granule: bigint;
  sequence: number;
  packets: Buffer[];
};

/** One Ogg page; the checksum stays zero because the API does not verify it. */
export function oggPage({ headerType, granule, sequence, packets }: PageOptions): Buffer {
  const segments = packets.flatMap((packet) => lacing(packet.length));
  const header = Buffer.alloc(27 + segments.length);
  header.write('OggS', 0, 'ascii');
  header[4] = 0;
  header[5] = headerType;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(0x6265736f, 14);
  header.writeUInt32LE(sequence, 18);
  header.writeUInt32LE(0, 22);
  header[26] = segments.length;
  segments.forEach((value, index) => {
    header[27 + index] = value;
  });
  return Buffer.concat([header, ...packets]);
}

/** The identification header of an Opus stream (RFC 7845 §5.1). */
export function opusHead(options: { channels?: number; preSkip?: number } = {}): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head[8] = 1;
  head[9] = options.channels ?? 1;
  head.writeUInt16LE(options.preSkip ?? DEFAULT_PRE_SKIP, 10);
  head.writeUInt32LE(OPUS_RATE, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;
  return head;
}

function opusTags(): Buffer {
  const vendor = Buffer.from('beso tests', 'utf8');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);
  return tags;
}

type FileOptions = { channels?: number; preSkip?: number; packetBytes?: number };

/** An Ogg Opus file `durationMs` long: the two header pages, then one page of filler that ends the stream. */
export function fakeOpusFile(durationMs: number, options: FileOptions = {}): Buffer {
  const preSkip = options.preSkip ?? DEFAULT_PRE_SKIP;
  const granule = BigInt(preSkip) + BigInt(Math.round((durationMs * OPUS_RATE) / 1000));
  const packets = Array.from({ length: 5 }, () => Buffer.alloc(options.packetBytes ?? 40, 0xfc));
  return Buffer.concat([
    oggPage({
      headerType: 0x02,
      granule: 0n,
      sequence: 0,
      packets: [opusHead({ preSkip, channels: options.channels })],
    }),
    oggPage({ headerType: 0, granule: 0n, sequence: 1, packets: [opusTags()] }),
    oggPage({ headerType: 0x04, granule, sequence: 2, packets }),
  ]);
}
