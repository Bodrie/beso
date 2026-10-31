import {
  type ImageUploadKind,
  type UploadResponse,
  type VoiceUploadResponse,
  uploadResponseSchema,
  voiceUploadResponseSchema,
} from '@beso/shared';
import { api } from './client';

/** Sends one image as multipart; the API re-encodes it and answers with the storage key. */
export function uploadImage(
  kind: ImageUploadKind,
  file: File,
  signal?: AbortSignal,
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  return api.post(`/uploads?kind=${kind}`, undefined, {
    schema: uploadResponseSchema,
    formData,
    signal,
  });
}

/** Sends a voice message the browser encoded (Ogg Opus); the API checks it and keeps it as is. */
export function uploadVoice(clip: Blob, signal?: AbortSignal): Promise<VoiceUploadResponse> {
  const formData = new FormData();
  formData.append('file', clip, 'voice.ogg');
  return api.post('/uploads/voice', undefined, {
    schema: voiceUploadResponseSchema,
    formData,
    signal,
  });
}
