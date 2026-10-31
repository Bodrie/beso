import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { UPLOAD_KEY_PATTERN, type UploadResponse, type VoiceUploadResponse } from '@beso/shared';
import type { Response } from 'express';
import { ZodResponse } from 'nestjs-zod';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { notFound, toApiError, validationError } from '../common/errors.js';
import { UploadResponseDto, VoiceUploadResponseDto } from '../common/responses.dto.js';
import { openPreset } from './presets.js';
import { PresetPathDto, UploadPathDto, UploadQueryDto } from './uploads.dto.js';
import { UploadsService } from './uploads.service.js';

@ApiTags('uploads')
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /** multipart/form-data with a single `file` part; `?kind=` selects the processing preset. */
  @Post()
  @ZodResponse({ status: 201, type: UploadResponseDto })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  upload(
    @CurrentUser() user: AuthUser,
    @Query() query: UploadQueryDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<UploadResponse> {
    if (!file) throw validationError({ file: 'A file is required' });
    return this.uploads.upload(query.kind, file.buffer, user.id);
  }

  /** A voice message: one Ogg Opus `file` part, encoded by the browser, at most half a minute. */
  @Post('voice')
  @ZodResponse({ status: 201, type: VoiceUploadResponseDto })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  uploadVoice(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<VoiceUploadResponse> {
    if (!file) throw validationError({ file: 'A file is required' });
    return this.uploads.uploadVoice(file.buffer, user.id);
  }

  /**
   * A ready-made picture (ADR 0021, "Rewards"). Declared before `:kind/:file`, which would
   * refuse `preset` as a kind. Cached for a day only: a release may redraw one under its name.
   */
  @Public()
  @SkipThrottle()
  @Get('preset/:file')
  async preset(
    @Param() params: PresetPathDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const stream = await openPreset(params.file);
    if (!stream) throw notFound('File not found');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return new StreamableFile(stream, { type: 'image/webp', disposition: 'inline' });
  }

  /** Uploads are public and immutable (new content always gets a new key), so they are not rate limited. */
  @Public()
  @SkipThrottle()
  @Get(':kind/:file')
  async serve(
    @Param() params: UploadPathDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const key = `${params.kind}/${params.file}`;
    // A picture's name on the voice kind, or the reverse, is no file of ours.
    if (!UPLOAD_KEY_PATTERN.test(key)) throw notFound('File not found');
    const stream = await this.uploads.open(key);
    if (!stream) throw notFound('File not found');
    // Only a file that exists is immutable; a 404 must not be cached for a year (review L11).
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return new StreamableFile(stream, {
      type: key.endsWith('.ogg') ? 'audio/ogg' : 'image/webp',
      disposition: 'inline',
    }).setErrorHandler((error, response) => {
      // The file vanished between the existence check and the read: answer with the envelope.
      const body = toApiError(
        error.message.includes('ENOENT') ? notFound('File not found') : error,
      );
      response.statusCode = body.statusCode;
      // `response` is the same object as `res`, typed narrowly by Nest.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.send(JSON.stringify(body));
    });
  }
}
