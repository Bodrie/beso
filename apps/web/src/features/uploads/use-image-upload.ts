import { type ImageUploadKind, UPLOAD_LIMITS, type UploadResponse } from '@beso/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiClientError } from '@/lib/api/client';
import { uploadImage } from '@/lib/api/uploads';

type Attached = { file: File; previewUrl: string };

export type ImageUploadState =
  | { status: 'idle' }
  | ({ status: 'uploading' } & Attached)
  | ({ status: 'ready'; upload: UploadResponse } & Attached)
  | ({ status: 'error'; message: string } & Attached);

/** Client-side mirror of the API limits, so a hopeless file never leaves the browser. */
export function describeImageProblem(file: File): string | null {
  const accepted: readonly string[] = UPLOAD_LIMITS.acceptedTypes;
  if (!accepted.includes(file.type)) return 'Choose a JPEG, PNG, WebP, GIF or AVIF image.';
  if (file.size > UPLOAD_LIMITS.maxBytes) {
    return `Images must be ${Math.round(UPLOAD_LIMITS.maxBytes / 1024 / 1024)} MB or smaller.`;
  }
  return null;
}

/**
 * Uploads an image as soon as it is selected, keeping a local preview meanwhile.
 * The caller submits `state.upload.key` once the status is `ready`.
 */
export function useImageUpload(kind: ImageUploadKind) {
  const [state, setState] = useState<ImageUploadState>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const previewUrl = useRef<string | null>(null);

  const release = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    if (previewUrl.current) {
      URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = null;
    }
  }, []);

  const start = useCallback(
    (file: File, url: string) => {
      const abort = new AbortController();
      controller.current = abort;
      setState({ status: 'uploading', file, previewUrl: url });
      void (async () => {
        try {
          const upload = await uploadImage(kind, file, abort.signal);
          if (!abort.signal.aborted) setState({ status: 'ready', file, previewUrl: url, upload });
        } catch (error) {
          if (abort.signal.aborted) return;
          const message = isApiClientError(error)
            ? error.message
            : 'The upload failed. Please try again.';
          setState({ status: 'error', file, previewUrl: url, message });
        }
      })();
    },
    [kind],
  );

  /** Starts the upload; returns a problem description instead when the file is unacceptable. */
  const select = useCallback(
    (file: File): string | null => {
      const problem = describeImageProblem(file);
      if (problem) return problem;
      release();
      const url = URL.createObjectURL(file);
      previewUrl.current = url;
      start(file, url);
      return null;
    },
    [release, start],
  );

  const retry = useCallback(() => {
    if (state.status === 'error') start(state.file, state.previewUrl);
  }, [start, state]);

  const clear = useCallback(() => {
    release();
    setState({ status: 'idle' });
  }, [release]);

  /**
   * Back to idle without revoking the preview of a finished upload: the caller now owns that
   * object URL (the chat shows it in the optimistic bubble) and revokes it when done with it.
   */
  const handOver = useCallback(() => {
    controller.current = null;
    previewUrl.current = null;
    setState({ status: 'idle' });
  }, []);

  useEffect(() => release, [release]);

  return { state, select, retry, clear, handOver };
}
