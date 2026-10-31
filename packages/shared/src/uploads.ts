import { z } from 'zod';

/**
 * `group` is a group chat's picture (ADR 0009 amendment "group pictures"), framed like an
 * avatar; `voice` is a chat voice message (amendment "voice messages"), Opus audio the browser
 * encoded, the one kind that is not a picture.
 */
export const UPLOAD_KINDS = ['avatar', 'cover', 'post', 'message', 'group', 'voice'] as const;
export const uploadKindSchema = z.enum(UPLOAD_KINDS);
export type UploadKind = z.infer<typeof uploadKindSchema>;
export const IMAGE_UPLOAD_KINDS = ['avatar', 'cover', 'post', 'message', 'group'] as const;
export type ImageUploadKind = (typeof IMAGE_UPLOAD_KINDS)[number];

/** Storage keys are `<kind>/<uuid>.webp` (every picture is re-encoded to WebP) or `voice/<uuid>.ogg`. */
export const UPLOAD_KEY_PATTERN =
  /^(?:(?:avatar|cover|post|message|group)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp|voice\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ogg)$/;
export const uploadKeySchema = z.string().regex(UPLOAD_KEY_PATTERN, 'Invalid upload key');

const keyOfKind = (kind: UploadKind) =>
  uploadKeySchema.refine((key) => key.startsWith(`${kind}/`), {
    message: `Use an upload of kind "${kind}"`,
  });

/** Each use site only accepts keys produced with the matching `?kind=`. */
export const avatarKeySchema = keyOfKind('avatar');
export const coverKeySchema = keyOfKind('cover');
export const postImageKeySchema = keyOfKind('post');
export const messageImageKeySchema = keyOfKind('message');
export const groupPictureKeySchema = keyOfKind('group');
export const voiceKeySchema = keyOfKind('voice');

/** `POST /uploads?kind=` takes pictures only; voice messages go to `POST /uploads/voice`. */
export const uploadQuerySchema = z.object({ kind: z.enum(IMAGE_UPLOAD_KINDS) });

export const uploadResponseSchema = z.object({
  key: uploadKeySchema,
  url: z.url(),
  width: z.int().positive(),
  height: z.int().positive(),
  bytes: z.int().positive(),
});
export type UploadResponse = z.infer<typeof uploadResponseSchema>;

/**
 * A stored picture as responses show it (D2). The size lets the page reserve the space before
 * the file arrives; it is null only for a file stored before sizes were recorded whose size the
 * daily job could not read yet.
 */
export const storedImageSchema = z.object({
  url: z.string(),
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
});
export type StoredImage = z.infer<typeof storedImageSchema>;

/**
 * The frames the profile pictures are shown in: the API resizes every avatar and cover to
 * exactly these sizes and the web cropper offers the same ratios (1:1 and 3:1), so what a
 * member frames is what the page shows, with no second crop by the browser. A group chat's
 * picture takes the avatar's frame.
 */
export const PROFILE_PICTURE_SIZES = {
  avatar: { width: 512, height: 512 },
  cover: { width: 1800, height: 600 },
  group: { width: 512, height: 512 },
} as const;
export type ProfilePictureKind = keyof typeof PROFILE_PICTURE_SIZES;

/** Mirrors the API defaults so forms can validate before uploading. */
export const UPLOAD_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  acceptedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'],
} as const;

/**
 * Voice messages (ADR 0009 amendment "voice messages"): Opus in an Ogg container, encoded in
 * the browser, at most half a minute. The API reads the duration from the file and refuses
 * longer ones; the byte cap is generous for that length at voice bitrates. The waveform is a
 * short list of loudness values the recorder measured, one per slice of the clip.
 */
export const VOICE_LIMITS = {
  maxDurationMs: 30_000,
  maxBytes: 1024 * 1024,
  maxPeaks: 64,
  mimeType: 'audio/ogg; codecs=opus',
} as const;

export const voicePeaksSchema = z
  .array(z.number().min(0).max(1))
  .max(VOICE_LIMITS.maxPeaks, `At most ${VOICE_LIMITS.maxPeaks} values`);

export const voiceUploadResponseSchema = z.object({
  key: voiceKeySchema,
  url: z.url(),
  bytes: z.int().positive(),
  durationMs: z.int().positive(),
});
export type VoiceUploadResponse = z.infer<typeof voiceUploadResponseSchema>;
