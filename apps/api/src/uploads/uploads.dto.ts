import { uploadKindSchema, uploadQuerySchema } from '@beso/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class UploadQueryDto extends createZodDto(uploadQuerySchema) {}

/** The kind and the file name; whether they go together is `UPLOAD_KEY_PATTERN`'s call in the controller. */
const uploadPathSchema = z.object({
  kind: uploadKindSchema,
  file: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|ogg)$/,
      'Invalid file name',
    ),
});
export class UploadPathDto extends createZodDto(uploadPathSchema) {}

const presetPathSchema = z.object({
  file: z.string().regex(/^(avatar|cover)-[a-z0-9-]{1,32}\.webp$/, 'Invalid file name'),
});
export class PresetPathDto extends createZodDto(presetPathSchema) {}
