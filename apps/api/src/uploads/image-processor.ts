import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ImageUploadKind, PROFILE_PICTURE_SIZES } from '@beso/shared';
import sharp from 'sharp';
import { badRequest, unsupportedMedia } from '../common/errors.js';
import type { Env } from '../config/env.js';

/** Formats sharp may decode for us. SVG is deliberately absent (scripts, external refs). */
export const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif']);

type Preset = { width: number; height?: number; fit: 'cover' | 'inside'; quality: number };

/**
 * Avatars and covers come out at the shared frame sizes (the web cropper sends them at that
 * ratio already, so the `attention` crop below only acts on files uploaded uncropped).
 */
export const PRESETS: Record<ImageUploadKind, Preset> = {
  avatar: { ...PROFILE_PICTURE_SIZES.avatar, fit: 'cover', quality: 80 },
  cover: { ...PROFILE_PICTURE_SIZES.cover, fit: 'cover', quality: 80 },
  post: { width: 1920, height: 1920, fit: 'inside', quality: 82 },
  message: { width: 1600, height: 1600, fit: 'inside', quality: 82 },
  group: { ...PROFILE_PICTURE_SIZES.group, fit: 'cover', quality: 80 },
};

export type ProcessedImage = {
  data: Buffer;
  width: number;
  height: number;
  contentType: 'image/webp';
};

/**
 * Every upload is decoded by sharp (which trusts magic bytes, not the declared
 * MIME type), auto-rotated, resized per preset and re-encoded to WebP. The
 * re-encode strips EXIF/GPS metadata and neutralises anything that is not pixels.
 */
@Injectable()
export class ImageProcessor {
  private readonly maxPixels: number;

  constructor(config: ConfigService<Env, true>) {
    this.maxPixels = config.get('UPLOAD_MAX_PIXELS', { infer: true });
  }

  async process(input: Buffer, kind: ImageUploadKind): Promise<ProcessedImage> {
    const format = await this.detectFormat(input);
    if (format === undefined || !ACCEPTED_FORMATS.has(format)) {
      throw unsupportedMedia('Unsupported image type', {
        file: 'Use a JPEG, PNG, WebP, GIF or AVIF image',
      });
    }

    const preset = PRESETS[kind];
    try {
      const { data, info } = await sharp(input, { limitInputPixels: this.maxPixels })
        .rotate()
        .resize({
          width: preset.width,
          height: preset.height,
          fit: preset.fit,
          withoutEnlargement: preset.fit === 'inside',
          ...(preset.fit === 'cover' ? { position: 'attention' } : {}),
        })
        .webp({ quality: preset.quality })
        .toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height, contentType: 'image/webp' };
    } catch (error) {
      throw this.toException(error);
    }
  }

  /** The pixel size of a stored file, for files stored before sizes were recorded (D2). */
  async measure(input: Buffer): Promise<{ width: number; height: number }> {
    const { width, height } = await sharp(input, { limitInputPixels: false }).metadata();
    return { width, height };
  }

  /** Header-only sniffing; the pixel budget is enforced when the image is actually decoded. */
  private async detectFormat(input: Buffer): Promise<string | undefined> {
    try {
      return (await sharp(input, { limitInputPixels: false }).metadata()).format;
    } catch {
      return undefined;
    }
  }

  private toException(error: unknown): Error {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('pixel limit')) {
      return badRequest('Image is too large', {
        file: `Images must be below ${Math.round(this.maxPixels / 1_000_000)} megapixels`,
      });
    }
    return unsupportedMedia('The file is not a valid image', {
      file: 'The file could not be decoded as an image',
    });
  }
}
