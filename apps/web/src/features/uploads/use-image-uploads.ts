import type { ImageUploadKind } from '@beso/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiClientError } from '@/lib/api/client';
import { uploadImage } from '@/lib/api/uploads';
import { type ImageUploadState, describeImageProblem } from './use-image-upload';

export type ImageUploadItem = Exclude<ImageUploadState, { status: 'idle' }> & { id: string };

let nextId = 0;

/**
 * `useImageUpload` for several pictures at once (the post composer, D2, and the chat's): each
 * file uploads as soon as it is chosen, with its own preview, progress and retry, up to `max`
 * per `owner` ("post", "message": the word the refusal uses). The caller submits the keys once
 * every item is `ready`.
 */
export function useImageUploads(kind: ImageUploadKind, max: number, owner: string) {
  const [items, setItems] = useState<ImageUploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const previews = useRef(new Map<string, string>());
  const tooMany = `At most ${max} pictures per ${owner}.`;

  const release = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    const url = previews.current.get(id);
    if (url) URL.revokeObjectURL(url);
    previews.current.delete(id);
  }, []);

  const replace = useCallback(
    (id: string, item: ImageUploadItem) =>
      setItems((current) => current.map((existing) => (existing.id === id ? item : existing))),
    [],
  );

  const start = useCallback(
    (id: string, file: File, previewUrl: string) => {
      const abort = new AbortController();
      controllers.current.set(id, abort);
      replace(id, { id, status: 'uploading', file, previewUrl });
      void (async () => {
        try {
          const upload = await uploadImage(kind, file, abort.signal);
          if (!abort.signal.aborted) replace(id, { id, status: 'ready', file, previewUrl, upload });
        } catch (error) {
          if (abort.signal.aborted) return;
          const message = isApiClientError(error)
            ? error.message
            : 'The upload failed. Please try again.';
          replace(id, { id, status: 'error', file, previewUrl, message });
        }
      })();
    },
    [kind, replace],
  );

  /**
   * Starts uploading the acceptable files while there is room; returns what went wrong with
   * the rest (the first unacceptable file, or too many), or null.
   */
  const add = useCallback(
    (files: readonly File[]): string | null => {
      let problem: string | null = null;
      const room = max - items.length;
      const accepted: File[] = [];
      for (const file of files) {
        const reason = describeImageProblem(file) ?? (accepted.length < room ? null : tooMany);
        if (reason) problem ??= reason;
        else accepted.push(file);
      }
      const added = accepted.map((file) => {
        nextId += 1;
        const id = `upload-${nextId}`;
        const previewUrl = URL.createObjectURL(file);
        previews.current.set(id, previewUrl);
        return { id, file, previewUrl };
      });
      setItems((current) => [
        ...current,
        ...added.map(({ id, file, previewUrl }): ImageUploadItem => ({
          id,
          status: 'uploading',
          file,
          previewUrl,
        })),
      ]);
      for (const { id, file, previewUrl } of added) start(id, file, previewUrl);
      return problem;
    },
    [items.length, max, tooMany, start],
  );

  const retry = useCallback(
    (id: string) => {
      const item = items.find((existing) => existing.id === id);
      if (item?.status === 'error') start(id, item.file, item.previewUrl);
    },
    [items, start],
  );

  const remove = useCallback(
    (id: string) => {
      release(id);
      setItems((current) => current.filter((item) => item.id !== id));
    },
    [release],
  );

  const clear = useCallback(() => {
    for (const id of previews.current.keys()) release(id);
    setItems([]);
  }, [release]);

  /**
   * Empty again without revoking the previews of the finished uploads: the caller owns those
   * object URLs from here (the chat shows them in the optimistic bubble) and revokes them when
   * done with them.
   */
  const handOver = useCallback(() => {
    controllers.current.clear();
    previews.current.clear();
    setItems([]);
  }, []);

  useEffect(() => {
    const ids = previews.current;
    return () => {
      for (const id of ids.keys()) release(id);
    };
  }, [release]);

  return { items, add, retry, remove, clear, handOver };
}
