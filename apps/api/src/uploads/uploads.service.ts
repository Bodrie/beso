import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  IMAGE_UPLOAD_KINDS,
  type ImageUploadKind,
  type UploadKind,
  type UploadResponse,
  type VoiceUploadResponse,
} from '@beso/shared';
import { AssetsService } from '../assets/assets.service.js';
import { badRequest } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ImageProcessor } from './image-processor.js';
import { STORAGE, type StorageService } from './storage.js';
import { VoiceProcessor } from './voice-processor.js';

export type OwnershipCheck = { ownerId: string; kind: UploadKind; field: string };

/** Files measured per daily run by `fillSizes`; the uploads stored before D2 fit in one. */
const SIZE_BATCH = 1000;

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @Inject(STORAGE) private readonly storage: StorageService,
    private readonly images: ImageProcessor,
    private readonly voices: VoiceProcessor,
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
  ) {}

  async upload(kind: ImageUploadKind, input: Buffer, ownerId: string): Promise<UploadResponse> {
    const image = await this.images.process(input, kind);
    const key = `${kind}/${randomUUID()}.webp`;
    await this.storage.put(key, image.data, image.contentType);
    try {
      await this.prisma.upload.create({
        data: {
          key,
          ownerId,
          kind,
          width: image.width,
          height: image.height,
          bytes: image.data.length,
        },
      });
    } catch (error) {
      // A file without a row is invisible to the orphan reaper: take it back out at once.
      await this.deleteFiles([key]);
      throw error;
    }
    return {
      key,
      url: this.assets.url(key),
      width: image.width,
      height: image.height,
      bytes: image.data.length,
    };
  }

  /**
   * A voice message the browser encoded (ADR 0009 amendment "voice messages"): checked, never
   * re-encoded, stored under `voice/<uuid>.ogg` with its length on the row.
   */
  async uploadVoice(input: Buffer, ownerId: string): Promise<VoiceUploadResponse> {
    const voice = this.voices.process(input);
    const key = `voice/${randomUUID()}.ogg`;
    await this.storage.put(key, voice.data, voice.contentType);
    try {
      await this.prisma.upload.create({
        data: {
          key,
          ownerId,
          kind: 'voice',
          bytes: voice.data.length,
          durationMs: voice.durationMs,
        },
      });
    } catch (error) {
      await this.deleteFiles([key]);
      throw error;
    }
    return {
      key,
      url: this.assets.url(key),
      bytes: voice.data.length,
      durationMs: voice.durationMs,
    };
  }

  open(key: string): Promise<Readable | null> {
    return this.storage.open(key);
  }

  /**
   * A key may only be attached by the user who uploaded it, and only where its
   * kind fits. Unknown, foreign and wrong-kind keys all get the same answer.
   */
  async assertOwned(key: string, check: OwnershipCheck): Promise<void> {
    const upload = await this.prisma.upload.findUnique({
      where: { key },
      select: { ownerId: true, kind: true },
    });
    if (!upload || upload.ownerId !== check.ownerId || upload.kind !== check.kind) {
      throw badRequest('Unknown upload', { [check.field]: 'Unknown upload' });
    }
  }

  /** `assertOwned` for several keys at once (the pictures of a post), in one query. */
  async assertAllOwned(keys: readonly string[], check: OwnershipCheck): Promise<void> {
    const distinct = new Set(keys);
    if (distinct.size === 0) return;
    const owned = await this.prisma.upload.count({
      where: { key: { in: [...distinct] }, ownerId: check.ownerId, kind: check.kind },
    });
    if (owned !== distinct.size) {
      throw badRequest('Unknown upload', { [check.field]: 'Unknown upload' });
    }
  }

  /**
   * Removes files whose rows are already gone (an account was deleted and the `uploads` rows
   * cascaded with it, or the orphan reaper took them). Best effort, one failure does not stop
   * the others.
   */
  async deleteFiles(keys: readonly string[]): Promise<void> {
    await Promise.all(
      keys.map(async (key) => {
        try {
          await this.storage.delete(key);
        } catch (error) {
          this.logger.warn({ err: error, key }, 'Could not delete the file of a removed upload');
        }
      }),
    );
  }

  /**
   * Housekeeping (JobsService): uploads older than `before` that no profile, post, message or
   * group ever attached. The rows go first, re-checking the references in the same statement
   * so an attach racing the job is refused ("Unknown upload") rather than left pointing at
   * nothing; the files follow, best effort. Returns the count.
   */
  async deleteOrphans(before: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ key: string }[]>`
      DELETE FROM uploads u
      WHERE u.created_at < ${before}
        AND NOT EXISTS (SELECT 1 FROM users x WHERE x.avatar_key = u.key OR x.cover_key = u.key)
        AND NOT EXISTS (SELECT 1 FROM post_images p WHERE p.key = u.key)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.image_key = u.key OR m.voice_key = u.key)
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.picture_key = u.key)
      RETURNING u.key`;
    await this.deleteFiles(rows.map((row) => row.key));
    return rows.length;
  }

  /**
   * Housekeeping (JobsService): records the size of files stored before uploads kept it (D2),
   * reading them back from storage. A file that cannot be read is logged and stays without a
   * size (pages then show it without reserving its space). Returns the count measured.
   */
  async fillSizes(): Promise<number> {
    const rows = await this.prisma.upload.findMany({
      // Pictures only: a voice message has no size to fill in.
      where: { width: null, kind: { in: [...IMAGE_UPLOAD_KINDS] } },
      select: { key: true },
      orderBy: { createdAt: 'asc' },
      take: SIZE_BATCH,
    });
    let measured = 0;
    for (const { key } of rows) {
      // oxlint-disable-next-line no-await-in-loop -- one file in memory at a time, on purpose
      if (await this.measure(key)) measured += 1;
    }
    return measured;
  }

  private async measure(key: string): Promise<boolean> {
    try {
      const stream = await this.storage.open(key);
      if (!stream) {
        this.logger.warn({ key }, 'The file of an upload is missing; its size stays unknown');
        return false;
      }
      const data = await buffer(stream);
      const size = await this.images.measure(data);
      await this.prisma.upload.updateMany({
        where: { key },
        data: { ...size, bytes: data.length },
      });
      return true;
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Could not measure an upload');
      return false;
    }
  }

  /** Deletes a file once nothing references it any more. Best effort, never throws. */
  async discard(key: string | null): Promise<void> {
    if (key === null) return;
    try {
      const [profiles, posts, messages, groups] = await Promise.all([
        this.prisma.user.count({ where: { OR: [{ avatarKey: key }, { coverKey: key }] } }),
        this.prisma.postImage.count({ where: { key } }),
        this.prisma.message.count({ where: { OR: [{ imageKey: key }, { voiceKey: key }] } }),
        this.prisma.conversation.count({ where: { pictureKey: key } }),
      ]);
      if (profiles + posts + messages + groups > 0) return;
      await this.storage.delete(key);
      await this.prisma.upload.deleteMany({ where: { key } });
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Could not discard upload');
    }
  }
}
