import { toast } from 'sonner';

/** Hands the browser a Blob to save: a temporary object URL and a click. */
function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // The download has started by now; the URL is not needed any more.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Hands the browser a file to save: the data as pretty-printed JSON. */
export function saveJsonFile(filename: string, data: unknown): void {
  saveBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

/**
 * `…/uploads/message/0192….webp` → `beso-0192….webp`. A name without an extension (the local
 * preview of a picture still on its way) gets one from the file's type.
 */
export function pictureFilename(url: string, type = ''): string {
  const last = new URL(url, window.location.href).pathname.split('/').pop() || 'picture';
  const extension =
    /\.[a-z0-9]+$/i.test(last) || !type.startsWith('image/') ? '' : `.${type.slice(6)}`;
  return `beso-${last}${extension}`;
}

/**
 * Saves a picture the app shows (a stored upload) to the device. The file is fetched first:
 * a link's `download` attribute is ignored across origins (an API on a host of its own) and
 * would open the picture instead. A failure is a toast.
 */
export async function savePicture(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Picture answered ${response.status}`);
    const blob = await response.blob();
    saveBlob(pictureFilename(url, blob.type), blob);
  } catch {
    toast.error('Could not download the picture');
  }
}

/**
 * Saves the pictures of one message, one after another in their order: a browser asks once
 * whether the page may save several files, and the names come out in the order sent.
 */
export async function savePictures(urls: readonly string[]): Promise<void> {
  for (const url of urls) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time, on purpose
    await savePicture(url);
  }
}
